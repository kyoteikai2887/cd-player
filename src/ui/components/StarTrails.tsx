import { memo } from 'react';
import styles from './StarTrails.module.css';

/**
 * Star trails etched into the stage glass (Claude, V1.2): a long exposure of the night sky turning
 * round a pole high above the memorial etching, the rings widening out across the stage towards
 * the album. Cut, not printed: each trail is
 * a groove with a smooth floor (the frost's grain is covered) between two thin walls, the upper
 * one shaded and the lower one lit, as in the memorial etching. A handful of trails catch a
 * little of the accent, like the brighter stars in a real exposure.
 *
 * Still image, no animation, no pointer. Drawn once at module load from a fixed seed, so every
 * window and every start shows the same sky. The pole sits at (CX, CY) of the SVG, and the CSS
 * places that point (--sky-cx, --sky-cy).
 */
export const TRAILS_BOX = { w: 2600, h: 1400, cx: 1300, cy: 700 } as const;

/** Small deterministic PRNG (mulberry32), so the sky is the same everywhere. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Trail { r: number; a0: number; a1: number; bright: boolean }

/** The sky: trails at even-ish spacing outward from the pole, each a short arc of a few tens of degrees. */
export function makeTrails(seed = 20261012): Trail[] {
  const rand = rng(seed);
  const trails: Trail[] = [];
  // From a few rings round the pole to past the far end of the widest stage, a little denser near it.
  for (let r = 18; r < 1260; r += 6 + rand() * 8 + r * 0.006) {
    const pieces = r < 120 ? 1 : rand() < 0.4 ? 2 : 1;
    for (let k = 0; k < pieces; k++) {
      // Near the pole a trail is a good part of a turn; far out, a short stretch of a huge circle.
      const span = (0.16 + rand() * 0.55) * (r < 160 ? 2.2 : r < 420 ? 1.3 : 0.8);
      // All round the pole, a little more often on the side facing the album (to the left and down).
      const mid = Math.PI * (0.25 + rand() * 1.5) + (rand() - 0.5) * Math.PI * 0.5;
      trails.push({ r: Math.round(r * 10) / 10, a0: mid - span / 2, a1: mid + span / 2, bright: rand() < 0.07 });
    }
  }
  return trails;
}

function arc({ r, a0, a1 }: Trail): string {
  const { cx, cy } = TRAILS_BOX;
  const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
  return `M${x0.toFixed(1)} ${y0.toFixed(1)}A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
}

/** The sky, cut once; components/TrailLight.tsx runs its light along a few of these. */
export const TRAILS = makeTrails();
const ALL = TRAILS.map(arc).join('');
const BRIGHT = TRAILS.filter(t => t.bright).map(arc).join('');

export const StarTrails = memo(function StarTrails({ className }: { className?: string }) {
  const { w, h } = TRAILS_BOX;
  return (
    <span className={`${styles.sky} ${className ?? ''}`} aria-hidden="true" data-etch="star-trails">
      <svg className={styles.svg} width={w} height={h} viewBox={`0 0 ${w} ${h}`} focusable="false">
        <path className={styles.floor} d={ALL} />
        <path className={styles.shade} d={ALL} />
        <path className={styles.lit} d={ALL} />
        <path className={styles.bright} d={BRIGHT} />
      </svg>
    </span>
  );
});
