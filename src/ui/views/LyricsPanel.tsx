import { memo, useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { LyricLine, LyricsDocument, LyricsSource, UISnapshot } from '../../contracts/player.ts';
import { Icon } from '../components/Icon.tsx';
import { Menu } from '../components/Menu.tsx';
import type { MenuItem } from '../components/Menu.tsx';
import { InlineError, useActions } from '../lib/actions.tsx';
import { formatOffset } from '../lib/clock.ts';
import { usePlayer, useSurface } from '../lib/surface.tsx';
import { useActiveLyric } from '../lib/useClock.ts';
import { renderPosition } from '../lib/clock.ts';
import { nextLyricBoundary } from '../../core/lyrics.ts';
import { langHint } from '../lib/text.ts';
import { showMemorialPlates } from '../lib/memorial.ts';
import styles from './LyricsPanel.module.css';

const FOLLOW_PAUSE_MS = 4000;
const OFFSET_STEP = 100;
const OFFSET_COMMIT_DELAY = 400;

function sourceLabel(source: LyricsSource | undefined): string | null {
  if (!source) return null;
  if (source.name) return source.name;
  return { manual: '手动整理', embedded: '音频内嵌', sidecar: '同名 LRC 文件', provider: '在线歌词源', demo: '演示数据' }[source.kind];
}

/**
 * Lyrics for the current track. Highlighting follows the shared display clock
 * (useActiveLyric → core activeLyricIndex / nextLyricBoundary). No interval polling.
 */
export function LyricsPanel({ snapshot, preview }: { snapshot: UISnapshot; preview: number | null }) {
  const { currentTrack, currentAlbum, settings, online } = useSurface();
  const { run } = useActions();
  const lyrics = snapshot.lyrics;
  const mode = settings.lyricsMode;
  const trackId = currentTrack?.id ?? '';
  const [draft, setDraft] = useState(() => createOffsetDraft(trackId));
  if (draft.trackId !== trackId) setDraft(createOffsetDraft(trackId));

  if (!currentTrack) return <Quiet icon="disc" title="还没有在播放" body="选一张专辑，歌词会在这里出现。" />;
  // A document for a different track (gapless switch in flight) counts as loading.
  if (!lyrics || lyrics.trackId !== currentTrack.id) return <LoadingLines />;

  const editorOpen = snapshot.lyricsEditor?.trackId === currentTrack.id;
  const task = snapshot.tasks.find(t => t.kind === 'lyrics' && t.trackId === currentTrack.id);
  const hasText = lyrics.kind === 'synced' || lyrics.kind === 'plain';
  const lang = langHint(lyrics.lines[0]?.original, lyrics.language, currentAlbum?.language);
  const trLang = lyrics.translationLanguage ?? undefined;

  const send = (action: Parameters<typeof run>[0], key?: string) => void run(action, { slot: 'lyrics', key });

  let note: ReactNode = null;
  if (lyrics.lookup === 'searching' && hasText) note = <span className={styles.note}><span className="cdp-spinner" /> 正在查找缺失的译文…</span>;
  else if (lyrics.lookup === 'failed' && hasText) note = <span className={styles.note} data-tone="warn"><Icon name="warning" size={15} /> 查找没有完成</span>;
  else if (hasText && mode === 'bilingual' && lyrics.translationStatus === 'missing') note = <span className={styles.note}>暂无中文翻译，先显示原文</span>;
  else if (hasText && mode === 'bilingual' && lyrics.translationStatus === 'partial') note = <span className={styles.note}>部分句子有翻译</span>;

  return (
    <div className={styles.panel}>
      {(note || lyrics.warnings.length > 0) && (
        <div className={styles.toolbar}>
          <div className={styles.notes}>
            {note}
            {lyrics.warnings.length > 0 && <Warnings warnings={lyrics.warnings} />}
          </div>
        </div>
      )}

      <div className={styles.body}>
        {lyrics.kind === 'synced' && (
          <SyncedLyrics key={lyrics.trackId} lyrics={lyrics} mode={mode} lang={lang} trLang={trLang} preview={preview} editorOpen={editorOpen} draft={draft} />
        )}
        {lyrics.kind === 'plain' && <PlainLyrics lines={lyrics.lines} mode={mode} lang={lang} trLang={trLang}
          onTime={() => send({ type: 'openLyricsEditor', trackId: currentTrack.id })} />}
        {/* V1.1: with the plate, the title says it all; the plain icon keeps its sentence. */}
        {lyrics.kind === 'instrumental' && (showMemorialPlates(settings)
          ? <Quiet icon="note" title="纯音乐" plate />
          : <Quiet icon="note" title="纯音乐" body="这首被标记为纯音乐，没有歌词。" />)}
        {lyrics.kind === 'spoken' && <Quiet icon="mic" title="念白" body="这首被标记为念白，比如广播剧或 Talk，没有歌词。" />}
        {lyrics.kind === 'missing' && (
          <Missing lyrics={lyrics} taskId={task?.id ?? null}
            onLookup={() => send({ type: 'lookupLyrics', trackId: currentTrack.id }, 'lookupLyrics')}
            onSearch={() => send({ type: 'searchLyricsCandidates', trackId: currentTrack.id }, 'searchLyricsCandidates')}
            onImport={() => send({ type: 'importLyrics', trackId: currentTrack.id, content: 'original' }, 'importLyrics')}
            onEdit={() => send({ type: 'openLyricsEditor', trackId: currentTrack.id })}
            onInstrumental={() => send({ type: 'setNoLyrics', trackId: currentTrack.id, baseRevision: lyrics.revision, kind: 'instrumental' })} />
        )}
      </div>

      <InlineError slot="lyrics" className={styles.error} />
      {hasText && (
        <Footer lyrics={lyrics} editorOpen={editorOpen} draft={draft} />
      )}
    </div>
  );
}

/** Display mode and lyric actions; rendered in the now-playing tab row. */
export function LyricsTools({ snapshot }: { snapshot: UISnapshot }) {
  const { currentTrack, settings, online } = useSurface();
  const { run } = useActions();
  const lyrics = snapshot.lyrics;
  if (!currentTrack || !lyrics || lyrics.trackId !== currentTrack.id) return null;
  const mode = settings.lyricsMode;
  const hasText = lyrics.kind === 'synced' || lyrics.kind === 'plain';
  const send = (action: Parameters<typeof run>[0], key?: string) => void run(action, { slot: 'lyrics', key });
  const menuItems: MenuItem[] = [
    { label: '导入歌词文件…', icon: 'importFile', disabled: !online,
      onSelect: () => send({ type: 'importLyrics', trackId: currentTrack.id, content: 'original' }) },
    { label: '导入中文译文…', icon: 'translate', disabled: !online || !hasText,
      onSelect: () => send({ type: 'importLyrics', trackId: currentTrack.id, content: 'translation' }) },
    { label: lyrics.locked ? '查找歌词（已锁定）' : '查找缺失的歌词或译文', icon: 'search', disabled: !online || lyrics.locked,
      hint: lyrics.locked ? '锁定的歌词不会被自动替换；需要替换请用编辑或导入。' : undefined,
      onSelect: () => send({ type: 'lookupLyrics', trackId: currentTrack.id }, 'lookupLyrics') },
    { label: '搜索歌词候选…', icon: 'lyrics', disabled: !online || lyrics.locked,
      hint: lyrics.locked ? '歌词已锁定：需要替换时，请在编辑器里解锁并保存。' : '列出不同版本的歌词，预览后由你选择',
      onSelect: () => send({ type: 'searchLyricsCandidates', trackId: currentTrack.id }, 'searchLyricsCandidates') },
    { label: '编辑歌词', icon: 'edit', disabled: !online,
      onSelect: () => send({ type: 'openLyricsEditor', trackId: currentTrack.id }) },
    { kind: 'separator' },
    ...(lyrics.kind === 'instrumental' || lyrics.kind === 'spoken'
      ? [{ label: '取消“无歌词”标记', icon: 'refresh' as const, disabled: !online,
        onSelect: () => send({ type: 'setNoLyrics', trackId: currentTrack.id, baseRevision: lyrics.revision, kind: null }) }]
      : [
        { label: '标记为纯音乐', icon: 'note' as const, disabled: !online,
          onSelect: () => send({ type: 'setNoLyrics', trackId: currentTrack.id, baseRevision: lyrics.revision, kind: 'instrumental' }) },
        { label: '标记为念白', icon: 'mic' as const, disabled: !online,
          onSelect: () => send({ type: 'setNoLyrics', trackId: currentTrack.id, baseRevision: lyrics.revision, kind: 'spoken' }) },
      ]),
  ];

  return (
    <div className={styles.tools}>
      {hasText && (
        <div className="cdp-seg" role="group" aria-label="歌词显示">
          <button type="button" aria-pressed={mode === 'original'}
            onClick={() => run({ type: 'updateSettings', patch: { lyricsMode: 'original' } }, { slot: 'lyrics' })}>原文</button>
          <button type="button" aria-pressed={mode === 'bilingual'}
            onClick={() => run({ type: 'updateSettings', patch: { lyricsMode: 'bilingual' } }, { slot: 'lyrics' })}>双语</button>
        </div>
      )}
      <Menu label="歌词操作" items={menuItems} />
    </div>
  );
}

function Footer({ lyrics, editorOpen, draft }: { lyrics: LyricsDocument; editorOpen: boolean; draft: OffsetDraft }) {
  const original = sourceLabel(lyrics.source.original);
  const translation = sourceLabel(lyrics.source.translation);
  return (
    <div className={styles.footer}>
      <span className={styles.source}>
        {original && <>原文：{original}</>}
        {translation && translation !== original && <span className={styles.sourceGap}>译文：{translation}</span>}
        {lyrics.locked && <span className={styles.locked} title="已锁定：自动查找不会替换这份歌词"><Icon name="lock" size={13} /> 已锁定</span>}
      </span>
      {lyrics.kind === 'synced' && <OffsetControl lyrics={lyrics} disabled={editorOpen} draft={draft} />}
    </div>
  );
}

/**
 * Quick offset: previewed locally at once, committed ~400 ms after the last click,
 * serialized so a second commit always uses the latest revision. Disabled while this
 * track's editor is open (the editor owns the draft then).
 */
function OffsetControl({ lyrics, disabled, draft }: { lyrics: LyricsDocument; disabled: boolean; draft: OffsetDraft }) {
  const { run } = useActions();
  const { online } = useSurface();
  const draftValue = useOffsetDraft(draft);
  const latest = useRef(lyrics);
  latest.current = lyrics;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef<Promise<unknown> | null>(null);
  const value = draftValue ?? lyrics.offsetMs;

  const commit = useCallback(async () => {
    if (inflight.current) await inflight.current;
    const target = draft.read();
    if (target === null || target === latest.current.offsetMs) { draft.set(null); return; }
    const request = run({ type: 'setLyricsOffset', trackId: latest.current.trackId, baseRevision: latest.current.revision, offsetMs: target },
      { slot: 'lyrics', key: 'offset' });
    inflight.current = request;
    const result = await request;
    inflight.current = null;
    if (!result.ok || draft.read() === target) draft.set(null);
  }, [run, draft]);

  const nudge = (delta: number) => {
    draft.set(Math.max(-60000, Math.min(60000, value + delta)));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void commit(), OFFSET_COMMIT_DELAY);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const title = disabled ? '歌词编辑器已打开，请在编辑器里调整偏移' : '正值让歌词更晚出现，负值更早';
  return (
    <span className={styles.offset} title={title}>
      <Icon name="timer" size={14} />
      <button type="button" className="cdp-icon-btn cdp-icon-btn--sm" aria-label="歌词提前 0.1 秒" title="提前 0.1 秒" disabled={disabled || !online}
        onClick={() => nudge(-OFFSET_STEP)}>−</button>
      <span className={`${styles.offsetValue} num`} aria-live="polite" aria-label={`歌词偏移 ${formatOffset(value)}`}>{formatOffset(value)}</span>
      <button type="button" className="cdp-icon-btn cdp-icon-btn--sm" aria-label="歌词延后 0.1 秒" title="延后 0.1 秒" disabled={disabled || !online}
        onClick={() => nudge(OFFSET_STEP)}>+</button>
    </span>
  );
}

/** Offset draft for one track, shared by the control and the synced list so the preview is immediate. */
export interface OffsetDraft { trackId: string; read(): number | null; set(value: number | null): void; subscribe(listener: () => void): () => void }
function createOffsetDraft(trackId: string): OffsetDraft {
  let value: number | null = null;
  const listeners = new Set<() => void>();
  return {
    trackId,
    read: () => value,
    set(next) { value = next; listeners.forEach(listener => listener()); },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
function useOffsetDraft(store: OffsetDraft) {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => store.subscribe(force), [store]);
  return store.read();
}

const SyncedLyrics = memo(function SyncedLyrics({ lyrics, mode, lang, trLang, preview, editorOpen, draft }: {
  lyrics: LyricsDocument; mode: 'original' | 'bilingual'; lang?: string; trLang?: string; preview: number | null;
  editorOpen: boolean; draft: OffsetDraft;
}) {
  const player = usePlayer();
  const { visible, reduced, online } = useSurface();
  const { run } = useActions();
  const draftValue = useOffsetDraft(draft);
  const offset = editorOpen ? lyrics.offsetMs : draftValue ?? lyrics.offsetMs;
  const [pinned, setPinned] = useState<number | null>(null);
  const active = useActiveLyric(lyrics.lines, offset, player, visible, preview);
  const shown = pinned ?? active;
  const scroller = useRef<HTMLDivElement>(null);
  const [pausedUntil, setPausedUntil] = useState(0);
  // Scroll anchor: the active line, or during a break / intro the boundary we are inside
  // (derived from the shared nextLyricBoundary; highlighting itself stays with activeLyricIndex).
  const anchor = shown >= 0 ? shown : boundaryIndex(lyrics.lines, preview ?? renderPosition(player, performance.now()), offset);

  const follow = useCallback((instant: boolean) => {
    const box = scroller.current;
    if (!box) return;
    const item = anchor >= 0 ? box.querySelector<HTMLElement>(`[data-index="${anchor}"]`) : null;
    const top = item ? item.offsetTop + item.offsetHeight / 2 - box.clientHeight * 0.38 : 0;
    if (typeof box.scrollTo === 'function') box.scrollTo({ top: Math.max(0, top), behavior: instant || reduced ? 'auto' : 'smooth' });
    else box.scrollTop = Math.max(0, top);
  }, [anchor, reduced]);
  useEffect(() => {
    if (Date.now() < pausedUntil) return;
    follow(false);
  }, [anchor, mode, follow, pausedUntil]);
  useEffect(() => {
    if (!pausedUntil) return;
    const timer = setTimeout(() => setPausedUntil(0), Math.max(0, pausedUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [pausedUntil]);
  useEffect(() => { follow(true); }, [lyrics.trackId]); // eslint-disable-line react-hooks/exhaustive-deps

  const userScrolled = () => setPausedUntil(Date.now() + FOLLOW_PAUSE_MS);
  const seekTo = async (line: LyricLine, index: number) => {
    if (line.startMs === null) return;
    const target = Math.min(player.durationMs, Math.max(0, line.startMs + offset));
    setPinned(index);
    setPausedUntil(0);
    const hold = setTimeout(() => setPinned(null), 300);
    await run({ type: 'seek', positionMs: target }, { slot: 'lyrics', key: 'lyric-seek' });
    clearTimeout(hold);
    setTimeout(() => setPinned(null), 300);
  };
  const bilingual = mode === 'bilingual';

  return (
    <>
      <div ref={scroller} className={styles.scroller} data-follow={pausedUntil ? 'paused' : 'on'}
        onWheel={userScrolled} onTouchStart={userScrolled}
        onKeyDown={event => { if (['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) userScrolled(); }}
        onPointerDown={event => { if (event.target === scroller.current) userScrolled(); }}>
        <ol className={styles.lines} data-mode={mode}>
          {lyrics.lines.map((line, index) => {
            if (!line.original.trim()) return <li key={line.id} className={styles.break} data-index={index} aria-hidden="true" />;
            const state = index === shown ? 'active' : index < (shown >= 0 ? shown : anchor + 1) ? 'past' : 'future';
            return (
              <li key={line.id} data-index={index} data-state={state} className={styles.line}
                aria-current={index === shown ? 'true' : undefined}>
                <button type="button" className={styles.lineButton} disabled={!online}
                  aria-label={`跳到这句：${line.original.split('\n')[0]}`}
                  onClick={() => void seekTo(line, index)}>
                  <span className={styles.original} lang={lang}>{line.original}</span>
                  {bilingual && line.translation && <span className={styles.translation} lang={trLang}>{line.translation}</span>}
                </button>
              </li>
            );
          })}
        </ol>
      </div>
      {pausedUntil > 0 && (
        <button type="button" className={`cdp-chip glass-flat ${styles.resume}`} onClick={() => { setPausedUntil(0); follow(false); }}>
          <Icon name="lyrics" size={15} /> 回到当前歌词
        </button>
      )}
    </>
  );
});

/** Index of the timed line whose boundary the position is currently in (−1 before the first line). */
function boundaryIndex(lines: readonly LyricLine[], position: number, offset: number): number {
  const next = nextLyricBoundary(lines, position, offset);
  if (next === null) {
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].startMs !== null) return lines[i].startMs! + offset <= position ? i : -1;
    return -1;
  }
  const at = lines.findIndex(line => line.startMs !== null && line.startMs + offset === next);
  return at - 1;
}

function PlainLyrics({ lines, mode, lang, trLang, onTime }: {
  lines: LyricLine[]; mode: 'original' | 'bilingual'; lang?: string; trLang?: string; onTime(): void;
}) {
  return (
    <div className={styles.scroller} data-plain="true">
      <div className={styles.plainHead}>
        <span className="cdp-chip"><Icon name="lyrics" size={14} /> 未同步的歌词，不会跟随播放</span>
        <button type="button" className="cdp-btn cdp-btn--text" onClick={onTime}>开始打轴</button>
      </div>
      <ol className={`${styles.lines} ${styles.plainLines}`}>
        {lines.map(line => !line.original.trim() ? <li key={line.id} className={styles.break} aria-hidden="true" /> : (
          <li key={line.id} className={styles.plainLine}>
            <span className={styles.original} lang={lang}>{line.original}</span>
            {mode === 'bilingual' && line.translation && <span className={styles.translation} lang={trLang}>{line.translation}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Missing({ lyrics, taskId, onLookup, onSearch, onImport, onEdit, onInstrumental }: {
  lyrics: LyricsDocument; taskId: string | null; onLookup(): void; onSearch(): void; onImport(): void; onEdit(): void; onInstrumental(): void;
}) {
  const { run, isPending } = useActions();
  const { online } = useSurface();
  if (lyrics.lookup === 'searching') {
    return (
      <div className={styles.quiet} role="status">
        <span className={`cdp-spinner ${styles.bigSpinner}`} />
        <p className={styles.quietTitle}>正在查找歌词…</p>
        <p className={styles.quietBody}>只会补上缺失的部分，不会改动你整理过的内容。</p>
        {taskId && <button type="button" className="cdp-btn cdp-btn--quiet"
          onClick={() => run({ type: 'cancelTask', taskId }, { slot: 'lyrics' })}>取消查找</button>}
      </div>
    );
  }
  const failed = lyrics.lookup === 'failed';
  const notFound = lyrics.lookup === 'notFound';
  return (
    <div className={styles.quiet}>
      <span className={styles.quietIcon}><Icon name={failed ? 'warning' : 'lyrics'} size={26} /></span>
      <p className={styles.quietTitle}>{failed ? '歌词查找没有完成' : notFound ? '没有找到匹配的歌词' : '暂无歌词'}</p>
      <p className={styles.quietBody}>
        {failed ? (lyrics.lookupError?.message ?? '歌词服务暂时无法访问。') + ' 稍后可以重试。'
          : notFound ? '自动查找只接受曲名、署名和时长都一致的歌词。可以搜索其他版本，预览后自己挑一份。'
            : '可以先在线查找，也可以导入自己整理的 LRC 文件。'}
      </p>
      <div className={styles.quietActions}>
        {!notFound && (
          <button type="button" className="cdp-btn cdp-btn--primary" disabled={!online || lyrics.locked} onClick={onLookup}>
            {isPending('lookupLyrics') ? <span className="cdp-spinner" /> : <Icon name={failed ? 'refresh' : 'search'} size={17} />}
            {failed ? '重试' : '查找歌词'}
          </button>
        )}
        {notFound && (
          <button type="button" className="cdp-btn cdp-btn--primary" disabled={!online || lyrics.locked} onClick={onSearch}
            title={lyrics.locked ? '歌词已锁定：需要替换时，请在编辑器里解锁并保存。' : '列出不同版本的歌词，预览后由你选择'}>
            {isPending('searchLyricsCandidates') ? <span className="cdp-spinner" /> : <Icon name="search" size={17} />} 搜索其他版本
          </button>
        )}
        <button type="button" className="cdp-btn cdp-btn--quiet" disabled={!online} onClick={onImport}>
          <Icon name="importFile" size={17} /> 导入歌词
        </button>
        <button type="button" className="cdp-btn cdp-btn--quiet" disabled={!online} onClick={onEdit}><Icon name="edit" size={16} /> 手动输入</button>
      </div>
      <button type="button" className="cdp-btn cdp-btn--text" disabled={!online} onClick={onInstrumental}>这首是纯音乐</button>
    </div>
  );
}

/** plate: the memorial equipment plate takes the icon's place (instrumental tracks only). */
function Quiet({ icon, title, body, plate = false }: { icon: 'note' | 'mic' | 'disc'; title: string; body?: string; plate?: boolean }) {
  return (
    <div className={styles.quiet} data-plate={plate ? 'true' : undefined}>
      {plate
        ? <span className={styles.plate} aria-hidden="true" data-memorial="plate" />
        : <span className={styles.quietIcon} data-calm="true"><Icon name={icon} size={28} /></span>}
      {/* High contrast hides the plate's picture; the note then stands in for it. */}
      {plate && <span className={styles.plateFallback} aria-hidden="true"><Icon name={icon} size={28} /></span>}
      <p className={styles.quietTitle}>{title}</p>
      {body && <p className={styles.quietBody}>{body}</p>}
    </div>
  );
}

function LoadingLines() {
  return (
    <div className={styles.loading} role="status" aria-label="正在载入歌词">
      {[72, 54, 64, 40].map((w, i) => <span key={i} className="cdp-skeleton" style={{ width: w + '%' }} />)}
    </div>
  );
}

function Warnings({ warnings }: { warnings: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <span className={styles.warnings}>
      <button type="button" className="cdp-btn cdp-btn--text" aria-expanded={open} onClick={() => setOpen(v => !v)}>
        <Icon name="info" size={15} /> {warnings.length} 条提示
      </button>
      {open && (
        <ul className={`${styles.warningList} glass`}>
          {warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}
    </span>
  );
}
