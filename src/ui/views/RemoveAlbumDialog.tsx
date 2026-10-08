import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { Album } from '../../contracts/player.ts';
import { Cover } from '../components/Cover.tsx';
import { Frost, useFrostStyle } from '../components/Frost.tsx';
import { Icon } from '../components/Icon.tsx';
import type { IconName } from '../components/Icon.tsx';
import { InlineError, useActions } from '../lib/actions.tsx';
import type { RemoveAlbumBoot } from '../lib/env.ts';
import { useDraftStash } from '../lib/drafts.tsx';
import { albumDuration } from '../lib/library.ts';
import { usePlayer, useSurface } from '../lib/surface.tsx';
import { langHint } from '../lib/text.ts';
import { formatRunningTime } from './Spotlight.tsx';
import styles from './RemoveAlbumDialog.module.css';

/** An unsaved draft about the album being removed (lyrics of one of its tracks, its metadata). */
export interface RemovalDraft {
  /** Draft registry key: 'lyrics:<trackId>' (set aside or open), 'metadata-editor'. */
  key: string;
  label: string;
  /** The draft of an editor that is open now (the core closes it when the album goes). */
  open?: boolean;
}

/**
 * Removing an album from the collection (R2.2, contract 0.3.0 removeAlbum).
 *
 * The library revision the user is looking at when the dialog opens guards the removal. If the
 * collection changed meanwhile, the core answers 'conflict' and has already published the latest
 * snapshot: the dialog shows the latest content and asks again, with the revision now on screen;
 * it never retries by itself. The music files are not touched; the core backs up the app's data
 * first. Drafts that would lose their subject are named here and only given up on success.
 */
export function RemoveAlbumDialog({ albumId, openedRevision, drafts, seed, onCancel, onRemoved, onGone }: {
  albumId: string;
  /** Static preview frames only. */
  seed?: RemoveAlbumBoot;
  /** snapshot.library.revision when the user asked to remove (contract: baseLibraryRevision). */
  openedRevision: number;
  drafts: RemovalDraft[];
  onCancel(): void;
  /** The core removed it; the caller leaves its views and closes its editors. */
  onRemoved(): void;
  /** It was already gone (removed elsewhere); the caller says so and closes. */
  onGone(): void;
}) {
  const { index, library, online, currentTrack } = useSurface();
  const player = usePlayer();
  const { run, isPending, clear, show } = useActions();
  const stash = useDraftStash();
  const frost = useFrostStyle('dialog');
  const titleId = useId(), bodyId = useId();

  const latest = index.albumsById.get(albumId) ?? null;
  const last = useRef<Album | null>(latest);
  if (latest) last.current = latest;
  const album = last.current;

  /** The revision the next confirmation stands for: the one on screen when it was last asked. */
  const [revision, setRevision] = useState(openedRevision);
  /** Conflicts answered so far; each one re-asks for the revision then on screen. */
  const [conflicts, setConflicts] = useState(seed?.conflict ? 1 : 0);
  const [busy, setBusy] = useState(!!seed?.pending);
  const gone = !latest && !busy;
  const pending = busy || isPending('remove-album');

  useEffect(() => { if (seed?.error) show('remove', seed.error); return () => clear('remove'); },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only
    []);
  // The core publishes the latest snapshot before it answers 'conflict', so the render that shows
  // the conflict already shows the latest collection; that is what the next confirmation is for.
  useEffect(() => { if (conflicts) setRevision(library.revision); },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per conflict, not on every change
    [conflicts]);

  // Focus starts on Cancel (the safe choice), stays inside, and returns where it came from.
  const panel = useRef<HTMLDivElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancelButton.current?.focus();
    return () => { previous?.focus?.(); };
  }, []);
  const close = () => { if (!pending) (gone ? onGone : onCancel)(); };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.stopPropagation(); close(); return; }
    if (event.key !== 'Tab' || !panel.current) return;
    const nodes = [...panel.current.querySelectorAll<HTMLElement>('button:not(:disabled)')];
    if (!nodes.length) return;
    const first = nodes[0], lastNode = nodes[nodes.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); lastNode.focus(); }
    else if (!event.shiftKey && document.activeElement === lastNode) { event.preventDefault(); first.focus(); }
  };

  if (!album) return null;
  const trackIds = new Set(album.trackIds);
  const playingHere = !!currentTrack && trackIds.has(currentTrack.id);
  const queued = player.queue.filter(entry => trackIds.has(entry.trackId) && entry.id !== player.currentEntryId).length;
  const missing = album.trackIds.some(id => index.tracksById.get(id)?.available === false);

  const confirm = async () => {
    if (pending || gone) return;
    // Set-aside lyrics drafts live in the stash; the open editors' drafts end with their editors.
    const keys = drafts.filter(d => d.key.startsWith('lyrics:')).map(d => d.key);
    stash.discard(keys);
    setBusy(true);
    const result = await run({ type: 'removeAlbum', albumId, baseLibraryRevision: revision }, { slot: 'remove', key: 'remove-album' });
    setBusy(false);
    if (result.ok) {
      for (const key of keys) stash.drop(key);
      // An open editor that the removal closes uses its own mark up; release the rest.
      stash.release(drafts.filter(d => !d.open && d.key.startsWith('lyrics:')).map(d => d.key));
      onRemoved();
      return;
    }
    stash.release(keys);
    if (result.code === 'conflict') {
      clear('remove');
      setConflicts(n => n + 1);
    } else if (result.code === 'notFound') {
      clear('remove');
      onGone();
    }
    // Anything else stays in the dialog (InlineError below); the user can try again or cancel.
  };

  const lang = langHint(album.title, null, album.language);
  const facts: { icon: IconName; tone?: 'warn'; text: ReactNode }[] = [
    { icon: 'folder', text: '音乐文件和抓轨文件（log、CUE、封面图）都留在原处。重新导入它所在的文件夹，就能把它加回来。' },
    { icon: 'archive', text: '应用里为它整理的资料和歌词会从收藏里移除；移除前会自动备份一份。' },
    ...(playingHere ? [{ icon: 'stop' as const, text: player.status === 'playing'
      ? '它正在播放。确认后播放会停止；队列里其他专辑的曲目会保留。'
      : '播放器正停在它的一首上。确认后会停止；队列里其他专辑的曲目会保留。' }] : []),
    ...(queued > 0 ? [{ icon: 'list' as const, text: <>队列里有它的 <span className="num">{queued}</span> 首，会一起移出{playingHere ? '' : '；正在播放的不受影响'}。</> }] : []),
    ...(missing ? [{ icon: 'info' as const, text: '它有曲目的文件现在找不到；移除只清理收藏里的记录。' }] : []),
    ...(drafts.length ? [{ icon: 'warning' as const, tone: 'warn' as const,
      text: <>还有未保存的修改会一起放弃：{drafts.map(d => d.label).join('、')}。取消的话，它们都会保留。</> }] : []),
  ];

  return (
    <div className={styles.overlay} onKeyDown={onKeyDown}>
      <div className={styles.scrim} onClick={close} aria-hidden="true" />
      <div ref={panel} className={`${styles.panel} glass glass--frost`} style={frost} role="alertdialog" aria-modal="true"
        aria-labelledby={titleId} aria-describedby={bodyId} tabIndex={-1}>
        <Frost cover={album.cover} />
        <header className={styles.head}>
          <Cover albumId={album.id} title={album.title} cover={album.cover} className={styles.cover} showTitleOnPlaceholder={false} />
          <div className={styles.headText}>
            <h2 id={titleId} className={styles.kicker}><Icon name="shelfRemove" size={16} />{gone ? '已经不在收藏里' : '从收藏移除'}</h2>
            <p className={styles.title} lang={lang}>{album.title}</p>
            <p className={styles.meta}>
              <span lang={langHint(album.albumArtistCredit, null, album.language)}>{album.albumArtistCredit}</span>
              <span className="num">{album.trackIds.length} 首 · {formatRunningTime(albumDuration(album, index))}</span>
            </p>
          </div>
        </header>
        <div id={bodyId} className={styles.body}>
          {gone ? (
            <p className={styles.banner} role="status"><Icon name="info" size={16} />这张专辑已经从收藏里移除了（可能是在另一个窗口里）。</p>
          ) : (
            <>
              {conflicts > 0 && (
                <p className={styles.banner} role="status" data-tone="warn">
                  <Icon name="refresh" size={16} />确认前，收藏里的资料或歌词有了新的保存。上面是最新内容，请再确认一次。
                </p>
              )}
              <ul className={styles.facts}>
                {facts.map((fact, i) => (
                  <li key={i} data-tone={fact.tone}><Icon name={fact.icon} size={17} /><span>{fact.text}</span></li>
                ))}
              </ul>
            </>
          )}
          <InlineError slot="remove" ttl={0} className={styles.error} />
        </div>
        <footer className={styles.foot}>
          {gone ? (
            <button ref={cancelButton} type="button" className="cdp-btn cdp-btn--quiet" onClick={onGone}>关闭</button>
          ) : (
            <>
              <button ref={cancelButton} type="button" className="cdp-btn cdp-btn--quiet" disabled={pending} onClick={onCancel}>取消</button>
              <button type="button" className="cdp-btn cdp-btn--danger" disabled={!online || pending} onClick={() => void confirm()}>
                {pending ? <span className="cdp-spinner" /> : <Icon name="shelfRemove" size={17} />}
                {conflicts > 0 ? '再次确认移除' : '从收藏移除'}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
