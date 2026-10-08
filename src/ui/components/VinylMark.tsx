import { useId } from 'react';
import type { CSSProperties } from 'react';
import styles from './VinylMark.module.css';

/**
 * The collection mark: a 12-inch record seen from above. Lacquer with two bands of grooves,
 * light catching the grooves in two opposite wedges (the light stays put), and a label in the
 * accent colour. While music plays the label turns at 33⅓ rpm; its print shows the motion.
 * The label is its own element so the turn is a compositor-only transform (no repaint per frame).
 */
export function VinylMark({ spinning, size = 32 }: { spinning: boolean; size?: number }) {
  const id = 'vinyl' + useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const sheen = `${id}-sheen`, lacquer = `${id}-lacquer`, gloss = `${id}-gloss`, soft = `${id}-soft`;
  const grooves = [7.4, 8.2, 9.0, 9.8, 10.6, 11.3, 12.6, 13.3, 14.0, 14.7];
  return (
    <span className={styles.mark} data-spinning={spinning ? 'true' : 'false'} style={{ '--size': `${size}px` } as CSSProperties}
      aria-hidden="true">
      <svg className={styles.disc} viewBox="0 0 32 32" focusable="false">
        <defs>
          <radialGradient id={lacquer} cx="16" cy="16" r="15.5" gradientUnits="userSpaceOnUse">
            <stop offset="0.38" style={{ stopColor: 'var(--vinyl)' }} stopOpacity="0.92" />
            <stop offset="0.86" style={{ stopColor: 'var(--vinyl)' }} />
            <stop offset="1" style={{ stopColor: 'var(--vinyl)' }} />
          </radialGradient>
          <radialGradient id={sheen} cx="16" cy="16" r="15.5" gradientUnits="userSpaceOnUse">
            <stop offset="0.4" stopColor="#fff" stopOpacity="0" />
            <stop offset="0.66" stopColor="#fff" stopOpacity="0.34" />
            <stop offset="0.95" stopColor="#fff" stopOpacity="0.12" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
          <filter id={soft} x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="0.55" /></filter>
        </defs>
        <circle cx="16" cy="16" r="15.5" fill={`url(#${lacquer})`} />
        <g fill="none" stroke="#fff" strokeOpacity="0.075" strokeWidth="0.32">
          {grooves.map(r => <circle key={r} cx="16" cy="16" r={r} />)}
        </g>
        {/* Light on the grooves: two opposite wedges, fixed while the record turns. */}
        <g filter={`url(#${soft})`} fill={`url(#${sheen})`}>
          <path d="M16 16 L23.75 2.58 A15.5 15.5 0 0 1 29.43 8.25 Z" />
          <path d="M16 16 L8.25 29.42 A15.5 15.5 0 0 1 2.57 23.75 Z" />
        </g>
        <circle cx="16" cy="16" r="15.3" fill="none" style={{ stroke: 'var(--vinyl-edge)' }} strokeWidth="0.5" />
      </svg>
      <svg className={styles.label} viewBox="10 10 12 12" focusable="false">
        <defs>
          <radialGradient id={gloss} cx="13.5" cy="12.5" r="8" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#fff" stopOpacity="0.42" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="16" cy="16" r="5.7" style={{ fill: 'var(--accent-fill)' }} />
        <circle cx="16" cy="16" r="5.7" fill={`url(#${gloss})`} />
        <path d="M12.6 14.2 A3.9 3.9 0 0 1 19.4 14.2" fill="none" style={{ stroke: 'var(--on-accent)' }} strokeOpacity="0.62" strokeWidth="0.7" strokeLinecap="round" />
        <path d="M13.9 19.1 A3.9 3.9 0 0 0 18.1 19.1" fill="none" style={{ stroke: 'var(--on-accent)' }} strokeOpacity="0.42" strokeWidth="0.55" strokeLinecap="round" />
        <circle cx="16" cy="16" r="0.95" style={{ fill: 'var(--paper)' }} />
      </svg>
    </span>
  );
}
