import { useState } from 'react';
import { Cover } from '../components/Cover.tsx';
import { Frost, useFrostStyle } from '../components/Frost.tsx';
import { Icon } from '../components/Icon.tsx';
import { PlayButton, SeekBar, SkipButton, VolumeControl } from '../components/Transport.tsx';
import { InlineError } from '../lib/actions.tsx';
import { formatClock } from '../lib/clock.ts';
import { usePlayer, useSurface } from '../lib/surface.tsx';
import { lightFlows } from '../lib/trailLight.ts';
import { useRenderPos } from '../lib/useClock.ts';
import { langHint, versionBadge } from '../lib/text.ts';
import styles from './PlayerCapsule.module.css';

/**
 * Floating transport for the shelf and album pages. Opens the now-playing view. Frosted like the
 * stage and the mini card, in the colours of the album that is playing, over the whole bar
 * (lib/frost.ts, two layers of light); a little of the shelf shows through it, blurred, so
 * scrolling reads as sliding beneath frosted glass.
 */
export function PlayerCapsule({ onOpenNowPlaying }: { onOpenNowPlaying(): void }) {
  const { currentTrack, currentAlbum } = useSurface();
  const [preview, setPreview] = useState<number | null>(null);
  const lang = langHint(currentTrack?.title, currentTrack?.language, currentAlbum?.language);
  const badge = currentTrack ? versionBadge(currentTrack.versionKind, currentTrack.versionLabel) : null;
  const frost = useFrostStyle('capsule');
  return (
    <div className={styles.dock}>
      <InlineError slot="transport" className={styles.error} />
      <div className={`${styles.capsule} glass glass--frost glass--frost-see`} style={frost} role="region" aria-label="播放控制">
        <Frost cover={currentAlbum?.cover ?? null} className={styles.light} layers={2} />
        <button type="button" className={styles.now} onClick={onOpenNowPlaying} disabled={!currentTrack}
          aria-label={currentTrack ? `打开正在播放：${currentTrack.title}` : '暂无播放'}>
          {currentAlbum ? (
            <Cover albumId={currentAlbum.id} title={currentAlbum.title} cover={currentAlbum.cover} className={styles.thumb} showTitleOnPlaceholder={false} />
          ) : <span className={styles.thumbEmpty}><Icon name="disc" size={22} /></span>}
          <span className={styles.text}>
            <span className={styles.title} lang={lang}>{currentTrack?.title ?? '队列已就绪'}
              {badge && <span className="cdp-badge">{badge}</span>}
            </span>
            <span className={styles.sub} lang={langHint(currentTrack?.artistCredit, null, currentAlbum?.language)}>
              {currentTrack ? currentTrack.artistCredit : '按播放键从队列开始'}
            </span>
          </span>
        </button>
        <div className={styles.controls}>
          <SkipButton dir="prev" size="sm" />
          <PlayButton size="sm" />
          <SkipButton dir="next" size="sm" />
        </div>
        <div className={styles.side}>
          <CapsuleTime preview={preview} />
          <VolumeControl compact />
        </div>
        <div className={styles.line}><SeekBar preview={preview} onPreview={setPreview} variant="line" /></div>
        <CapsuleAmbient />
      </div>
    </div>
  );
}

/**
 * V1.2: the bar's share of the ambient light, a short strip in its upper edge above the transport.
 * Steady; brighter while the music is heard. Round 2: it follows the same rule as the light in the
 * stage's star trails (lib/trailLight.ts), so paused, buffering, muted or silent both dim together.
 */
function CapsuleAmbient() {
  const player = usePlayer();
  const on = lightFlows(player);
  return <span className={styles.ambient} aria-hidden="true" data-ambient="capsule" data-on={on ? 'true' : 'false'} />;
}

function CapsuleTime({ preview }: { preview: number | null }) {
  const player = usePlayer();
  const { visible } = useSurface();
  const position = useRenderPos(player, visible, preview);
  if (!player.currentTrackId) return null;
  return <span className={`${styles.time} num`}>{formatClock(position)}<span> / {formatClock(player.durationMs)}</span></span>;
}
