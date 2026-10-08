import { memo } from 'react';
import type { CSSProperties } from 'react';
import type { CoverImage } from '../../contracts/player.ts';
import { Cover } from './Cover.tsx';
import styles from './DiscArt.module.css';

/**
 * A CD with the album's art printed on its label side, as most character-song and soundtrack
 * discs are: centre hole, clear plastic hub, printed area, a thin silver rim and the light
 * that catches it. The print turns while the disc plays (compositor-only rotation); the light
 * stays put. Decorative: the album is always named next to it. Memoised: the playback state
 * around it changes every tick, the disc only when it starts or stops turning.
 */
export const DiscArt = memo(function DiscArt({ albumId, title, cover, spinning = false, className, style }: {
  albumId: string; title: string; cover: CoverImage | null; spinning?: boolean; className?: string; style?: CSSProperties;
}) {
  return (
    <span className={[styles.disc, className].filter(Boolean).join(' ')} data-spinning={spinning ? 'true' : 'false'} style={style} aria-hidden="true">
      <span className={styles.print}>
        <Cover albumId={albumId} title={title} cover={cover} className={styles.art} showTitleOnPlaceholder={false} />
      </span>
      <span className={styles.hub} />
      <span className={styles.light} />
    </span>
  );
});
