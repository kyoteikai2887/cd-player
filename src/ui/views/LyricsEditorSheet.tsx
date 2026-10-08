import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from 'react';
import type { Album, LyricsDocument, LyricsEditorState, LyricsImportContent, LyricLine, PlayerSnapshot, TaskInfo, Track } from '../../contracts/player.ts';
import { Icon } from '../components/Icon.tsx';
import { Menu } from '../components/Menu.tsx';
import { PlayButton, SeekBar } from '../components/Transport.tsx';
import { InlineError, useActions } from '../lib/actions.tsx';
import { renderPosition } from '../lib/clock.ts';
import { useDirtyFlag, useDraftStash } from '../lib/drafts.tsx';
import { useBoot } from '../lib/env.ts';
import {
  alignTranslationByLine, applyImport, draftFromDocument, historyReducer, sameContent, toEdit, validateDraft,
} from '../lib/lyricsDraft.ts';
import type { DraftAction, LyricsDraft } from '../lib/lyricsDraft.ts';
import { usePlayer, useSurface } from '../lib/surface.tsx';
import { useActiveLyric } from '../lib/useClock.ts';
import { langHint } from '../lib/text.ts';
import { Banner, BannerDetail, BannerName, Banners, EditorFrame, EditorStatus } from './editor/EditorFrame.tsx';
import { EditorLine } from './editor/EditorLine.tsx';
import { LanguageSelect, useFocusRequest } from './editor/fields.tsx';
import { LyricsCompare } from './editor/LyricsCompare.tsx';
import styles from './LyricsEditorSheet.module.css';

/**
 * Lyrics editor (Claude, R2). A full-window workbench over the main surface.
 *
 * The draft lives here, in UI state, for one editing session of one track. Snapshots (position,
 * settings, a newer saved document) never overwrite unsaved changes. Every write carries the
 * revision the draft is based on; on conflict the draft is kept and the user chooses: load the
 * latest, compare, or explicitly overwrite with the draft against the latest revision.
 * Times are shown and edited as heard (startMs + offset); tap timing uses the shared display clock.
 */
export function LyricsEditorSheet({ editor, tasks = [] }: { editor: LyricsEditorState; tasks?: TaskInfo[] }) {
  const { index } = useSurface();
  const { run } = useActions();
  const track = index.tracksById.get(editor.trackId);
  const album = track ? index.albumsById.get(track.albumId) : undefined;
  const close = () => void run({ type: 'closeLyricsEditor' }, { slot: 'editor', key: 'lyrics-close' });
  if (!editor.document) {
    return (
      <Frame track={track} album={album} onEscape={close} title="歌词">
        <div className={styles.waiting}>
          {editor.status === 'failed'
            ? <p className={styles.waitingText}><Icon name="warning" size={18} /> {editor.error?.message ?? '歌词没有载入。'}</p>
            : <p className={styles.waitingText}><span className="cdp-spinner" /> 正在载入歌词…</p>}
          <button type="button" className="cdp-btn cdp-btn--quiet" onClick={close}>关闭</button>
        </div>
      </Frame>
    );
  }
  return <Workbench key={editor.trackId} editor={editor} doc={editor.document} tasks={tasks} track={track} album={album} />;
}

/** What survives when the editor goes away without the user choosing (see DraftStash). */
interface LyricsStash { hist: ReturnType<typeof historyReducer>; base: LyricsDocument; showTr: boolean }

type Confirm = 'loadLatest' | 'overwrite' | 'clear' | 'toPlain' | 'align';
interface ImportNote { message: string; warnings: string[]; canAlign: boolean; applied: boolean; content: LyricsImportContent; lines: LyricLine[] }
const IMPORT_LABEL: Record<LyricsImportContent, string> = { original: '原文', translation: '译文', bilingual: '双语歌词' };
const KIND_LABEL = { synced: '同步歌词', plain: '纯文本', missing: '无歌词' } as const;
const LIVE_CODES = new Set(['order', 'duplicateTimestamp', 'orphanTranslation', 'duplicateId']);

function Workbench({ editor, doc, tasks, track, album }: {
  editor: LyricsEditorState; doc: LyricsDocument; tasks: TaskInfo[]; track?: Track; album?: Album;
}) {
  const { run, isPending, clear } = useActions();
  const { online, currentTrack, reduced } = useSurface();
  const seed = useBoot().lyricsEditor;
  const stash = useDraftStash();
  const stashKey = 'lyrics:' + editor.trackId;
  // A draft left behind earlier (editor switched or closed from elsewhere) comes back as it was.
  const [restored] = useState(() => stash.peek(stashKey)?.value as LyricsStash | undefined);
  const [hist, dispatchHist] = useReducer(historyReducer, doc, d => restored?.hist ?? {
    past: [], future: [], lastKey: null,
    present: seed?.edit ? seed.edit(draftFromDocument(seed.base?.(d) ?? d)) : draftFromDocument(seed?.base?.(d) ?? d),
  });
  const draft = hist.present;
  const dispatch = useCallback((action: DraftAction) => dispatchHist(action), []);
  /** The saved document the draft started from (or was rebased onto after a save). */
  const [base, setBase] = useState(() => restored?.base ?? seed?.base?.(doc) ?? doc);
  const baseDraft = useMemo(() => draftFromDocument(base), [base]);
  const dirty = !sameContent(draft, baseDraft);
  useDirtyFlag('lyrics-editor', dirty);
  const draftRef = useRef(draft); draftRef.current = draft;
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;

  // A newer saved document: adopt it when it is what we just saved or when nothing is unsaved.
  // Unsaved changes are never overwritten; the user is told and chooses.
  useEffect(() => {
    if (doc.revision === base.revision) return;
    if (sameContent(draftRef.current, draftFromDocument(doc))) { setBase(doc); return; }
    if (!dirtyRef.current) { setBase(doc); dispatchHist({ type: 'reset', draft: draftFromDocument(doc) }); }
  }, [doc, base.revision]);

  const [view, setView] = useState<'edit' | 'compare'>(seed?.view ?? 'edit');
  const [mode, setMode] = useState<'edit' | 'tap'>(seed?.mode ?? 'edit');
  const [confirm, setConfirm] = useState<Confirm | null>(seed?.confirm ?? null);
  /** The saved version the user chose to overwrite (what was on screen when they asked). */
  const [overwriteRevision, setOverwriteRevision] = useState<number | null>(null);
  const [closing, setClosing] = useState(!!seed?.closing);
  const [showIssues, setShowIssues] = useState(!!seed?.showIssues);
  const [note, setNote] = useState<ImportNote | null>(() => seed?.note ? { applied: !seed.note.canAlign, ...seed.note, content: 'translation', lines: [] } : null);
  const [cursor, setCursor] = useState<string | null>(() => seed?.cursorIndex !== undefined ? hist.present.lines[seed.cursorIndex]?.id ?? null
    : seed?.mode === 'tap' ? (hist.present.lines.find(l => l.startMs === null) ?? hist.present.lines[0])?.id ?? null : null);
  const [savedAt, setSavedAt] = useState(0);
  // The translation column starts open only when there is translation to see.
  const [showTr, setShowTr] = useState(() => restored?.showTr ?? hist.present.lines.some(l => l.translation.trim()));

  // Leaving without a choice (the core switched or closed the editor) keeps unsaved work aside;
  // closing through our own prompts (discard, save) does not.
  const histRef = useRef(hist); histRef.current = hist;
  const baseRef = useRef(base); baseRef.current = base;
  const showTrRef = useRef(showTr); showTrRef.current = showTr;
  const settledRef = useRef(false);
  const label = track?.title ?? '未知曲目';
  useEffect(() => {
    stash.drop(stashKey);
    return () => {
      if (settledRef.current || !dirtyRef.current) return;
      stash.put({ key: stashKey, kind: 'lyrics', label, value: { hist: histRef.current, base: baseRef.current, showTr: showTrRef.current } satisfies LyricsStash,
        reopen: () => void run({ type: 'openLyricsEditor', trackId: editor.trackId }, { slot: 'editor', key: 'lyrics-reopen' }) });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount/unmount only
  }, []);
  const otherDrafts = stash.entries.filter(entry => entry.key !== stashKey);
  const focus = useFocusRequest();
  const playerRef = useRef<PlayerSnapshot | null>(null);
  const listRef = useRef<HTMLOListElement>(null);

  const trackId = draft.trackId;
  const isCurrent = currentTrack?.id === trackId;
  const outdated = doc.revision !== base.revision;
  // The core's 'conflict' status comes with the latest document; once the draft is rebased onto it
  // (loaded, overwritten or identical) there is nothing left to resolve.
  const conflict = outdated && dirty;
  const saving = isPending('lyrics-save');
  const importing = tasks.some(t => t.kind === 'import' && t.trackId === trackId);
  const marked = doc.kind === 'instrumental' || doc.kind === 'spoken' ? doc.kind : null;
  const lang = langHint(draft.lines.find(l => l.original.trim())?.original, draft.language, album?.language);
  const trLang = draft.translationLanguage ?? undefined;

  const issues = useMemo(() => validateDraft(draft), [draft]);
  const lineIssues = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const issue of issues) {
      if (!issue.lineId || !(showIssues || LIVE_CODES.has(issue.code))) continue;
      map.set(issue.lineId, [...(map.get(issue.lineId) ?? []), issue.message]);
    }
    return map;
  }, [issues, showIssues]);
  const generalIssues = showIssues ? [...new Set(issues.filter(i => !i.lineId || !draft.lines.some(l => l.id === i.lineId)).map(i => i.message))] : [];
  const orderProblem = issues.some(i => i.code === 'order');

  // Imports arrive as pendingImport; each is applied once, to the draft as it is *now*.
  const consumed = useRef(new Set(editor.pendingImport ? [editor.pendingImport.id] : []));
  useEffect(() => {
    const pending = editor.pendingImport;
    if (!pending || consumed.current.has(pending.id)) return;
    consumed.current.add(pending.id);
    const outcome = applyImport(draftRef.current, pending);
    if (outcome.applied) {
      dispatchHist({ type: 'replace', draft: outcome.draft });
      // Whatever the import leaves with a translation (its own, or the draft's re-paired by time) is
      // shown at once, so an online candidate's translation is not hidden behind a closed column.
      if (outcome.draft.lines.some(l => l.translation.trim())) setShowTr(true);
    }
    setNote({ message: outcome.message, warnings: outcome.warnings, canAlign: outcome.canAlignByLine, applied: outcome.applied, content: pending.content, lines: pending.lines });
  }, [editor.pendingImport]);

  const savingRef = useRef(false);
  const save = useCallback(async (revision?: number) => {
    if (savingRef.current) return false;   // one save at a time, however fast the clicks
    const current = draftRef.current;
    const problems = validateDraft(current);
    if (problems.length) {
      setShowIssues(true);
      const first = problems.find(p => p.lineId && current.lines.some(l => l.id === p.lineId));
      if (first) focus(`[data-line-id="${first.lineId}"] textarea`);
      return false;
    }
    savingRef.current = true;
    const result = await run({ type: 'saveLyrics', trackId: current.trackId, baseRevision: revision ?? base.revision, patch: toEdit(current) },
      { slot: 'editor', key: 'lyrics-save' }).finally(() => { savingRef.current = false; });
    if (result.ok) { setSavedAt(Date.now()); setShowIssues(false); return true; }
    if (result.code === 'conflict') clear('editor');   // the conflict bar explains it, with choices
    return false;
  }, [run, base.revision, focus, clear]);

  const close = (settled = true) => {
    settledRef.current = settled;
    void run({ type: 'closeLyricsEditor' }, { slot: 'editor', key: 'lyrics-close' }).then(result => { if (!result.ok) settledRef.current = false; });
  };
  const requestClose = () => { if (dirtyRef.current) setClosing(true); else close(); };

  const stampLine = useCallback((id: string) => {
    const player = playerRef.current;
    if (!player || player.currentTrackId !== trackId) return false;
    const heard = Math.round(renderPosition(player, performance.now()));
    dispatchHist({ type: 'stamp', id, startMs: heard - draftRef.current.offsetMs });
    return true;
  }, [trackId]);
  const tap = () => {
    const lines = draftRef.current.lines;
    const id = cursor ?? lines[0]?.id;
    if (!id || !stampLine(id)) return;
    const next = lines[lines.findIndex(l => l.id === id) + 1]?.id ?? null;
    setCursor(next);
    if (next) requestAnimationFrame(() => listRef.current?.querySelector(`[data-line-id="${next}"]`)?.scrollIntoView?.({ block: 'center', behavior: reduced ? 'auto' : 'smooth' }));
  };
  const tapButton = useRef<HTMLButtonElement>(null);
  const startTapping = () => {
    setMode('tap');
    setCursor(draft.lines.find(l => l.startMs === null)?.id ?? draft.lines[0]?.id ?? null);
    requestAnimationFrame(() => { if (tapButton.current && !tapButton.current.disabled) tapButton.current.focus(); });
  };
  const insertAfter = useCallback((afterId: string | null) => {
    const before = new Set(draftRef.current.lines.map(l => l.id));
    dispatchHist({ type: 'insert', afterId });
    // Focus the new line's text once it exists.
    requestAnimationFrame(() => {
      const added = listRef.current && [...listRef.current.querySelectorAll<HTMLElement>('[data-line-id]')].find(el => !before.has(el.dataset.lineId!));
      added?.querySelector('textarea')?.focus();
    });
  }, []);
  // Online candidates land in this draft as an import (pendingImport); the saved lyrics must not be locked.
  const searchCandidates = () => void run({ type: 'searchLyricsCandidates', trackId }, { slot: 'editor', key: 'lyrics-candidates' });
  const candidatesHint = doc.locked ? '这首的歌词已锁定：先关掉“已锁定”并保存，再搜索候选。' : '列出不同版本的歌词，预览后导入草稿';
  const requestImport = (content: LyricsImportContent) => {
    setNote(null);
    void run({ type: 'importLyrics', trackId, content, baseRevision: base.revision, destination: 'editorDraft' }, { slot: 'editor', key: 'lyrics-import' });
  };
  const mark = async (kind: 'instrumental' | 'spoken' | null) => {
    const result = await run({ type: 'setNoLyrics', trackId, baseRevision: doc.revision, kind }, { slot: 'editor', key: 'lyrics-mark' });
    // The editor snapshot only follows its own saves; reopening picks up the marked document
    // (CONTRACT_REQUESTS R2-1). Nothing is unsaved here: marking is disabled while dirty.
    if (result.ok) void run({ type: 'openLyricsEditor', trackId }, { slot: 'editor', key: 'lyrics-mark' });
  };
  const setKind = (kind: 'synced' | 'plain') => {
    if (kind === 'plain' && draft.kind === 'synced' && draft.lines.some(l => l.startMs !== null)) { setConfirm('toPlain'); return; }
    dispatch({ type: 'kind', kind });
    if (kind === 'synced' && draft.lines.some(l => l.startMs === null)) startTapping();
  };

  const runConfirm = async () => {
    const what = confirm;
    setConfirm(null);
    if (what === 'loadLatest') { setBase(doc); dispatchHist({ type: 'reset', draft: draftFromDocument(doc) }); setView('edit'); }
    else if (what === 'overwrite') { if (await save(overwriteRevision ?? doc.revision)) setView('edit'); }
    else if (what === 'clear') dispatch({ type: 'kind', kind: 'missing' });
    else if (what === 'toPlain') { dispatch({ type: 'kind', kind: 'plain' }); setMode('edit'); }
    else if (what === 'align' && note) {
      const aligned = alignTranslationByLine(draftRef.current, note.lines);
      dispatchHist({ type: 'replace', draft: { ...aligned.draft, translationLanguage: draftRef.current.translationLanguage } });
      setShowTr(true);
      setNote({ ...note, canAlign: false, applied: true, message: '已按行对齐译文，请逐行核对。', warnings: aligned.warnings });
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const inText = /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && key === 's') { event.preventDefault(); event.stopPropagation(); void save(); return; }
    if (mod && key === 'z' && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); dispatchHist({ type: 'undo' }); return; }
    if (mod && (key === 'y' || (key === 'z' && event.shiftKey))) { event.preventDefault(); event.stopPropagation(); dispatchHist({ type: 'redo' }); return; }
    // In tap mode Space is the tap key everywhere outside text fields (on key down, for timing;
    // held keys do not repeat). Buttons stay reachable with Enter.
    if (event.key === ' ' && !inText && mode === 'tap') {
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat) tap();
      return;
    }
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (confirm) setConfirm(null);
      else if (closing) setClosing(false);
      else if (view === 'compare') setView('edit');
      else if (mode === 'tap') setMode('edit');
      else requestClose();
      return;
    }
    // Space outside text fields in edit mode still plays/pauses (handled by the surface).
    if (!(event.key === ' ' && !inText)) event.stopPropagation();
  };

  const latestDraft = useMemo(() => draftFromDocument(doc), [doc]);
  const savedRecently = savedAt > 0 && !dirty && Date.now() - savedAt < 4000;
  const statusText = saving ? '正在保存…' : conflict ? '与最新版本有冲突' : dirty ? '有未保存的修改' : savedRecently ? '已保存' : '已是最新';

  return (
    <Frame track={track} album={album} onEscape={requestClose} onKeyDown={onKeyDown} title="歌词编辑"
      subtitle={<>{marked && draft.kind === 'missing' ? (marked === 'instrumental' ? '纯音乐' : '念白') : KIND_LABEL[draft.kind]}{draft.lines.some(l => l.translation.trim()) ? ' · 双语' : ''}{draft.locked ? ' · 已锁定' : ''}</>}
      status={<EditorStatus tone={conflict ? 'warn' : dirty ? 'dirty' : 'clean'}>{statusText}</EditorStatus>}
      actions={<>
        <button type="button" className="cdp-icon-btn" aria-label="撤销" title="撤销（Ctrl+Z）" disabled={!hist.past.length} onClick={() => dispatchHist({ type: 'undo' })}><Icon name="undo" size={18} /></button>
        <button type="button" className="cdp-icon-btn" aria-label="重做" title="重做（Ctrl+Y）" disabled={!hist.future.length} onClick={() => dispatchHist({ type: 'redo' })}><Icon name="redo" size={18} /></button>
      </>}
      onClose={requestClose}>
      <PlayerSync target={playerRef} />

      {view === 'edit' && (
        <div className={styles.toolbar} role="toolbar" aria-label="歌词编辑工具">
          {draft.kind !== 'missing' && (
            <div className="cdp-seg" role="group" aria-label="编辑方式">
              <button type="button" aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}>编辑</button>
              <button type="button" aria-pressed={mode === 'tap'} onClick={startTapping}>打轴</button>
            </div>
          )}
          {draft.kind !== 'missing' && (
            <div className="cdp-seg" role="group" aria-label="歌词类型">
              <button type="button" aria-pressed={draft.kind === 'synced'} onClick={() => setKind('synced')}>同步</button>
              <button type="button" aria-pressed={draft.kind === 'plain'} onClick={() => setKind('plain')}>纯文本</button>
            </div>
          )}
          {draft.kind === 'synced' && <OffsetControl draft={draft} dispatch={dispatch} />}
          <span className={styles.toolbarGap} />
          <LanguageSelect label="原文" value={draft.language} onChange={value => dispatch({ type: 'language', field: 'language', value })} />
          <LanguageSelect label="译文" value={draft.translationLanguage} onChange={value => dispatch({ type: 'language', field: 'translationLanguage', value })} />
          <button type="button" className="cdp-chip" aria-pressed={showTr} onClick={() => setShowTr(v => !v)} title="显示或隐藏译文列" aria-label="译文列">
            <Icon name="translate" size={15} /> <span className={styles.chipLabel}>译文列</span>
          </button>
          <button type="button" className="cdp-chip" aria-pressed={draft.locked} onClick={() => dispatch({ type: 'locked', locked: !draft.locked })}
            title="锁定后，自动查找不会替换这份歌词" aria-label="锁定这份歌词">
            <Icon name={draft.locked ? 'lock' : 'unlock'} size={15} /> <span className={styles.chipLabel}>{draft.locked ? '已锁定' : '未锁定'}</span>
          </button>
          <Menu label="导入歌词文件" align="end" items={[
            { label: '导入原文…', icon: 'importFile', disabled: !online || importing, onSelect: () => requestImport('original') },
            { label: '导入译文…', icon: 'translate', disabled: !online || importing || draft.kind === 'missing', onSelect: () => requestImport('translation') },
            { label: '导入双语 LRC…', icon: 'lyrics', disabled: !online || importing, onSelect: () => requestImport('bilingual') },
            { kind: 'separator' },
            { label: '从在线候选导入…', icon: 'search', disabled: !online || importing || doc.locked, hint: candidatesHint, onSelect: searchCandidates },
          ]} trigger={({ open, toggle, id, ref }) => (
            <button ref={ref} type="button" className="cdp-btn cdp-btn--quiet" aria-haspopup="menu" aria-expanded={open}
              aria-controls={open ? id : undefined} onClick={toggle} disabled={!online}>
              {importing ? <span className="cdp-spinner" /> : <Icon name="importFile" size={16} />} {importing ? '正在导入…' : '导入'}
            </button>
          )} />
          <Menu label="更多歌词操作" align="end" buttonClassName="cdp-icon-btn cdp-icon-btn--glass" items={[
            { label: '按时间排序', icon: 'list', disabled: draft.kind !== 'synced' || !orderProblem, onSelect: () => dispatch({ type: 'sortByTime' }) },
            { label: '清空歌词…', icon: 'trash', disabled: draft.kind === 'missing', onSelect: () => setConfirm('clear') },
            { kind: 'separator' },
            ...(marked ? [{ label: '取消“' + (marked === 'instrumental' ? '纯音乐' : '念白') + '”标记', icon: 'refresh' as const,
              disabled: !online || dirty, hint: dirty ? '请先保存或撤销修改' : undefined, onSelect: () => void mark(null) }] : [
              { label: '标记为纯音乐', icon: 'note' as const, disabled: !online || dirty, hint: dirty ? '请先保存或撤销修改' : undefined, onSelect: () => void mark('instrumental') },
              { label: '标记为念白', icon: 'mic' as const, disabled: !online || dirty, hint: dirty ? '请先保存或撤销修改' : undefined, onSelect: () => void mark('spoken') },
            ]),
          ]} />
        </div>
      )}

      <Banners>
        {conflict && (
          <Banner tone="warn" icon="warning" text={<>这首的歌词在别处更新了（已保存第 <span className="num">{doc.revision}</span> 版）。你的草稿还在，没有被覆盖。</>}>
            {/* While one of the choices waits for confirmation, the bar below carries the buttons. */}
            {confirm !== 'loadLatest' && confirm !== 'overwrite' && <>
              {view === 'edit'
                ? <button type="button" className="cdp-btn cdp-btn--quiet" onClick={() => setView('compare')}><Icon name="compare" size={16} /> 比较</button>
                : <button type="button" className="cdp-btn cdp-btn--quiet" onClick={() => setView('edit')}>返回草稿</button>}
              <button type="button" className="cdp-btn cdp-btn--quiet" onClick={() => setConfirm('loadLatest')}>载入最新…</button>
              <button type="button" className="cdp-btn cdp-btn--quiet" onClick={() => { setOverwriteRevision(doc.revision); setConfirm('overwrite'); }}>用草稿覆盖…</button>
            </>}
          </Banner>
        )}
        {marked && !conflict && draft.kind !== 'missing' && (
          <Banner tone="info" icon={marked === 'instrumental' ? 'note' : 'mic'}
            text={marked === 'instrumental' ? '这首已标记为纯音乐。保存歌词会取消这个标记。' : '这首已标记为念白。保存歌词会取消这个标记。'}>
            <button type="button" className="cdp-btn cdp-btn--quiet" disabled={!online || dirty} onClick={() => void mark(null)}>取消标记</button>
          </Banner>
        )}
        {note && view === 'edit' && (
          <Banner tone={!note.applied ? 'info' : note.warnings.length ? 'warn' : 'ok'} icon={!note.applied ? 'info' : note.warnings.length ? 'warning' : 'check'}
            text={<>{note.message}{note.warnings.length > 0 && <BannerDetail>{note.warnings.join(' ')}</BannerDetail>}</>}
            onDismiss={() => setNote(null)}>
            {note.canAlign && confirm !== 'align' && <button type="button" className="cdp-btn cdp-btn--quiet" onClick={() => setConfirm('align')}>按行对齐…</button>}
          </Banner>
        )}
        {mode === 'tap' && view === 'edit' && !isCurrent && (
          <Banner tone="info" icon="stopwatch" text="打轴要边听边点，需要播放这首歌。打开编辑器不会自动换曲。">
            <button type="button" className="cdp-btn cdp-btn--primary" disabled={!online || !track?.available || !album}
              onClick={() => album && run({ type: 'playAlbum', albumId: album.id, startTrackId: trackId }, { slot: 'editor', key: 'lyrics-play' })}>
              <Icon name="play" size={15} /> 播放这首
            </button>
          </Banner>
        )}
        {otherDrafts.map(entry => (
          <Banner key={entry.key} tone="info" icon="edit"
            text={<>{entry.kind === 'lyrics' ? '另一首' : '资料编辑'}<BannerName>“{entry.label}”</BannerName>还有未保存的修改。</>}>
            <button type="button" className="cdp-btn cdp-btn--quiet" onClick={() => stash.drop(entry.key)}>放弃那份</button>
            <button type="button" className="cdp-btn cdp-btn--quiet" onClick={entry.reopen}>切换过去</button>
          </Banner>
        ))}
        {generalIssues.length > 0 && <Banner tone="warn" icon="warning" text={'保存前需要修正：' + generalIssues.join(' ')} onDismiss={() => setShowIssues(false)} />}
        {confirm && (
          <Banner tone="ask" icon="info" text={CONFIRM_TEXT[confirm]}>
            <button type="button" className="cdp-btn cdp-btn--quiet" onClick={() => setConfirm(null)}>取消</button>
            <button type="button" className={`cdp-btn ${confirm === 'clear' || confirm === 'loadLatest' ? 'cdp-btn--quiet' : 'cdp-btn--primary'}`}
              onClick={() => void runConfirm()}>{CONFIRM_ACTION[confirm]}</button>
          </Banner>
        )}
      </Banners>

      <div className={styles.body} data-view={view}>
        {view === 'compare' ? (
          <LyricsCompare latest={latestDraft} latestRevision={doc.revision} draft={draft} lang={lang} trLang={trLang} />
        ) : draft.kind === 'missing' ? (
          <div className={styles.emptyState}>
            <Icon name={marked === 'instrumental' ? 'note' : marked === 'spoken' ? 'mic' : 'lyrics'} size={30} />
            <p className={styles.emptyTitle}>{marked ? (marked === 'instrumental' ? '已标记为纯音乐' : '已标记为念白')
              : baseDraft.kind === 'missing' ? '这首还没有歌词' : '歌词已清空'}</p>
            <p className={styles.emptyBody}>{marked ? '如果其实有歌词，可以导入或直接输入；保存后标记会自动取消。'
              : baseDraft.kind === 'missing' ? '导入一份 LRC 或文本，或者从第一行开始输入。' : '保存后这首就没有歌词。也可以撤销，或重新开始输入。'}</p>
            <div className={styles.emptyActions}>
              {marked && !dirty && (
                <button type="button" className="cdp-btn cdp-btn--quiet" disabled={!online} onClick={() => void mark(null)}><Icon name="refresh" size={16} /> 取消标记</button>
              )}
              <button type="button" className="cdp-btn cdp-btn--quiet" disabled={!online || importing} onClick={() => requestImport('original')}><Icon name="importFile" size={16} /> 导入歌词文件</button>
              <button type="button" className="cdp-btn cdp-btn--quiet" disabled={!online || importing || doc.locked} title={candidatesHint} onClick={searchCandidates}><Icon name="search" size={16} /> 搜索在线候选</button>
              <button type="button" className="cdp-btn cdp-btn--quiet" onClick={() => insertAfter(null)}><Icon name="edit" size={16} /> 开始输入</button>
            </div>
          </div>
        ) : (
          <>
            <div className={styles.columns} aria-hidden="true" data-kind={draft.kind} data-translation={showTr ? 'true' : 'false'}>
              <span />{draft.kind === 'synced' && <span className={styles.timeHead}>时间（听到的）</span>}
              <span className={styles.texts} data-translation={showTr ? 'true' : 'false'}><span>原文</span>{showTr && <span>译文</span>}</span>
              <span />
            </div>
            <ol ref={listRef} className={styles.lines} data-kind={draft.kind} data-mode={mode} data-translation={showTr ? 'true' : 'false'}>
              {draft.lines.map((line, i) => (
                <EditorLine key={line.id} line={line} number={i + 1} kind={draft.kind} offsetMs={draft.offsetMs}
                  issues={lineIssues.get(line.id)} showTranslation={showTr} tapping={mode === 'tap'} isCursor={cursor === line.id}
                  canStampNow={isCurrent} lang={lang} trLang={trLang} dispatch={dispatch}
                  onStampNow={stampLine} onCursor={setCursor} onInsert={insertAfter} />
              ))}
            </ol>
            <button type="button" className={styles.addLine} onClick={() => insertAfter(draft.lines[draft.lines.length - 1]?.id ?? null)}>
              <Icon name="plus" size={16} /> 添加一行
            </button>
            {isCurrent && draft.kind === 'synced' && <ActiveLineMarker draft={draft} list={listRef} />}
          </>
        )}
      </div>

      <footer className={styles.footer}>
        <div className={styles.footerTransport}>
          {isCurrent ? <TransportStrip /> : (
            <button type="button" className="cdp-btn cdp-btn--text" disabled={!online || !track?.available || !album}
              onClick={() => album && run({ type: 'playAlbum', albumId: album.id, startTrackId: trackId }, { slot: 'editor', key: 'lyrics-play' })}>
              <Icon name="play" size={15} /> 播放这首试听
            </button>
          )}
        </div>
        <div className={styles.footerMain}>
          {mode === 'tap' && view === 'edit' && draft.kind !== 'missing' ? (
            <div className={styles.tapBar}>
              <button ref={tapButton} type="button" className={`cdp-btn cdp-btn--primary ${styles.tapButton}`} disabled={!isCurrent || !cursor} onClick={tap}>
                <Icon name="tap" size={18} /> 打点 <kbd>空格</kbd>
              </button>
              <button type="button" className="cdp-btn cdp-btn--quiet" disabled={!hist.past.length} onClick={() => dispatchHist({ type: 'undo' })}>
                <Icon name="undo" size={16} /> 撤销上一点
              </button>
              <span className={styles.tapHint}>{!isCurrent ? '播放这首歌后才能打点。' : cursor ? '在这一行开始唱时按下。点左侧序号可换起点。' : '已经打到最后一行。'}</span>
            </div>
          ) : <InlineError slot="editor" />}
        </div>
        <div className={styles.footerActions}>
          {closing ? (
            <div className={styles.closeAsk} role="alertdialog" aria-label="未保存的修改">
              <span>有未保存的修改。</span>
              <button type="button" className="cdp-btn cdp-btn--quiet" onClick={() => close()}>放弃修改</button>
              <button type="button" className="cdp-btn cdp-btn--quiet" onClick={() => setClosing(false)}>继续编辑</button>
              <button type="button" className="cdp-btn cdp-btn--primary" disabled={!online || saving}
                onClick={async () => { if (await save()) close(); else setClosing(false); }}>保存并关闭</button>
            </div>
          ) : (
            <>
              <button type="button" className="cdp-btn cdp-btn--quiet" onClick={requestClose}>{dirty ? '关闭' : '完成'}</button>
              <button type="button" className="cdp-btn cdp-btn--primary" disabled={!online || !dirty || saving} onClick={() => void save()}>
                {saving ? <span className="cdp-spinner" /> : <Icon name="check" size={16} />} 保存
              </button>
            </>
          )}
        </div>
      </footer>
    </Frame>
  );
}

const CONFIRM_TEXT: Record<Confirm, string> = {
  loadLatest: '放弃你的草稿，换成别处最新保存的歌词？这一步不能撤销。',
  overwrite: '用你的草稿替换别处最新保存的版本？对方的修改会被覆盖。',
  clear: '清空这首的全部歌词？保存后生效，保存前可以撤销。',
  toPlain: '转为纯文本会去掉所有时间，并移除空白的间奏行。',
  align: '把译文按顺序逐行对应到原文？这不是按时间配对，请对齐后逐行核对。',
};
const CONFIRM_ACTION: Record<Confirm, string> = {
  loadLatest: '载入最新', overwrite: '用草稿覆盖', clear: '清空', toPlain: '转为纯文本', align: '按行对齐',
};

/** The shared editor shell, labelled with the track being edited. */
function Frame({ track, album, title, subtitle, status, actions, children, onClose, onEscape, onKeyDown }: {
  track?: Track; album?: Album; title: string; subtitle?: ReactNode; status?: ReactNode; actions?: ReactNode; children: ReactNode;
  onClose?(): void; onEscape(): void; onKeyDown?(event: ReactKeyboardEvent<HTMLDivElement>): void;
}) {
  return (
    <EditorFrame album={album} kicker={title} meta={subtitle} heading={track?.title ?? '未知曲目'}
      headingLang={langHint(track?.title, track?.language, album?.language)}
      sub={album ? `${album.title}${track ? ` · 第 ${track.trackNumber} 首` : ''}` : undefined} subLang={album ? langHint(album.title, null, album.language) : undefined}
      status={status} actions={actions} closeLabel="关闭歌词编辑" onClose={onClose} onEscape={onEscape} onKeyDown={onKeyDown}>
      {children}
    </EditorFrame>
  );
}

function OffsetControl({ draft, dispatch }: { draft: LyricsDraft; dispatch(action: DraftAction): void }) {
  const ms = draft.offsetMs;
  return (
    <div className={styles.offset} role="group" aria-label="整体偏移">
      <Icon name="timer" size={15} className={styles.offsetIcon} /><span className={styles.offsetLabel}>偏移</span>
      <button type="button" className="cdp-icon-btn cdp-icon-btn--sm" aria-label="歌词整体提前 0.1 秒" title="整体提前 0.1 秒" onClick={() => dispatch({ type: 'offset', offsetMs: ms - 100 })}>−</button>
      <output className={`${styles.offsetValue} num`} aria-live="polite">{ms > 0 ? '+' : ms < 0 ? '−' : ''}{(Math.abs(ms) / 1000).toFixed(1)}s</output>
      <button type="button" className="cdp-icon-btn cdp-icon-btn--sm" aria-label="歌词整体延后 0.1 秒" title="整体延后 0.1 秒" onClick={() => dispatch({ type: 'offset', offsetMs: ms + 100 })}>+</button>
      {ms !== 0 && (
        <button type="button" className="cdp-btn cdp-btn--text" onClick={() => dispatch({ type: 'mergeOffset' })}
          title="把偏移写进每一行的时间，偏移归零；听到的时间不变">
          <Icon name="merge" size={15} /> 合并到时间轴
        </button>
      )}
    </div>
  );
}

/** Keeps the latest player snapshot in a ref without re-rendering the editor on every sample. */
function PlayerSync({ target }: { target: RefObject<PlayerSnapshot | null> }) {
  target.current = usePlayer();
  return null;
}

function TransportStrip() {
  const [preview, setPreview] = useState<number | null>(null);
  return (
    <div className={styles.transport}>
      <PlayButton size="xs" />
      <SeekBar preview={preview} onPreview={setPreview} />
    </div>
  );
}

/**
 * Marks the line being heard right now, by attribute, so the rows themselves do not re-render.
 * The mark is removed whenever it moves and when this marker goes away (playback moved to
 * another track), so no stale "being sung" line is left behind.
 */
function ActiveLineMarker({ draft, list }: { draft: LyricsDraft; list: RefObject<HTMLOListElement | null> }) {
  const player = usePlayer();
  const { visible } = useSurface();
  const lines = useMemo(() => toEdit(draft).lines, [draft]);
  const index = useActiveLyric(lines, draft.offsetMs, player, visible, null);
  const id = index >= 0 ? lines[index]?.id : null;
  useEffect(() => {
    const row = id ? list.current?.querySelector(`[data-line-id="${id}"]`) : null;
    row?.setAttribute('data-playing', 'true');
    return () => row?.removeAttribute('data-playing');
  }, [id, list, draft]);
  return null;
}
