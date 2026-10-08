import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { PlayerSnapshot, QueueEntry } from '../../contracts/player.ts';
import { Cover } from '../components/Cover.tsx';
import { Icon } from '../components/Icon.tsx';
import { Menu } from '../components/Menu.tsx';
import { InlineError, useActions } from '../lib/actions.tsx';
import { formatClock } from '../lib/clock.ts';
import { queueEnded } from '../lib/queue.ts';
import { usePlayer, useSurface } from '../lib/surface.tsx';
import { langHint, versionBadge } from '../lib/text.ts';
import styles from './QueueList.module.css';

interface Drag { id: string; from: number; over: number; dy: number; startY: number; mids: number[]; step: number; pointerId: number }

/** Where an entry lands so it plays right after the current one. */
export function playNextIndex(player: PlayerSnapshot, from: number): number {
  const current = player.currentQueueIndex;
  if (current < 0) return 0;
  return from < current ? current : current + 1;
}
const moved = (queue: QueueEntry[], id: string, to: number) => {
  const from = queue.findIndex(e => e.id === id);
  if (from < 0) return queue;
  const next = [...queue];
  const [entry] = next.splice(from, 1);
  next.splice(Math.min(to, next.length), 0, entry);
  return next;
};

/**
 * The play queue (Claude, R2). Entries are keyed by entry id, so the same track queued twice is two
 * independent rows. Reorder by dragging the grip, with the arrow keys on the grip, Alt+↑/↓ on a
 * row, or the row menu. A move shows at once and is replaced by the core's order as soon as the
 * action settles; the snapshot is always the truth. Moving the playing entry never restarts it.
 */
export function QueueList() {
  const player = usePlayer();
  const { index, online, reduced } = useSurface();
  const { run } = useActions();
  const [pending, setPending] = useState<{ id: string; to: number } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [announce, setAnnounce] = useState('');
  const listRef = useRef<HTMLOListElement>(null);
  const refocus = useRef<string | null>(null);
  const hintId = useId();

  const entries = pending ? moved(player.queue, pending.id, pending.to) : player.queue;
  const current = player.currentQueueIndex;
  const ended = queueEnded(player);
  const titleOf = (entry: QueueEntry) => index.tracksById.get(entry.trackId)?.title ?? '未知曲目';

  // Reordering moves DOM nodes, which drops focus; put it back on the entry that moved.
  useLayoutEffect(() => {
    const id = refocus.current;
    if (!id) return;
    const target = listRef.current?.querySelector<HTMLElement>(`[data-entry-id="${id}"] [data-grip]`);
    if (target && document.activeElement !== target) target.focus();
    refocus.current = null;
  });

  const move = async (entry: QueueEntry, to: number, keepFocus = false) => {
    const from = player.queue.findIndex(e => e.id === entry.id);
    if (from < 0 || to < 0 || to >= player.queue.length || to === from) return;
    setPending({ id: entry.id, to });
    refocus.current = keepFocus ? entry.id : null;
    setAnnounce(`“${titleOf(entry)}”移到第 ${to + 1} 首`);
    await run({ type: 'moveQueueEntry', entryId: entry.id, toIndex: to }, { slot: 'queue', key: 'queue-move' });
    setPending(p => (p && p.id === entry.id && p.to === to ? null : p));
  };
  const remove = (entry: QueueEntry) => {
    setAnnounce(`已从队列移除“${titleOf(entry)}”`);
    void run({ type: 'removeFromQueue', entryId: entry.id }, { slot: 'queue', key: 'queue-remove-' + entry.id });
  };

  // ── Pointer drag on the grip ─────────────────────────────────────────────
  const onGripDown = (event: ReactPointerEvent<HTMLButtonElement>, entry: QueueEntry, i: number) => {
    if (event.button !== 0 || !online || pending) return;
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-entry-id]') ?? [])];
    const rects = rows.map(row => row.getBoundingClientRect());
    if (!rects[i]) return;
    event.preventDefault();
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* not an active pointer (synthetic events) */ }
    // Rows are evenly spaced; one step is the distance between two neighbours.
    const step = rects.length > 1 ? rects[1].top - rects[0].top : rects[i].height;
    setDrag({ id: entry.id, from: i, over: i, dy: 0, startY: event.clientY, mids: rects.map(r => r.top + r.height / 2), step: step || rects[i].height, pointerId: event.pointerId });
  };
  const onGripMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dy = event.clientY - drag.startY;
    const center = drag.mids[drag.from] + dy;
    const over = drag.mids.filter((mid, k) => k !== drag.from && mid < center).length;
    if (dy !== drag.dy || over !== drag.over) setDrag({ ...drag, dy, over });
  };
  const onGripUp = (event: ReactPointerEvent<HTMLButtonElement>, entry: QueueEntry) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { from, over } = drag;
    setDrag(null);
    if (over !== from) void move(entry, over, true);
  };
  const cancelDrag = () => setDrag(null);

  const onGripKey = (event: ReactKeyboardEvent<HTMLButtonElement>, entry: QueueEntry, i: number) => {
    if (event.key === 'Escape' && drag) { event.preventDefault(); event.stopPropagation(); cancelDrag(); return; }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault(); event.stopPropagation();
      void move(entry, i + (event.key === 'ArrowUp' ? -1 : 1), true);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); event.stopPropagation();
      void move(entry, event.key === 'Home' ? 0 : player.queue.length - 1, true);
    }
  };
  const onRowKey = (event: ReactKeyboardEvent<HTMLLIElement>, entry: QueueEntry, i: number, isCurrent: boolean) => {
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault(); event.stopPropagation();
      void move(entry, i + (event.key === 'ArrowUp' ? -1 : 1), true);
    } else if (event.key === 'Delete' && !isCurrent && (event.target as HTMLElement).tagName === 'BUTTON') {
      event.preventDefault(); remove(entry);
    }
  };

  const shift = (k: number) => {
    if (!drag || k === drag.from) return 0;
    if (drag.from < drag.over && k > drag.from && k <= drag.over) return -drag.step;
    if (drag.over < drag.from && k >= drag.over && k < drag.from) return drag.step;
    return 0;
  };

  if (!player.queue.length) return <p className={styles.empty}>播放队列是空的。在专辑里点一首歌，或用“下一首播放”加入。</p>;
  return (
    <div className={styles.scroll}>
      {/* Count and play order as icons; the words are tooltips and screen-reader text. */}
      <ul className={styles.note} aria-label="队列状态">
        <li title={`共 ${player.queue.length} 首`}><Icon name="list" size={15} /><span className="num">{player.queue.length}</span><span className="sr-only">首</span></li>
        {player.shuffle && <li title="随机顺序"><Icon name="shuffle" size={15} /><span className="sr-only">随机顺序</span></li>}
        {player.repeat !== 'off' && (
          <li title={player.repeat === 'all' ? '全部循环' : '单曲循环'}>
            <Icon name={player.repeat === 'all' ? 'repeat' : 'repeatOne'} size={15} /><span className="sr-only">{player.repeat === 'all' ? '全部循环' : '单曲循环'}</span>
          </li>
        )}
      </ul>
      <p id={hintId} className="sr-only">用上下方向键移动这一首；在列表里也可以按 Alt 加上下方向键。</p>
      <ol ref={listRef} className={styles.list} data-dragging={drag ? 'true' : 'false'} data-reduced={reduced ? 'true' : 'false'} aria-label="播放队列">
        {entries.map((entry, i) => {
          const track = index.tracksById.get(entry.trackId);
          const album = track ? index.albumsById.get(track.albumId) : undefined;
          const isCurrent = entry.id === player.currentEntryId;
          const played = current >= 0 && player.queue.findIndex(e => e.id === entry.id) < current;
          const badge = track ? versionBadge(track.versionKind, track.versionLabel) : null;
          const dragging = drag?.id === entry.id;
          const offset = dragging ? drag!.dy : shift(i);
          const title = track?.title ?? '未知曲目';
          return (
            <li key={entry.id} data-entry-id={entry.id} className={styles.item} data-played={played ? 'true' : 'false'}
              data-current={isCurrent ? 'true' : 'false'} data-dragging={dragging ? 'true' : undefined}
              style={offset ? { transform: `translateY(${offset}px)` } : undefined}
              onKeyDown={event => onRowKey(event, entry, i, isCurrent)}>
              <button type="button" data-grip className={styles.grip} aria-label={`移动 ${title}`} aria-describedby={hintId}
                title="拖动调整顺序" disabled={!online || player.queue.length < 2}
                onPointerDown={event => onGripDown(event, entry, i)} onPointerMove={onGripMove}
                onPointerUp={event => onGripUp(event, entry)} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}
                onKeyDown={event => onGripKey(event, entry, i)}>
                <Icon name="grip" size={16} />
              </button>
              <button type="button" className={styles.row} data-current={isCurrent ? 'true' : 'false'}
                disabled={!online || !track?.available} aria-current={isCurrent ? 'true' : undefined}
                aria-label={`播放 ${title}${badge ? '（' + badge + '）' : ''}，第 ${i + 1} 首`}
                onClick={() => run({ type: 'playQueueEntry', entryId: entry.id }, { slot: 'queue', key: 'queue-play' })}>
                {album ? <Cover albumId={album.id} title={album.title} cover={album.cover} className={styles.thumb} showTitleOnPlaceholder={false} /> : <span />}
                <span className={styles.text}>
                  <span className={styles.title} lang={langHint(track?.title, track?.language, album?.language)}>
                    {title}{badge && <span className="cdp-badge">{badge}</span>}
                  </span>
                  <span className={styles.sub} lang={langHint(track?.artistCredit, null, album?.language)}>{track?.artistCredit}</span>
                </span>
                {isCurrent ? <span className={styles.now}><span className="cdp-eq" data-paused={player.status !== 'playing' ? 'true' : 'false'} aria-hidden="true"><i /><i /><i /></span></span>
                  : <span className={`${styles.time} num`}>{track ? formatClock(track.durationMs) : ''}</span>}
              </button>
              <Menu label={`更多：${title}`} tooltip="更多操作" buttonClassName={`cdp-icon-btn cdp-icon-btn--sm ${styles.more}`} items={[
                { label: '播放这一首', icon: 'play', disabled: !online || !track?.available || isCurrent,
                  onSelect: () => void run({ type: 'playQueueEntry', entryId: entry.id }, { slot: 'queue', key: 'queue-play' }) },
                { label: '下一首播放', icon: 'queueNext', disabled: !online || isCurrent || playNextIndex(player, i) === i,
                  onSelect: () => void move(entry, playNextIndex(player, i)) },
                { label: '上移', icon: 'arrowUp', disabled: !online || i === 0, onSelect: () => void move(entry, i - 1) },
                { label: '下移', icon: 'arrowDown', disabled: !online || i === entries.length - 1, onSelect: () => void move(entry, i + 1) },
                { kind: 'separator' },
                { label: '从队列移除', icon: 'close', disabled: !online || isCurrent, hint: isCurrent ? '正在播放的这一首不能移除' : undefined,
                  onSelect: () => remove(entry) },
              ]} />
            </li>
          );
        })}
      </ol>
      {ended && (
        <div className={styles.ended} role="status">
          <span>队列已经播完。</span>
          <button type="button" className="cdp-btn cdp-btn--quiet" disabled={!online}
            onClick={() => run({ type: 'playQueueEntry', entryId: player.queue[0].id }, { slot: 'queue', key: 'queue-replay' })}>
            <Icon name="refresh" size={15} /> 从头播放
          </button>
        </div>
      )}
      <p className="sr-only" aria-live="polite">{announce}</p>
      <InlineError slot="queue" />
    </div>
  );
}
