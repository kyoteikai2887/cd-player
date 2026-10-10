import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { CoverImage } from '../../contracts/player.ts';

/**
 * The album's cover, blurred into coloured light (R2.1). The caller positions and tints it; this
 * only supplies the image and drops it quietly if the bridge URL fails, leaving the caller's own
 * background (the theme's pools) in place. Decorative.
 */
export function CoverLight({ cover, className, style, layers = 1 }: {
  cover: CoverImage | null; className?: string; style?: CSSProperties;
  /** Copies of the image, for a caller that lights a surface in more than one way (the stage, V1.1). */
  layers?: number;
}) {
  const url = cover?.thumbUrl ?? null;
  const [failed, setFailed] = useState<string | null>(null);
  const shown = !!url && failed !== url;
  return (
    <div className={className} style={style} aria-hidden="true">
      {shown && Array.from({ length: layers }, (_, i) => (
        <img key={i} src={url} alt="" draggable={false} decoding="async" data-layer={layers > 1 ? i : undefined} onError={() => setFailed(url)} />
      ))}
    </div>
  );
}
