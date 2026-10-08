import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { CoverImage } from '../../contracts/player.ts';

/**
 * The album's cover, blurred into coloured light (R2.1). The caller positions and tints it; this
 * only supplies the image and drops it quietly if the bridge URL fails, leaving the caller's own
 * background (the theme's pools) in place. Decorative.
 */
export function CoverLight({ cover, className, style }: { cover: CoverImage | null; className?: string; style?: CSSProperties }) {
  const url = cover?.thumbUrl ?? null;
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <div className={className} style={style} aria-hidden="true">
      {url && failed !== url && <img src={url} alt="" draggable={false} decoding="async" onError={() => setFailed(url)} />}
    </div>
  );
}
