import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useAudioVisualizationSource } from '../lib/audioVisualization.ts';
import { useMediaQuery } from '../lib/env.ts';
import { useSurface } from '../lib/surface.tsx';
import {
  createVizState, edgePath, edgeWeight, EDGES, FIELD, fieldWidth, litCells, LIVE_INTERVAL_MS, PITCH, QUIET_INTERVAL_MS, resetViz, RISE, stepViz, TOKENS, tokenX,
} from '../lib/stageViz.ts';
import styles from './AttentionField.module.css';

/**
 * The stage's music field (Claude, V1.2; the arithmetic is lib/stageViz.ts).
 *
 * Etched in the glass, always: the line, the 24 token seats, their columns of cells (a small
 * matrix) and every arc, as faint grooves. Lit, only by the real signal: each token's column fills
 * cell by cell with its band, rising and falling, a held cell marks its recent peak, and the arcs
 * between sounding tokens take the accent. With no source, an unavailable one, or the music
 * paused, muted, buffering or stopped, only the etching remains, still.
 *
 * The loop is this component's own: it reads the source at most ~24 times a second (4 while
 * quiet or with reduced motion) and writes the SVG attributes directly, so nothing else renders.
 * While quiet or reduced nothing moves between reads, so it waits for the next read on a timer and
 * asks for no frames in between (round 2: a paused stage costs next to nothing).
 * It runs only while the surface is visible, the page is shown, the field is on screen and
 * enabled, and stops on unmount. Coming back clears what was shown and reads the music afresh.
 */
export const AttentionField = memo(function AttentionField({ className }: { className?: string }) {
  const source = useAudioVisualizationSource();
  const { visible, reduced } = useSurface();
  const forced = useMediaQuery('(forced-colors: active)');
  const rootRef = useRef<SVGSVGElement>(null);
  const barsRef = useRef<(SVGLineElement | null)[]>([]);
  const peaksRef = useRef<(SVGRectElement | null)[]>([]);
  const seatsRef = useRef<(SVGCircleElement | null)[]>([]);
  const arcsRef = useRef<(SVGPathElement | null)[]>([]);
  // The drawing's width follows its box within narrow bounds (lib/stageViz.ts fieldWidth); only a resize re-renders.
  const [width, setWidth] = useState<number>(FIELD.w);
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(entries => {
      const box = entries[entries.length - 1].contentRect;
      setWidth(fieldWidth(box.width, box.height));
    });
    ro.observe(root);
    return () => ro.disconnect();
  }, []);
  const paths = useMemo(() => EDGES.map(([a, b]) => edgePath(a, b, width)), [width]);
  const xs = useMemo(() => Array.from({ length: TOKENS }, (_, i) => tokenX(i, width)), [width]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const state = createVizState();
    const draw = () => {
      for (let i = 0; i < TOKENS; i++) {
        const v = state.value[i], n = litCells(v);
        const bar = barsRef.current[i];
        // The column is a dashed line from the base: its length is whole cells, so the dashes are the cells.
        if (bar) bar.setAttribute('y2', String(FIELD.baseline - (n ? n * PITCH - FIELD.gap : 0)));
        const peak = peaksRef.current[i];
        if (peak) {
          const p = litCells(state.peak[i]);
          const shown = p > n;
          if (shown) peak.setAttribute('y', String(FIELD.baseline - p * PITCH + FIELD.gap));
          peak.style.opacity = shown ? '1' : '0';
        }
        const seat = seatsRef.current[i];
        if (seat) seat.style.opacity = Math.min(1, v * 1.4).toFixed(3);
      }
      for (let e = 0; e < EDGES.length; e++) {
        const arc = arcsRef.current[e];
        if (arc) arc.style.opacity = edgeWeight(state, EDGES[e][0], EDGES[e][1]).toFixed(3);
      }
    };
    const rest = () => { resetViz(state); draw(); root.dataset.state = source ? 'idle' : 'unavailable'; };
    rest();
    // Nothing to read, nothing to show, or not shown: the etching alone, and no loop at all.
    if (!source || !visible || forced) return;

    let raf = 0, last = 0, inView = true, pageShown = typeof document === 'undefined' || document.visibilityState !== 'hidden';
    let quiet = true, timer: ReturnType<typeof setTimeout> | null = null;
    const interval = () => (reduced || quiet ? QUIET_INTERVAL_MS : LIVE_INTERVAL_MS);
    const tick = (now: number) => {
      raf = 0;
      if (!inView || !pageShown) return;
      if (!last || now - last >= interval() - 2) {
        let frame = null;
        try { frame = source.read(); } catch { frame = null; }
        const moving = stepViz(state, frame, last ? now - last : 0, reduced);
        last = now;
        quiet = !moving && frame?.status !== 'live';
        root.dataset.state = frame?.status ?? 'unavailable';
        draw();
      }
      // Quiet or reduced: wait out most of the interval off the frame loop, then take the next frame.
      const wait = interval() - (now - last) - 12;
      if ((reduced || quiet) && wait > 0) timer = setTimeout(() => { timer = null; raf = requestAnimationFrame(tick); }, wait);
      else raf = requestAnimationFrame(tick);
    };
    const start = () => { if (!raf && !timer && inView && pageShown) { resetViz(state); last = 0; quiet = true; raf = requestAnimationFrame(tick); } };
    const stop = () => { if (raf) cancelAnimationFrame(raf); if (timer) clearTimeout(timer); raf = 0; timer = null; };
    const onPage = () => {
      pageShown = document.visibilityState !== 'hidden';
      if (pageShown) start(); else { stop(); rest(); }
    };
    document.addEventListener('visibilitychange', onPage);
    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver === 'function') {
      io = new IntersectionObserver(entries => {
        const entry = entries[entries.length - 1];
        inView = entry.isIntersecting;
        if (inView) start(); else { stop(); rest(); }
      });
      io.observe(root);
    }
    start();
    return () => { stop(); io?.disconnect(); document.removeEventListener('visibilitychange', onPage); };
  }, [source, visible, reduced, forced]);

  const cellW = 4.2;
  const dash = `${FIELD.cell} ${FIELD.gap}`;
  const slots = xs.map(x => `M${x.toFixed(2)} ${FIELD.baseline}V${FIELD.baseline - RISE}`).join('');
  return (
    <svg ref={rootRef} className={`${styles.field} ${className ?? ''}`} viewBox={`0 0 ${width} ${FIELD.h}`}
      preserveAspectRatio="xMinYMax meet" aria-hidden="true" focusable="false" data-state="idle" data-reduced={reduced ? 'true' : 'false'}>
      {/* The etching: grooves cut once, the same in every state. */}
      <g>
        <path className={styles.grooveLit} d={paths.join('')} />
        <path className={styles.groove} d={paths.join('')} />
        {/* Round 2: each cell is cut like the grooves, a lit lower edge under a smooth floor, so a quiet field keeps its whole shape. */}
        <path className={styles.slotsLit} strokeWidth={cellW} strokeDasharray={dash} d={slots} />
        <path className={styles.slots} strokeWidth={cellW} strokeDasharray={dash} d={slots} />
        <line className={styles.baseline} x1={FIELD.padX} x2={width - FIELD.padX} y1={FIELD.baseline + 5} y2={FIELD.baseline + 5} />
        {xs.map((x, i) => <circle key={i} className={styles.seatRing} cx={x} cy={FIELD.baseline + 5} r={2.1} />)}
      </g>
      {/* The light: only what the signal sets. */}
      <g className={styles.light}>
        {paths.map((d, e) => <path key={e} ref={el => { arcsRef.current[e] = el; }} className={styles.arc} d={d} style={{ opacity: 0 }} />)}
        {xs.map((x, i) => (
          <g key={i}>
            <line ref={el => { barsRef.current[i] = el; }} className={styles.bar} x1={x} x2={x} y1={FIELD.baseline} y2={FIELD.baseline}
              strokeWidth={cellW} strokeDasharray={dash} />
            <rect ref={el => { peaksRef.current[i] = el; }} className={styles.peak} x={x - cellW / 2} y={FIELD.baseline} width={cellW} height={FIELD.cell} style={{ opacity: 0 }} />
            <circle ref={el => { seatsRef.current[i] = el; }} className={styles.seat} cx={x} cy={FIELD.baseline + 5} r={2.1} style={{ opacity: 0 }} />
          </g>
        ))}
      </g>
    </svg>
  );
});
