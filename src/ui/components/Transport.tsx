import { useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { RepeatMode } from '../../contracts/player.ts';
import { useActions } from '../lib/actions.tsx';
import { queueEnded } from '../lib/queue.ts';
import { formatClock } from '../lib/clock.ts';
import { usePlayer, useSurface } from '../lib/surface.tsx';
import { useProgressFrames, useRenderPos } from '../lib/useClock.ts';
import { Icon } from './Icon.tsx';
import styles from './Transport.module.css';

/** Play/pause with a delayed busy ring for buffering (avoids flicker). */
export function PlayButton({ size = 'md', slot = 'transport' as const }: { size?: 'md' | 'sm' | 'xs'; slot?: 'transport' | 'mini' }) {
  const player = usePlayer();
  const { online } = useSurface();
  const { run, isPending } = useActions();
  const playing = player.status === 'playing';
  const buffering = player.status === 'buffering';
  const busy = isPending('togglePlayback') || buffering;
  // At the end of the queue, play means "again from the top" rather than resuming at the very end.
  const ended = queueEnded(player);
  const label = playing ? '暂停' : ended ? '从头播放' : '播放';
  const iconSize = size === 'md' ? 22 : size === 'sm' ? 18 : 15;
  return (
    <button type="button" className={`cdp-play ${size !== 'md' ? 'cdp-play--' + size : ''} ${styles.play}`}
      aria-label={label} title={ended ? '队列已播完，从头播放' : label} disabled={!online} data-busy={busy ? 'true' : 'false'}
      onClick={() => run(ended ? { type: 'playQueueEntry', entryId: player.queue[0].id } : { type: 'togglePlayback' }, { slot, key: 'togglePlayback' })}>
      <Icon name={playing || buffering ? 'pause' : 'play'} size={iconSize} />
      {busy && <span className={styles.busyRing} aria-hidden="true" />}
    </button>
  );
}

export function SkipButton({ dir, size = 'md', slot = 'transport' }: { dir: 'prev' | 'next'; size?: 'md' | 'sm'; slot?: 'transport' | 'mini' }) {
  const player = usePlayer();
  const { online } = useSurface();
  const { run } = useActions();
  return (
    <button type="button" className={`cdp-icon-btn ${size === 'md' ? 'cdp-icon-btn--lg cdp-icon-btn--glass' : ''}`}
      aria-label={dir === 'prev' ? '上一首' : '下一首'} title={dir === 'prev' ? '上一首' : '下一首'} disabled={!online || !player.queue.length}
      onClick={() => run({ type: dir === 'prev' ? 'previous' : 'next' }, { slot })}>
      <Icon name={dir} size={size === 'md' ? 22 : 18} />
    </button>
  );
}

const NEXT_REPEAT: Record<RepeatMode, RepeatMode> = { off: 'all', all: 'one', one: 'off' };
const REPEAT_LABEL: Record<RepeatMode, string> = { off: '循环：关闭', all: '循环：全部', one: '循环：单曲' };

export function ShuffleButton() {
  const player = usePlayer();
  const { online } = useSurface();
  const { run } = useActions();
  return (
    <button type="button" className="cdp-icon-btn" aria-label="随机播放" aria-pressed={player.shuffle} disabled={!online}
      title={player.shuffle ? '随机播放：开' : '随机播放：关'}
      onClick={() => run({ type: 'setShuffle', shuffle: !player.shuffle }, { slot: 'transport' })}>
      <Icon name="shuffle" />
    </button>
  );
}

export function RepeatButton() {
  const player = usePlayer();
  const { online } = useSurface();
  const { run } = useActions();
  return (
    <button type="button" className="cdp-icon-btn" aria-label={REPEAT_LABEL[player.repeat]} aria-pressed={player.repeat !== 'off'}
      title={REPEAT_LABEL[player.repeat]} disabled={!online}
      onClick={() => run({ type: 'setRepeat', repeat: NEXT_REPEAT[player.repeat] }, { slot: 'transport' })}>
      <Icon name={player.repeat === 'one' ? 'repeatOne' : 'repeat'} />
    </button>
  );
}

interface SeekProps {
  /** Local preview while scrubbing; shared with lyrics so they follow the thumb. */
  preview: number | null;
  onPreview: (value: number | null) => void;
  variant?: 'full' | 'line';
  showTimes?: boolean;
}

/**
 * Seek bar. Fill and thumb are moved per frame with transforms (no React renders); the native range
 * input underneath gives keyboard and screen-reader access. Commits a single seek on release.
 */
export function SeekBar({ preview, onPreview, variant = 'full', showTimes = true }: SeekProps) {
  const player = usePlayer();
  const { visible, online } = useSurface();
  const { run } = useActions();
  const fillRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  useProgressFrames(fraction => {
    if (fillRef.current) fillRef.current.style.transform = `scaleX(${fraction})`;
    if (thumbRef.current) thumbRef.current.style.transform = `translateX(${fraction * 100}%)`;
  }, player, visible, preview);
  const position = useRenderPos(player, visible, preview);
  const duration = Math.max(0, player.durationMs);
  const fraction = duration ? Math.min(1, Math.max(0, position / duration)) : 0;
  const disabled = !online || !player.currentTrackId || !duration;

  const commit = async (value: number) => {
    onPreview(value);
    await run({ type: 'seek', positionMs: Math.round(value) }, { slot: 'transport', key: 'seek' });
    onPreview(null);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const step = event.shiftKey ? 15000 : 5000;
    const map: Record<string, number> = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step };
    let target: number | null = null;
    if (event.key in map) target = position + map[event.key];
    if (event.key === 'Home') target = 0;
    if (event.key === 'End') target = Math.max(0, duration - 1000);
    if (target === null) return;
    event.preventDefault();
    void commit(Math.min(duration, Math.max(0, target)));
  };

  return (
    <div className={styles.seek} data-variant={variant} data-dragging={dragging ? 'true' : 'false'}>
      {showTimes && variant === 'full' && <span className={`${styles.time} num`}>{formatClock(position)}</span>}
      <div className={styles.track}>
        <div className={styles.rail}><div ref={fillRef} className={styles.fill} style={{ transform: `scaleX(${fraction})` }} /></div>
        <div ref={thumbRef} className={styles.thumbTrack} style={{ transform: `translateX(${fraction * 100}%)` }} aria-hidden="true">
          <div className={styles.thumb} />
        </div>
        <input className={styles.input} type="range" min={0} max={duration || 1} step={1000}
          value={Math.min(duration || 1, Math.max(0, Math.round(position)))} disabled={disabled}
          aria-label="播放进度" aria-valuetext={`${formatClock(position)} / ${formatClock(duration)}`}
          onPointerDown={() => setDragging(true)}
          onPointerUp={event => { setDragging(false); void commit(Number((event.target as HTMLInputElement).value)); }}
          onPointerCancel={() => { setDragging(false); onPreview(null); }}
          onChange={event => { if (dragging) onPreview(Number(event.target.value)); }}
          onKeyDown={onKeyDown} />
      </div>
      {showTimes && variant === 'full' && <span className={`${styles.time} ${styles.timeEnd} num`}>{formatClock(duration)}</span>}
    </div>
  );
}

/** Mute toggle + level. Sends at most ~8 updates/s while dragging; the core owns the gain curve. */
export function VolumeControl({ compact = false }: { compact?: boolean }) {
  const player = usePlayer();
  const { online } = useSurface();
  const { run } = useActions();
  const [local, setLocal] = useState<number | null>(null);
  const last = useRef(0);
  const value = local ?? player.volume;
  const muted = player.muted || value === 0;
  const send = (volume: number, force = false) => {
    const t = Date.now();
    if (!force && t - last.current < 120) return;
    last.current = t;
    void run({ type: 'setVolume', volume }, { slot: 'transport', key: 'setVolume' });
  };
  return (
    <div className={styles.volume} data-compact={compact ? 'true' : 'false'}>
      <button type="button" className="cdp-icon-btn cdp-icon-btn--sm" aria-label={player.muted ? '取消静音' : '静音'}
        title={player.muted ? '取消静音' : '静音'} aria-pressed={player.muted} disabled={!online}
        onClick={() => run({ type: 'setMuted', muted: !player.muted }, { slot: 'transport' })}>
        <Icon name={muted ? 'volumeMute' : value < 0.45 ? 'volumeLow' : 'volume'} size={18} />
      </button>
      <input className="cdp-range" type="range" min={0} max={1} step={0.01} value={value} disabled={!online}
        aria-label="音量" aria-valuetext={`${Math.round(value * 100)}%`}
        style={{ ['--fill' as string]: String(player.muted ? 0 : value) }}
        onChange={event => { const v = Number(event.target.value); setLocal(v); send(v); }}
        onPointerUp={event => { send(Number((event.target as HTMLInputElement).value), true); setLocal(null); }}
        onKeyUp={event => { send(Number((event.target as HTMLInputElement).value), true); setLocal(null); }} />
    </div>
  );
}
