import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ActionResult, Album, MusicVideo, OperationError, TaskInfo } from '../../contracts/player.ts';
import { Icon } from '../components/Icon.tsx';
import { Menu } from '../components/Menu.tsx';
import { InlineError, useActions } from '../lib/actions.tsx';
import type { Slot } from '../lib/actions.tsx';
import { useSurface } from '../lib/surface.tsx';
import { langHint } from '../lib/text.ts';
import styles from './AlbumVideos.module.css';

/**
 * Music videos (MV round, Claude): MKV files linked to an album and opened in PotPlayer. They are
 * the album's attachments, not tracks — no queue, no durations, no thumbnails; only what the core
 * actually reports (a title and the file's name). Everything shown comes from the snapshot: the
 * UI keeps no copy of the links and changes nothing until the core has answered.
 */

const videosOf = (album: Album): MusicVideo[] => album.musicVideos ?? [];

/** 1–200 characters once trimmed, no control characters (the core checks again). */
export function validateVideoTitle(raw: string): string | null {
  const title = raw.trim();
  if (!title) return '名称不能为空。';
  if ([...title].length > 200) return '名称最多 200 个字符。';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(title)) return '名称不能包含换行或其它控制字符。';
  return null;
}

// ── Linking (add / relink) ──────────────────────────────────────────────
/**
 * Adding or relinking opens the system file picker, so the core answers `started` with a task
 * id and finishes later: done (the library already carries the link when the task leaves the
 * list), cancelled (nothing changes, nothing is said) or failed (the core posts a notice). Success
 * is only announced when the link is actually there in the snapshot.
 */
interface Pending { taskId: string | null; kind: 'add' | 'relink'; videoId?: string; before: MusicVideo[] }
export interface VideoLinking {
  link(kind: 'add', video?: undefined, slot?: Slot): Promise<ActionResult>;
  link(kind: 'relink', video: MusicVideo, slot?: Slot): Promise<ActionResult>;
  /** The picker task this surface started for this album, while it runs. */
  running: TaskInfo | null;
  /** Which link is being relinked, while it runs. */
  relinking: string | null;
  /** Said once a link has really been made (cleared after a few seconds). */
  outcome: { message: string; videoId: string } | null;
  cancel(): void;
}

export function useVideoLinking(album: Album, tasks: TaskInfo[]): VideoLinking {
  const { run } = useActions();
  const videos = videosOf(album);
  const latest = useRef(videos);
  latest.current = videos;
  const [pending, setPending] = useState<Pending | null>(null);
  const [outcome, setOutcome] = useState<VideoLinking['outcome']>(null);

  const link = useCallback(async (kind: 'add' | 'relink', video?: MusicVideo, slot: Slot = 'video'): Promise<ActionResult> => {
    const before = latest.current;
    const result = await run(kind === 'add'
      ? { type: 'addMusicVideo', albumId: album.id }
      : { type: 'relinkMusicVideo', albumId: album.id, videoId: video!.id, baseRevision: video!.revision },
    { slot, key: kind === 'add' ? 'mv-add' : 'mv-relink-' + video!.id });
    if (result.ok && result.status !== 'cancelled') {
      setPending({ taskId: result.status === 'started' ? result.taskId : null, kind, videoId: video?.id, before });
    }
    return result;
  }, [run, album.id]) as VideoLinking['link'];

  // The task has left the list (or the core answered at once): see what actually changed.
  useEffect(() => {
    if (!pending) return;
    if (pending.taskId && tasks.some(t => t.id === pending.taskId)) return;
    if (pending.kind === 'add') {
      const added = videos.find(v => !pending.before.some(b => b.id === v.id));
      if (added) setOutcome({ message: `已关联「${added.title}」`, videoId: added.id });
    } else {
      const was = pending.before.find(v => v.id === pending.videoId), now = videos.find(v => v.id === pending.videoId);
      if (was && now && now.revision > was.revision) setOutcome({ message: `「${now.title}」已重新关联到 ${now.fileName}`, videoId: now.id });
    }
    setPending(null);
  }, [pending, tasks, videos]);

  useEffect(() => {
    if (!outcome) return;
    const timer = setTimeout(() => setOutcome(null), 6000);
    return () => clearTimeout(timer);
  }, [outcome]);

  const running = pending?.taskId ? tasks.find(t => t.id === pending.taskId) ?? null : null;
  const cancel = useCallback(() => {
    if (running) void run({ type: 'cancelTask', taskId: running.id }, { slot: 'video', key: 'cancel-' + running.id });
  }, [run, running]);
  return { link, running, relinking: running && pending?.kind === 'relink' ? pending.videoId ?? null : null, outcome, cancel };
}

/** One line while the picker is open: what is happening, and a way out. */
export function LinkingStatus({ linking, album, className }: { linking: VideoLinking; album: Album; className?: string }) {
  const task = linking.running;
  if (!task) return null;
  const relinked = linking.relinking ? videosOf(album).find(v => v.id === linking.relinking) : null;
  return (
    <p className={`${styles.linking} ${className ?? ''}`} role="status">
      <span className="cdp-spinner" aria-hidden="true" />
      <span>{task.status === 'cancelling' ? '正在取消…'
        : relinked ? `正在重新关联「${relinked.title}」：请在弹出的窗口中选择 MKV 文件`
          : '正在关联 MV：请在弹出的窗口中选择 MKV 文件'}</span>
      {task.cancellable && task.status !== 'cancelling' && (
        <button type="button" className="cdp-btn cdp-btn--text" onClick={linking.cancel}>取消</button>
      )}
    </p>
  );
}

// ── The section ─────────────────────────────────────────────────────────
export function AlbumVideos({ album, linking, onOpenPlayerSettings, onLastRemoving }: {
  album: Album; linking: VideoLinking;
  /** Opens the settings sheet at the PotPlayer row (from a failed launch). */
  onOpenPlayerSettings(): void;
  /**
   * The last link is about to go (true) — the section will disappear, so the album page takes focus
   * back — or it stayed after all (false).
   */
  onLastRemoving(going: boolean): void;
}) {
  const { online } = useSurface();
  const { isPending } = useActions();
  const videos = videosOf(album);
  const headingId = useId();
  const mains = useRef(new Map<string, HTMLButtonElement>());
  const addButton = useRef<HTMLButtonElement>(null);
  // After a removal, focus goes to the row that took its place (or the one before, or "关联 MV…").
  const [refocus, setRefocus] = useState<{ index: number; gone: string } | null>(null);
  useEffect(() => {
    if (!refocus || videos.some(v => v.id === refocus.gone)) return;
    const next = videos[Math.min(refocus.index, videos.length - 1)];
    (next ? mains.current.get(next.id) : addButton.current)?.focus();
    setRefocus(null);
  }, [refocus, videos]);

  if (!videos.length) return null;
  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <header className={styles.head}>
        <h2 id={headingId} className={styles.title}>
          <Icon name="film" size={16} />
          <span>附带影像</span>
          <span className={`${styles.count} num`} aria-label={`${videos.length} 条`}>{videos.length}</span>
        </h2>
        <button ref={addButton} type="button" className="cdp-btn cdp-btn--text" disabled={!online || !!linking.running}
          onClick={() => void linking.link('add')}>
          {isPending('mv-add') ? <span className="cdp-spinner" /> : <Icon name="plus" size={16} />} 关联 MV…
        </button>
      </header>
      <LinkingStatus linking={linking} album={album} />
      <InlineError slot="video" />
      <ol className={styles.list}>
        {videos.map((video, index) => (
          <VideoRow key={video.id} album={album} video={video} linking={linking}
            fresh={linking.outcome?.videoId === video.id}
            mainRef={el => { if (el) mains.current.set(video.id, el); else mains.current.delete(video.id); }}
            onOpenPlayerSettings={onOpenPlayerSettings}
            onRemoving={going => {
              // Set before the core answers: the snapshot that drops the row can arrive first.
              if (videos.length === 1) onLastRemoving(going);
              else setRefocus(going ? { index, gone: video.id } : null);
            }} />
        ))}
      </ol>
      <p className={styles.note}>由 PotPlayer 打开；开始播放时音乐会暂停，看完后需要手动继续。</p>
      {/* Said only once the link is really there (the task's own notices cover failures). */}
      <p className="sr-only" role="status" aria-live="polite">{linking.outcome?.message ?? ''}</p>
    </section>
  );
}

type RowMode = 'idle' | 'rename' | 'remove';
interface RowFailure { action: 'play' | 'rename' | 'remove'; code: OperationError['code']; message: string }

function VideoRow({ album, video, linking, fresh, mainRef, onOpenPlayerSettings, onRemoving }: {
  album: Album; video: MusicVideo; linking: VideoLinking; fresh: boolean;
  mainRef(el: HTMLButtonElement | null): void;
  onOpenPlayerSettings(): void;
  onRemoving(going: boolean): void;
}) {
  const { online } = useSurface();
  const { run, isPending, clear } = useActions();
  const [mode, setMode] = useState<RowMode>('idle');
  const [draft, setDraft] = useState(video.title);
  const [failure, setFailure] = useState<RowFailure | null>(null);
  const [launched, setLaunched] = useState(false);
  const main = useRef<HTMLButtonElement | null>(null);
  const more = useRef<HTMLButtonElement | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const cancelRemove = useRef<HTMLButtonElement>(null);
  const errorId = useId();
  const lang = langHint(video.title, null, album.language);
  const busy = isPending('mv-play-' + video.id);
  const relinking = linking.relinking === video.id;

  useEffect(() => {
    if (!launched) return;
    const timer = setTimeout(() => setLaunched(false), 4000);
    return () => clearTimeout(timer);
  }, [launched]);
  // A relink that really happened clears a "file missing" failure.
  const revision = useRef(video.revision);
  useEffect(() => {
    if (video.revision !== revision.current) { revision.current = video.revision; setFailure(f => (f?.action === 'play' ? null : f)); }
  }, [video.revision]);
  useEffect(() => { if (mode === 'rename') { field.current?.focus(); field.current?.select(); } }, [mode]);
  useEffect(() => { if (mode === 'remove') cancelRemove.current?.focus(); }, [mode]);

  /** Row actions report here, next to the row, with what can be done about it. */
  const attempt = async (action: RowFailure['action'], result: Promise<ActionResult>) => {
    const outcome = await result;
    clear('video');
    if (!outcome.ok) setFailure({ action, code: outcome.code, message: outcome.message });
    else setFailure(null);
    return outcome;
  };

  const play = async () => {
    setLaunched(false);
    const result = await attempt('play', run({ type: 'playMusicVideo', albumId: album.id, videoId: video.id },
      { slot: 'video', key: 'mv-play-' + video.id }));
    if (result.ok && result.status === 'applied') setLaunched(true);
  };
  // Back at rest, focus returns to the row (after a save) or to its menu button (after a cancel),
  // once the row's buttons are there again.
  const [focusTo, setFocusTo] = useState<'main' | 'more' | null>(null);
  useEffect(() => {
    if (!focusTo || mode !== 'idle') return;
    (focusTo === 'main' ? main.current : more.current)?.focus();
    setFocusTo(null);
  }, [focusTo, mode]);
  const back = (to: 'main' | 'more' = 'main') => { setMode('idle'); setFocusTo(to); };
  const saveTitle = async () => {
    const invalid = validateVideoTitle(draft);
    if (invalid) { setFailure({ action: 'rename', code: 'invalidAction', message: invalid }); field.current?.focus(); return; }
    if (draft.trim() === video.title) { setFailure(null); back(); return; }
    // The revision is read now, from the latest snapshot: after a conflict the retry uses the new one.
    const result = await attempt('rename', run({ type: 'renameMusicVideo', albumId: album.id, videoId: video.id,
      baseRevision: video.revision, title: draft.trim() }, { slot: 'video', key: 'mv-rename-' + video.id }));
    if (result.ok) back();
    else field.current?.focus();
  };
  const remove = async () => {
    onRemoving(true);
    const result = await attempt('remove', run({ type: 'removeMusicVideo', albumId: album.id, videoId: video.id,
      baseRevision: video.revision }, { slot: 'video', key: 'mv-remove-' + video.id }));
    if (!result.ok) { onRemoving(false); cancelRemove.current?.focus(); }
  };
  const onFieldKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); void saveTitle(); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setFailure(null); setDraft(video.title); back('more'); }
  };
  const onRemoveKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.stopPropagation(); setFailure(null); back('more'); }
  };

  const conflictNote = failure?.code === 'conflict'
    ? (failure.action === 'rename' ? '这条 MV 刚在别处改过，已显示最新内容；你的名称草稿还在，可以再保存一次。'
      : failure.action === 'remove' ? '这条 MV 刚在别处改过，已显示最新内容；确认无误后可以再移除一次。' : null)
    : null;

  return (
    <li className={styles.row} data-mode={mode} data-fresh={fresh ? 'true' : undefined}
      data-failed={failure ? 'true' : undefined} aria-describedby={failure ? errorId : undefined}>
      <div className={styles.line}>
        {mode === 'rename' ? (
          <div className={styles.rename}>
            <span className={styles.glyph} aria-hidden="true"><Icon name="film" size={18} /></span>
            <input ref={field} className={styles.field} value={draft} maxLength={400} lang={lang}
              aria-label={`MV 名称：${video.title}`} aria-invalid={failure?.action === 'rename' && failure.code === 'invalidAction' ? 'true' : undefined}
              aria-describedby={failure ? errorId : undefined}
              onChange={event => setDraft(event.target.value)} onKeyDown={onFieldKey} />
            <span className={styles.renameActions}>
              <button type="button" className={`cdp-btn cdp-btn--primary ${styles.small}`} disabled={!online}
                onClick={() => void saveTitle()}>
                {isPending('mv-rename-' + video.id) ? <span className="cdp-spinner" /> : null}保存
              </button>
              <button type="button" className={`cdp-btn cdp-btn--quiet ${styles.small}`}
                onClick={() => { setFailure(null); setDraft(video.title); back('more'); }}>取消</button>
            </span>
          </div>
        ) : (
          <>
            <button ref={el => { main.current = el; mainRef(el); }} type="button" className={styles.main}
              disabled={!online || busy || relinking} aria-label={`用 PotPlayer 播放：${video.title}`} title={`用 PotPlayer 播放：${video.title}`}
              onClick={() => void play()}>
              <span className={styles.glyph} aria-hidden="true">
                {busy ? <span className="cdp-spinner" /> : <>
                  <Icon name="film" size={18} className={styles.glyphFilm} />
                  <Icon name="play" size={15} className={styles.glyphPlay} />
                </>}
              </span>
              <span className={styles.text}>
                <span className={styles.name} lang={lang}>{video.title}</span>
                <span className={styles.file} title={video.fileName}>{video.fileName}</span>
              </span>
              <span className={styles.where} aria-hidden="true">
                {launched ? <><Icon name="check" size={14} /> 已交给 PotPlayer</> : <>PotPlayer <Icon name="open" size={14} /></>}
              </span>
            </button>
            <span className="sr-only" role="status" aria-live="polite">{launched ? `已交给 PotPlayer：${video.title}` : ''}</span>
            <Menu label={`更多：${video.title}`} tooltip="更多操作" trigger={({ open, toggle, id, ref }) => (
              <button ref={el => { ref(el); more.current = el; }} type="button" className={`cdp-icon-btn cdp-icon-btn--sm ${styles.more}`}
                aria-label={`更多：${video.title}`} title="更多操作" aria-haspopup="menu" aria-expanded={open}
                aria-controls={open ? id : undefined} onClick={toggle}>
                <Icon name="more" />
              </button>
            )} items={[
              { label: '改名…', icon: 'edit', disabled: !online, hint: '只改这里显示的名称，不改磁盘上的文件名',
                onSelect: () => { setDraft(video.title); setFailure(null); setMode('rename'); } },
              { label: '重新关联文件…', icon: 'link', disabled: !online || !!linking.running, hint: '文件移动后，选择它的新位置',
                onSelect: () => { more.current?.focus(); setFailure(null); void linking.link('relink', video); } },
              { kind: 'separator' },
              { label: '移除关联…', icon: 'unlink', disabled: !online, hint: '只解除与专辑的关联，视频文件保留在原处',
                onSelect: () => { setFailure(null); setMode('remove'); } },
            ]} />
          </>
        )}
      </div>

      {mode === 'remove' && (
        <div className={styles.confirm} role="group" aria-label={`移除关联：${video.title}`} onKeyDown={onRemoveKey}>
          <p>从这张专辑移除「<span lang={lang}>{video.title}</span>」？<strong>视频文件不会被删除</strong>，以后可以再关联。</p>
          <span className={styles.confirmActions}>
            <button type="button" className={`cdp-btn cdp-btn--danger ${styles.small}`} disabled={!online} onClick={() => void remove()}>
              {isPending('mv-remove-' + video.id) ? <span className="cdp-spinner" /> : <Icon name="unlink" size={16} />} 移除关联
            </button>
            <button ref={cancelRemove} type="button" className={`cdp-btn cdp-btn--quiet ${styles.small}`}
              onClick={() => { setFailure(null); back('more'); }}>取消</button>
          </span>
        </div>
      )}

      {failure && (
        <div id={errorId} className={styles.failure} role="alert" data-code={failure.code}>
          <Icon name="warning" size={16} />
          <p>{conflictNote ?? failure.message}</p>
          <span className={styles.failureActions}>
            {failure.action === 'play' && failure.code === 'fileMissing' && (
              <button type="button" className="cdp-btn cdp-btn--text" disabled={!online || !!linking.running}
                onClick={() => void linking.link('relink', video)}>重新关联…</button>
            )}
            {failure.action === 'play' && failure.code !== 'fileMissing' && failure.code !== 'conflict' && (
              <button type="button" className="cdp-btn cdp-btn--text" onClick={onOpenPlayerSettings}>PotPlayer 设置…</button>
            )}
            {failure.action === 'play' && (
              <button type="button" className="cdp-icon-btn cdp-icon-btn--sm" aria-label="关闭提示" title="关闭提示"
                onClick={() => { setFailure(null); main.current?.focus(); }}>
                <Icon name="close" size={14} />
              </button>
            )}
          </span>
        </div>
      )}
    </li>
  );
}
