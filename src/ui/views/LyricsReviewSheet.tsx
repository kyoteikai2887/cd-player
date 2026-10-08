import { memo, useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { Album, LyricLine, LyricsCandidate, LyricsDocument, LyricsEditorState, LyricsReview, Track } from '../../contracts/player.ts';
import { Icon } from '../components/Icon.tsx';
import { InlineError, useActions } from '../lib/actions.tsx';
import { formatClock } from '../lib/clock.ts';
import { useBoot } from '../lib/env.ts';
import {
  adoptPath, candidateSummary, deltaLong, deltaNotable, deltaShort, knownDocument, MAX_CANDIDATES, sameText, sharedWarnings, textDiff,
  timeline, translationCount,
} from '../lib/lyricsReview.ts';
import type { AdoptPath } from '../lib/lyricsReview.ts';
import { usePlayer, useSurface } from '../lib/surface.tsx';
import { langHint } from '../lib/text.ts';
import { useActiveLyric } from '../lib/useClock.ts';
import { Sheet } from './Sheet.tsx';
import styles from './LyricsReviewSheet.module.css';

const KIND_NAME: Record<LyricsDocument['kind'], string> = { synced: '同步歌词', plain: '纯文本歌词', missing: '暂无歌词', instrumental: '纯音乐', spoken: '念白' };
const ADOPT: Record<AdoptPath, { label: string; note: string; translated: string }> = {
  document: { label: '使用这份歌词', note: '补进这首的歌词，保留你设的偏移。之后仍可以编辑。',
    translated: '补进这首的歌词和来源附带的译文，保留你设的偏移。之后仍可以编辑。' },
  editorDraft: { label: '导入到编辑草稿', note: '只放进编辑器的草稿，核对后由你保存。',
    translated: '只放进编辑器的草稿，核对后由你保存。附带的译文一起带入；草稿里原有的译文能按时间对上的会保留。' },
  openEditor: { label: '在编辑器中导入…', note: '这首已有歌词或标记，会先打开编辑器，导入草稿后由你保存。',
    translated: '这首已有歌词或标记，会先打开编辑器，导入草稿后由你保存。附带的译文一起带入；原有的译文能按时间对上的会保留。' },
};

/**
 * Lyric candidates (Claude, R2.3; contract 0.4.0 lyricsReview). A broad search the user asked for:
 * every candidate is a preview until they choose one. The core's order and warnings are shown as
 * they are; nothing here scores a candidate or calls it verified.
 *
 * - The search terms only steer this search; they never change the track.
 * - Adopting sends three ids and a destination. No optimistic writes: the sheet closes and the
 *   lyrics change when the snapshot says so.
 * - A refused adoption (conflict, locked) keeps everything as it was and asks for a new search;
 *   the old candidates are never retried.
 */
export const LyricsReviewSheet = memo(function LyricsReviewSheet({ review, editor, lyrics, onDismiss }: {
  review: LyricsReview; editor: LyricsEditorState | null; lyrics: LyricsDocument | null; onDismiss(reviewId: string): void;
}) {
  const { index, online, currentTrack } = useSurface();
  const { run, isPending } = useActions();
  const boot = useBoot().lyricsReview;
  const track = index.tracksById.get(review.trackId);
  const album = track ? index.albumsById.get(track.albumId) : undefined;

  // Search terms: start from what the core searched; follow it until the user types.
  const [title, setTitle] = useState(boot?.query?.title ?? review.query.title);
  const [artist, setArtist] = useState(boot?.query?.artist ?? review.query.artist);
  const [typed, setTyped] = useState(!!boot?.query);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    if (typed) return;
    setTitle(review.query.title); setArtist(review.query.artist);
  }, [review.id]); // eslint-disable-line react-hooks/exhaustive-deps
  /** The terms the core chose for the first search; sending them back would narrow its own search. */
  const defaults = useRef(review.query);
  const titleRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false);

  const candidates = review.candidates.slice(0, MAX_CANDIDATES);
  const shared = sharedWarnings(candidates);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Original only, or with the translation a source sent; kept while the user moves between candidates. */
  const [bilingual, setBilingual] = useState(!!boot?.bilingual);
  const candidate = candidates.find(c => c.id === selectedId) ?? candidates[Math.min(boot?.candidateIndex ?? 0, candidates.length - 1)] ?? null;

  const [refused, setRefused] = useState<{ reviewId: string; code: 'conflict' | 'locked'; message: string } | null>(
    () => boot?.failure ? { reviewId: review.id, ...boot.failure } : null);
  const refusal = refused?.reviewId === review.id ? refused : null;

  const path = adoptPath(review.trackId, editor, lyrics, track);
  const doc = knownDocument(review.trackId, editor, lyrics);
  const editorHere = editor?.trackId === review.trackId;
  const lockedNow = !!doc?.locked;

  const close = () => {
    onDismiss(review.id);
    void run({ type: 'closeLyricsReview' }, { slot: 'lyrics', key: 'lyrics-review-close' });
  };

  const search = (terms?: { title: string; artist: string }) => {
    const q = terms ?? { title: title.trim(), artist: artist.trim() };
    if (!q.title) { setInvalid(true); titleRef.current?.focus(); return; }
    setInvalid(false); setTyped(false);
    const corePicked = sameText(q.title, defaults.current.title) && sameText(q.artist, defaults.current.artist);
    void run({ type: 'searchLyricsCandidates', trackId: review.trackId, ...(corePicked ? {} : { query: q }) },
      { slot: 'review', key: 'lyrics-search' });
  };
  const onSubmit = (event: FormEvent) => { event.preventDefault(); if (!composing.current) search(); };

  const adopt = async (destination: 'document' | 'editorDraft', candidateId: string) => {
    const result = await run({ type: 'applyLyricsCandidate', trackId: review.trackId, reviewId: review.id, candidateId, destination },
      { slot: 'review', key: 'lyrics-adopt' });
    if (!result.ok && (result.code === 'conflict' || result.code === 'locked')) setRefused({ reviewId: review.id, code: result.code, message: result.message });
  };
  // "In the editor": open it first; the adoption follows once it shows this track's draft.
  const [handoff, setHandoff] = useState<{ reviewId: string; candidateId: string } | null>(null);
  useEffect(() => {
    if (!handoff || path !== 'editorDraft') return;
    setHandoff(null);
    if (handoff.reviewId === review.id && review.candidates.some(c => c.id === handoff.candidateId)) void adopt('editorDraft', handoff.candidateId);
  }, [handoff, path]); // eslint-disable-line react-hooks/exhaustive-deps
  const openEditor = (then?: string) => {
    if (then) setHandoff({ reviewId: review.id, candidateId: then });
    void run({ type: 'openLyricsEditor', trackId: review.trackId }, { slot: 'review', key: 'lyrics-open-editor' })
      .then(result => { if (!result.ok) setHandoff(null); });
  };
  const onAdopt = () => {
    if (!candidate) return;
    if (path === 'openEditor') openEditor(candidate.id);
    else void adopt(path, candidate.id);
  };

  // Keys stay in the sheet: no editor save, no shelf search behind it.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const key = event.key.toLowerCase();
    // WebView2 may end composition before dispatching its final keydown (keyCode 229).
    if ((composing.current || event.nativeEvent.isComposing || event.keyCode === 229) && (key === 'enter' || key === 'escape')) {
      if (key === 'enter') event.preventDefault();
      event.stopPropagation(); return;
    }
    if ((event.ctrlKey || event.metaKey) && (key === 's' || key === 'f')) { event.preventDefault(); event.stopPropagation(); }
  };

  const searching = review.status === 'searching';
  const adopting = isPending('lyrics-adopt') || !!handoff;
  const canAdopt = online && review.status === 'ready' && !!candidate && !refusal && !lockedNow && !adopting;
  const footer = (
    <div className={styles.footBar}>
      <div className={styles.footNote}>
        <InlineError slot="review" />
        {review.status === 'ready' && candidate && !refusal && !lockedNow && (
          <p className={styles.adoptNote}>{translationCount(candidate.document.lines).lines ? ADOPT[path].translated : ADOPT[path].note}</p>
        )}
      </div>
      <button type="button" className="cdp-btn cdp-btn--quiet" onClick={close}>关闭</button>
      {refusal?.code === 'locked' ? (
        !editorHere && (
          <button type="button" className="cdp-btn cdp-btn--primary" disabled={!online || isPending('lyrics-open-editor')} onClick={() => openEditor()}>
            <Icon name="edit" size={16} /> 打开编辑器
          </button>
        )
      ) : refusal ? (
        <button type="button" className="cdp-btn cdp-btn--primary" disabled={!online || isPending('lyrics-search')} onClick={() => search()}>
          {isPending('lyrics-search') ? <span className="cdp-spinner" /> : <Icon name="refresh" size={16} />} 重新搜索
        </button>
      ) : review.status === 'ready' && (
        <button type="button" className="cdp-btn cdp-btn--primary" disabled={!canAdopt} onClick={onAdopt}>
          {adopting ? <span className="cdp-spinner" /> : <Icon name={path === 'document' ? 'check' : 'importFile'} size={16} />}
          {handoff ? '正在打开编辑器…' : ADOPT[path].label}
        </button>
      )}
    </div>
  );

  if (!track) return null;   // removed: the core closes the review with the snapshot
  const lang = langHint(track.title, track.language, album?.language);
  return (
    <Sheet title="歌词候选" wide="xl" raised onClose={close} closeLabel="关闭歌词候选" onKeyDown={onKeyDown} footer={footer}
      subtitle={<span className={styles.subtitle}>
        <span lang={lang}>{track.title}</span>
        <span lang={langHint(track.artistCredit, null, album?.language)}>{track.artistCredit}</span>
        <span className="num">{formatClock(track.durationMs)}</span>
      </span>}>
      <div className={styles.root}>
        <form className={styles.query} role="search" aria-label="搜索歌词候选" onSubmit={onSubmit} noValidate
          onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}>
          <label className={styles.field} data-invalid={invalid ? 'true' : 'false'}>
            <span className={styles.fieldName}>曲名</span>
            <input ref={titleRef} aria-label="曲名" value={title} maxLength={500} lang={langHint(title, null, album?.language)} aria-invalid={invalid || undefined}
              onChange={event => { setTitle(event.target.value); setTyped(true); if (event.target.value.trim()) setInvalid(false); }} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldName}>歌手</span>
            <input aria-label="歌手" value={artist} maxLength={500} placeholder="可以留空" lang={langHint(artist, null, album?.language)}
              onChange={event => { setArtist(event.target.value); setTyped(true); }} />
          </label>
          <button type="submit" className="cdp-btn cdp-btn--quiet" disabled={!online || isPending('lyrics-search')}>
            {isPending('lyrics-search') || searching ? <span className="cdp-spinner" /> : <Icon name="search" size={16} />} 搜索
          </button>
        </form>
        <p className={styles.queryHint}>{invalid ? '请填写曲名。' : '搜索词只用于这次搜索，不会改动曲目资料。'}</p>

        {refusal && (
          <div className={styles.banner} data-tone="warn" role="alert">
            <Icon name="warning" size={18} />
            <p>{refusal.code === 'locked'
              ? <>这首的歌词已锁定，没有写入。需要替换时，请在编辑器里解锁并保存，再重新搜索。</>
              : <>这些候选已经过期，或者这首的歌词、资料在搜索之后改动过。没有写入任何内容{editorHere ? '，编辑器里的草稿也没有变' : ''}。请重新搜索。</>}
            </p>
          </div>
        )}
        {!refusal && lockedNow && review.status === 'ready' && (
          <div className={styles.banner} data-tone="info">
            <Icon name="lock" size={17} />
            <p>这首的歌词已锁定，候选只能预览。需要替换时，请在编辑器里解锁并保存，再重新搜索。</p>
          </div>
        )}

        {searching && <Searching />}
        {review.status === 'failed' && (
          <Empty icon="warning" tone="warn" title="搜索没有完成"
            body={(review.error?.message ?? '歌词服务暂时无法访问。') + (review.error?.message?.includes('不代表') ? '' : ' 这不代表没有这首的歌词，稍后可以重试。')}>
            <button type="button" className="cdp-btn cdp-btn--primary" disabled={!online || isPending('lyrics-search')} onClick={() => search()}>
              <Icon name="refresh" size={16} /> 重试
            </button>
          </Empty>
        )}
        {review.status === 'noResults' && (
          <Empty icon="lyrics" title="没有找到候选"
            body="试试改成专辑里的写法，或者去掉歌手只按曲名搜索。也可以导入自己整理的 LRC 文件。">
            {review.query.artist.trim() !== '' && (
              <button type="button" className="cdp-btn cdp-btn--quiet" disabled={!online || isPending('lyrics-search')}
                onClick={() => { setArtist(''); search({ title: title.trim() || review.query.title, artist: '' }); }}>
                <Icon name="search" size={15} /> 只按曲名搜索
              </button>
            )}
          </Empty>
        )}
        {review.status === 'ready' && candidate && (
          <div className={styles.panes}>
            <CandidateList candidates={candidates} selected={candidate.id} track={track} album={album}
              total={review.candidates.length} shared={shared} onSelect={setSelectedId} />
            <Preview key={candidate.id} candidate={candidate} track={track} album={album} doc={doc}
              isCurrent={currentTrack?.id === track.id} hidden={shared} bilingual={bilingual} onBilingual={setBilingual} />
          </div>
        )}
      </div>
    </Sheet>
  );
});   // memo: position samples re-render the surface, not this sheet (its inputs are shared structurally)

function Searching() {
  return (
    <div className={styles.searching} role="status">
      <p className={styles.searchingText}><span className="cdp-spinner" /> 正在搜索歌词候选…</p>
      <div className={styles.skeleton} aria-hidden="true">
        {[0, 1, 2].map(i => <span key={i} className={styles.skeletonRow}><i className="cdp-skeleton" /><i className="cdp-skeleton" /><i className="cdp-skeleton" /></span>)}
      </div>
    </div>
  );
}

function Empty({ icon, tone, title, body, children }: { icon: 'warning' | 'lyrics'; tone?: 'warn'; title: string; body: ReactNode; children?: ReactNode }) {
  return (
    <div className={styles.empty} data-tone={tone}>
      <span className={styles.emptyIcon}><Icon name={icon} size={24} /></span>
      <p className={styles.emptyTitle}>{title}</p>
      <p className={styles.emptyBody}>{body}</p>
      {children && <div className={styles.emptyActions}>{children}</div>}
    </div>
  );
}

/** The candidates as a radio group: arrows move the choice, the preview follows. */
function CandidateList({ candidates, selected, track, album, total, shared, onSelect }: {
  candidates: LyricsCandidate[]; selected: string; track: Track; album?: Album; total: number; shared: string[]; onSelect(id: string): void;
}) {
  const list = useRef<HTMLDivElement>(null);
  // The chosen candidate is in view when the list appears (a later choice is focused, which scrolls).
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Arrow keys move the choice and the focus together (roving tabindex), once the choice is drawn.
  const follow = useRef(false);
  useEffect(() => {
    if (!follow.current) return;
    follow.current = false;
    list.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, [selected]);
  const move = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const at = candidates.findIndex(c => c.id === selected);
    const next = { ArrowDown: at + 1, ArrowRight: at + 1, ArrowUp: at - 1, ArrowLeft: at - 1, Home: 0, End: candidates.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault(); event.stopPropagation();
    const target = candidates[Math.max(0, Math.min(candidates.length - 1, next))];
    if (target.id === selected) return;
    follow.current = true;
    onSelect(target.id);
  };
  return (
    <div className={styles.listPane}>
      <p className={styles.count}>
        {candidates.length} 份候选{total > candidates.length ? `（只显示前 ${candidates.length} 份）` : ''}
        <span className={styles.countHint}>按曲名、版本和时长排列，都需要你核对</span>
      </p>
      {shared.length > 0 && (
        <ul className={styles.shared} aria-label="每份候选都有的提示">
          {shared.map(w => <li key={w}><Icon name="info" size={14} />{w}</li>)}
        </ul>
      )}
      <div ref={list} className={styles.list} role="radiogroup" aria-label="歌词候选" onKeyDown={move}>
        {candidates.map(c => (
          <CandidateRow key={c.id} candidate={c} checked={c.id === selected} track={track} album={album} onSelect={() => onSelect(c.id)} />
        ))}
      </div>
    </div>
  );
}

function CandidateRow({ candidate: c, checked, track, album, onSelect }: {
  candidate: LyricsCandidate; checked: boolean; track: Track; album?: Album; onSelect(): void;
}) {
  const title = textDiff(track.title, c.title);
  const creditDiffers = !sameText(track.artistCredit, c.artistCredit);
  const otherAlbum = !album || !sameText(album.title, c.albumTitle);
  return (
    <button type="button" role="radio" aria-checked={checked} tabIndex={checked ? 0 : -1} data-candidate={c.id}
      className={styles.row} data-match={c.match} aria-label={candidateSummary(c)} onClick={onSelect}>
      <span className={styles.rowTop}>
        <span className={styles.kind} data-kind={c.document.kind}>
          <Icon name={c.document.kind === 'synced' ? 'stopwatch' : 'lyrics'} size={13} />{c.document.kind === 'synced' ? '同步' : '纯文本'}
        </span>
        {translationCount(c.document.lines).lines > 0 && <span className={styles.kind} data-kind="translation"><Icon name="translate" size={13} />带译文</span>}
        {c.match === 'close'
          ? <span className={styles.match} data-match="close" title="曲名和版本标记相同，时长相差不超过 2 秒。时间轴和演唱版本仍需你核对。">时长接近</span>
          : <span className={styles.match} data-match="check" title="曲名、版本或时长与本曲不一致，请先预览。">请核对</span>}
        <span className={styles.provider}>{c.provider}</span>
      </span>
      <span className={styles.rowTitle} lang={langHint(c.title)}><Marked diff={title} /></span>
      <span className={styles.rowLine}>
        <span className={styles.ellipsis} lang={langHint(c.artistCredit)} title={c.artistCredit}>{c.artistCredit || '（没有署名）'}</span>
        {creditDiffers && <span className={styles.diffTag}>署名不同</span>}
      </span>
      <span className={styles.rowLine}>
        <span className={styles.ellipsis} lang={langHint(c.albumTitle)} title={c.albumTitle}>{c.albumTitle || '（没有专辑名）'}</span>
        {otherAlbum && <span className={styles.diffTag}>其他专辑</span>}
        <span className={`${styles.duration} num`} data-notable={deltaNotable(c.durationDeltaMs) ? 'true' : 'false'}>
          {c.durationMs === null ? '时长未知' : <>{formatClock(c.durationMs)}<span className={styles.delta}>{deltaShort(c.durationDeltaMs)}</span></>}
        </span>
      </span>
    </button>
  );
}

/** The candidate's own text, with the part the track's text does not have marked. */
function Marked({ diff }: { diff: ReturnType<typeof textDiff> }) {
  if (diff.same || !diff.extra) return <>{diff.before}{diff.extra}{diff.after}</>;
  return <>{diff.before}<mark className={styles.mark}>{diff.extra}</mark>{diff.after}</>;
}

function Preview({ candidate: c, track, album, doc, isCurrent, hidden, bilingual, onBilingual }: {
  candidate: LyricsCandidate; track: Track; album?: Album; doc: LyricsDocument | null; isCurrent: boolean;
  /** Notes already shown once above the list. */
  hidden: string[];
  bilingual: boolean; onBilingual(on: boolean): void;
}) {
  const { online } = useSurface();
  const { run } = useActions();
  const id = useId();
  const synced = c.document.kind === 'synced';
  const offset = doc?.offsetMs ?? 0;
  const [follow, setFollow] = useState(true);
  const lines = c.document.lines;
  const words = lines.filter(l => l.original.trim()).length;
  const title = textDiff(track.title, c.title);
  const tl = synced ? timeline(lines, offset, track.durationMs, c.durationMs) : null;
  const current = doc ? KIND_NAME[doc.kind] : track.lyricsSummary ? KIND_NAME[track.lyricsSummary.kind] : null;
  const lang = langHint(lines.find(l => l.original.trim())?.original, c.document.language, album?.language);
  const tr = translationCount(lines);
  const trLang = langHint(lines.find(l => l.translation?.trim())?.translation, c.document.translationLanguage);
  const both = bilingual && tr.lines > 0;
  const notes = c.warnings.filter(w => !hidden.includes(w));
  return (
    <section className={styles.preview} aria-labelledby={id}>
      <h3 id={id} className="sr-only">预览：{c.title}</h3>
      <table className={styles.compare}>
        <thead>
          <tr>
            <th scope="col"><span className="sr-only">项目</span></th>
            <th scope="col">候选<span className={styles.headNote}>{synced ? '同步' : '纯文本'} · <span className="num">{words}</span> 行
              {tr.lines > 0 && <> · 译文 <span className="num">{tr.lines}</span> 行</>}</span></th>
            <th scope="col">本曲{current && <span className={styles.headNote}>{current}{doc?.locked ? ' · 已锁定' : ''}</span>}</th>
          </tr>
        </thead>
        <tbody>
          <CompareRow label="曲名" differs={!title.same} candidate={<span lang={langHint(c.title)} title={c.title}><Marked diff={title} /></span>}
            local={<span lang={langHint(track.title, track.language, album?.language)} title={track.title}>{track.title}</span>} />
          <CompareRow label="署名" differs={!sameText(track.artistCredit, c.artistCredit)} candidate={<span lang={langHint(c.artistCredit)} title={c.artistCredit}>{c.artistCredit || '来源未提供'}</span>}
            local={<span lang={langHint(track.artistCredit, null, album?.language)} title={track.artistCredit}>{track.artistCredit}</span>} />
          <CompareRow label="专辑" differs={!album || !sameText(album.title, c.albumTitle)} candidate={<span lang={langHint(c.albumTitle)} title={c.albumTitle}>{c.albumTitle || '来源未提供'}</span>}
            local={<span lang={langHint(album?.title, null, album?.language)} title={album?.title}>{album?.title ?? '—'}</span>} />
          <CompareRow label="时长" differs={deltaNotable(c.durationDeltaMs)}
            candidate={<><span className="num">{c.durationMs === null ? '未知' : formatClock(c.durationMs)}</span><span className={styles.cellNote}>{deltaLong(c.durationDeltaMs)}</span></>}
            local={<span className="num">{formatClock(track.durationMs)}</span>} />
        </tbody>
      </table>

      {notes.length > 0 && (
        <ul className={styles.warnings} aria-label="来源提示">
          {notes.map((w, i) => <li key={i}><Icon name="info" size={14} />{w}</li>)}
        </ul>
      )}

      <div className={styles.linesCard}>
        <div className={styles.linesHead}>
          <span className={styles.linesTitle}>歌词预览<span className={styles.linesSource}>{c.provider}</span></span>
          {tr.lines > 0 && (
            <div className={`cdp-seg ${styles.lang}`} role="group" aria-label="候选的显示方式"
              title={`来源附带 ${tr.lines} 行译文，已按时间对应到原文。是否准确仍需你核对。`}>
              <button type="button" aria-pressed={!both} onClick={() => onBilingual(false)}>原文</button>
              <button type="button" aria-pressed={both} onClick={() => onBilingual(true)}>双语</button>
            </div>
          )}
          {synced && isCurrent && (
            <button type="button" className={`cdp-chip ${styles.follow}`} aria-pressed={follow} onClick={() => setFollow(v => !v)}
              title="按正在播放的位置高亮这份候选，不会替换正在显示的歌词">
              <Icon name="lyrics" size={14} /> 跟随播放
            </button>
          )}
          {synced && !isCurrent && (
            <button type="button" className="cdp-btn cdp-btn--text" disabled={!online || !track.available || !album}
              onClick={() => album && run({ type: 'playAlbum', albumId: album.id, startTrackId: track.id }, { slot: 'review', key: 'review-play' })}>
              <Icon name="play" size={14} /> 播放这首对照
            </button>
          )}
          {!synced && <span className={styles.linesNote}>没有时间，不会跟随播放</span>}
        </div>
        {tl && <TimelineStrip tl={tl} />}
        {synced && isCurrent && follow
          ? <FollowingLines lines={lines} offset={offset} lang={lang} trLang={both ? trLang : null} />
          : <StillLines lines={lines} offset={offset} synced={synced} lang={lang} trLang={both ? trLang : null} />}
      </div>
    </section>
  );
}

function CompareRow({ label, differs, candidate, local }: { label: string; differs: boolean; candidate: ReactNode; local: ReactNode }) {
  return (
    <tr data-differs={differs ? 'true' : 'false'}>
      <th scope="row">{label}</th>
      <td>{differs && <Icon name="warning" size={13} className={styles.diffIcon} />}{candidate}{differs && <span className="sr-only">（与本曲不同）</span>}</td>
      <td>{local}</td>
    </tr>
  );
}

/** Where the candidate's lines fall against the track's length (a TV Size shows at a glance). */
function TimelineStrip({ tl }: { tl: ReturnType<typeof timeline> }) {
  const pct = (ms: number) => `${Math.min(100, (ms / tl.span) * 100)}%`;
  return (
    <figure className={styles.timeline}>
      <div className={styles.tlRow} aria-hidden="true">
        <span className={styles.tlLabel}>本曲</span>
        <span className={styles.tlTrack}><i className={styles.tlBar} style={{ width: pct(tl.trackMs) }} /></span>
        <span className={`${styles.tlTime} num`}>{formatClock(tl.trackMs)}</span>
      </div>
      <div className={styles.tlRow} aria-hidden="true">
        <span className={styles.tlLabel}>候选</span>
        <span className={styles.tlTrack}>
          {tl.candidateMs !== null && <i className={styles.tlBar} data-candidate="true" style={{ width: pct(tl.candidateMs) }} />}
          {tl.ticks.map((t, i) => <b key={i} className={styles.tlTick} style={{ left: `${t * 100}%` }} />)}
        </span>
        <span className={`${styles.tlTime} num`}>{tl.candidateMs === null ? '—' : formatClock(tl.candidateMs)}</span>
      </div>
      <figcaption className={styles.tlCaption}>
        {tl.lastMs === null ? '这份候选没有带时间的句子。'
          : <>最后一句在 <span className="num">{formatClock(tl.lastMs)}</span>，本曲长 <span className="num">{formatClock(tl.trackMs)}</span>。</>}
      </figcaption>
    </figure>
  );
}

function LineItem({ line, index, offset, synced, state, lang, trLang }: {
  line: LyricLine; index: number; offset: number; synced: boolean; state?: 'active' | 'past' | 'future'; lang?: string;
  /** Show the source's translation under the original (null: original only). */
  trLang: string | undefined | null;
}) {
  if (!line.original.trim()) return <li className={styles.break} data-index={index} aria-hidden="true" />;
  return (
    <li className={styles.line} data-index={index} data-state={state} aria-current={state === 'active' ? 'true' : undefined}>
      {synced && <span className={`${styles.time} num`}>{line.startMs === null ? '—' : formatClock(Math.max(0, line.startMs + offset))}</span>}
      <span className={styles.text} lang={lang}>{line.original}</span>
      {trLang !== null && line.translation?.trim() && <span className={styles.translation} lang={trLang}>{line.translation}</span>}
    </li>
  );
}

const StillLines = memo(function StillLines({ lines, offset, synced, lang, trLang }: {
  lines: LyricLine[]; offset: number; synced: boolean; lang?: string; trLang: string | undefined | null;
}) {
  return (
    <div className={styles.linesScroll} tabIndex={0} role="region" aria-label="候选歌词">
      <ol className={styles.lines} data-synced={synced ? 'true' : 'false'}>
        {lines.map((line, i) => <LineItem key={line.id} line={line} index={i} offset={offset} synced={synced} lang={lang} trLang={trLang} />)}
      </ol>
    </div>
  );
});

/**
 * The candidate against the track that is playing: the same shared clock and lyric index as the
 * lyrics page (useActiveLyric → activeLyricIndex / nextLyricBoundary on renderPosition). It only
 * highlights here; the lyrics on screen and the user's offset stay as they are.
 */
const FollowingLines = memo(function FollowingLines({ lines, offset, lang, trLang }: {
  lines: LyricLine[]; offset: number; lang?: string; trLang: string | undefined | null;
}) {
  const player = usePlayer();
  const { visible, reduced } = useSurface();
  const active = useActiveLyric(lines, offset, player, visible, null);
  const box = useRef<HTMLDivElement>(null);
  const [heldUntil, setHeldUntil] = useState(0);
  useEffect(() => {
    if (active < 0 || Date.now() < heldUntil) return;
    const el = box.current, row = el?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (!el || !row) return;
    const top = Math.max(0, row.offsetTop - el.clientHeight * 0.35);
    if (typeof el.scrollTo === 'function') el.scrollTo({ top, behavior: reduced ? 'auto' : 'smooth' }); else el.scrollTop = top;
  }, [active, reduced, heldUntil]);
  const hold = () => setHeldUntil(Date.now() + 4000);
  return (
    <div ref={box} className={styles.linesScroll} tabIndex={0} role="region" aria-label="候选歌词（跟随播放）" data-following="true"
      onWheel={hold} onTouchStart={hold}
      onKeyDown={event => { if (['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) hold(); }}>
      <ol className={styles.lines} data-synced="true">
        {lines.map((line, i) => <LineItem key={line.id} line={line} index={i} offset={offset} synced
          state={i === active ? 'active' : active >= 0 && i < active ? 'past' : 'future'} lang={lang} trLang={trLang} />)}
      </ol>
    </div>
  );
});
