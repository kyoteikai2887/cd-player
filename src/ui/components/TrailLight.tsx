import { memo, useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useMediaQuery } from '../lib/env.ts';
import { usePlayer, useSurface } from '../lib/surface.tsx';
import { chooseLightArcs, lightClipPath, lightFlows, lightMeteor, lightPath, lightPhase, lightSchedule } from '../lib/trailLight.ts';
import type { Box, KeepItem, KeepKind, LightArc, LightWindow, Point } from '../lib/trailLight.ts';
import { TRAILS, TRAILS_BOX } from './StarTrails.tsx';
import styles from './TrailLight.module.css';

interface Layout { w: number; h: number; pole: Point; arcs: LightArc[] }

/**
 * The stage's cold light (Claude, V1.2 round 2; the arithmetic is lib/trailLight.ts). Starlight
 * flows along a few of the etched star trails round the pole. The host marks what stands in front
 * of the trails with `data-keep-clear`: a box by default; "text" for the lines of text actually
 * set; "before" for the track, the facts, the buttons and the music field; "start" for the text
 * column (the cover and its disc are before it); "etch" for the memorial etching. This component
 * measures them with the stage and the sky, and measures again only when one of them changes size.
 * The rings that carry light are chosen as in round 2 (lib/trailLight.ts keepShapes); where each
 * light shows is where its ring's trails are seen (lightGlass, round 4).
 *
 * Each light is one ring of the sky (lib/trailLight.ts LightArc): a meteor turning round the pole,
 * seen through a fixed window on every stretch of that ring that is seen, so it crosses the ring's
 * other trail and the glass beyond whatever cuts one in two, unseen in between. Round 4: it turns a
 * whole turn each cycle, at an even pace while any of it is seen and quickly where none of it is
 * (lightSchedule, as the animation's linear() easing); a small glow rides on its head. The light
 * wears the sky's own mask (Spotlight.module.css .flow), so it fades where the trails fade.
 *
 * The motion is a CSS animation of one shape per light (no frame loop of its own, nothing re-renders
 * while it runs). It runs while the music is heard; paused, buffering, muted or silent, the light
 * holds where it is and dims; with reduced motion it is still; while the window or page is hidden
 * or the stage is off screen it is paused, so it costs nothing. Hidden in high contrast.
 *
 * Markers, for checks from outside: each light is a `g[data-trail]` (its main stretch's trail
 * index) with `data-ring` (its radius, px) and `data-windows` (every stretch it shows in, in the
 * order it meets them, as `trail:to:from` in radians, space-separated); its `[data-light-path]`
 * draws those stretches (one subpath each), its clip path is their windows, its `[data-meteor]` is
 * the turning shape and `[data-glow]` the glow on its head. The root's `data-lights` counts the lights.
 */
export const TrailLight = memo(function TrailLight({ className, layoutKey }: { className?: string; layoutKey?: string }) {
  const player = usePlayer();
  const { visible, reduced } = useSurface();
  const forced = useMediaQuery('(forced-colors: active)');
  const rootRef = useRef<SVGSVGElement>(null);
  const id = useId().replace(/[^a-z0-9_-]/gi, '');
  const [layout, setLayout] = useState<Layout | null>(null);
  const [inView, setInView] = useState(true);
  const [pageShown, setPageShown] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');

  // Measure the stage, the sky's pole and the boxes to keep clear of; again whenever one of them resizes.
  useEffect(() => {
    const root = rootRef.current, stage = root?.parentElement;
    if (!root || !stage || forced) return;
    const measure = () => {
      const next = measureStage(stage);
      setLayout(prev => (sameLayout(prev, next) ? prev : next));
    };
    if (typeof ResizeObserver !== 'function') { measure(); return; }
    let raf = 0, live = true;
    const soon = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; measure(); }); };
    const ro = new ResizeObserver(soon);
    ro.observe(stage);
    stage.querySelectorAll('[data-keep-clear]').forEach(el => ro.observe(el));
    // The title's lines can change with its typeface while its box keeps its size: measure again once the fonts are in.
    document.fonts?.ready.then(() => { if (live) soon(); });
    return () => { live = false; ro.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, [forced, layoutKey]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || forced) return;
    const onPage = () => setPageShown(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onPage);
    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver === 'function') {
      io = new IntersectionObserver(entries => setInView(entries[entries.length - 1].isIntersecting));
      io.observe(root);
    }
    return () => { document.removeEventListener('visibilitychange', onPage); io?.disconnect(); };
  }, [forced]);

  if (forced) return null;
  const flows = lightFlows(player);
  const flow = !visible || !pageShown || !inView ? 'off' : reduced ? 'still' : flows ? 'run' : 'hold';
  return (
    <svg ref={rootRef} className={`${styles.light} ${className ?? ''}`} aria-hidden="true" focusable="false"
      data-ambient="stage" data-flow={flow} data-on={flow === 'run' ? 'true' : 'false'} data-lights={layout?.arcs.length ?? 0}
      viewBox={layout ? `0 0 ${layout.w} ${layout.h}` : undefined}>
      {layout && (
        <g className={styles.beams}>
          {/* One glow for every head: a soft oval, bright in the middle, gone at its edge. */}
          <defs>
            <radialGradient id={`${id}-glow`}>
              <stop offset="0" stopColor="var(--flow-glow)" stopOpacity="0.7" />
              <stop offset="0.45" stopColor="var(--flow-glow)" stopOpacity="0.28" />
              <stop offset="1" stopColor="var(--flow-glow)" stopOpacity="0" />
            </radialGradient>
          </defs>
          {layout.arcs.map(arc => {
            const d = lightPath(layout.pole, arc), meteor = lightMeteor(arc), schedule = lightSchedule(arc);
            const gradient = `${id}-color-${arc.index}`, clip = `${id}-clip-${arc.index}`;
            const cycle = { '--cycle': schedule.cycle, '--phase': (-lightPhase(arc.index)).toFixed(4) } as CSSProperties;
            const motion = {
              '--from': `${schedule.from.toFixed(4)}deg`, '--to': `${schedule.to.toFixed(4)}deg`, '--rest': `${meteor.rest.toFixed(4)}deg`,
              // Even while seen, quick where not (a browser without linear() keeps the stylesheet's even pace all the way round).
              animationTimingFunction: schedule.easing,
            } as CSSProperties;
            const windows = arc.windows.map(w => `${w.index}:${w.to.toFixed(4)}:${w.from.toFixed(4)}`).join(' ');
            return (
              <g key={arc.r} className={styles.trail} data-trail={arc.index} data-ring={arc.r} data-windows={windows} style={cycle}>
                <path className={styles.route} data-light-path d={d} />
                <defs>
                  {/* The tail is the spectrum's bar colour; the head, its peak's (round 4: a moderate white, Spotlight.module.css). */}
                  <linearGradient id={gradient} gradientUnits="userSpaceOnUse" x1={meteor.tail.x} y1={meteor.tail.y} x2={meteor.head.x} y2={meteor.head.y}>
                    <stop offset="0" stopColor="var(--flow-body)" stopOpacity="0" />
                    <stop offset="0.8" stopColor="var(--flow-body)" stopOpacity="0.8" />
                    <stop offset="1" stopColor="var(--flow-head)" stopOpacity="1" />
                  </linearGradient>
                  <clipPath id={clip} clipPathUnits="userSpaceOnUse"><path d={lightClipPath(layout.pole, arc)} /></clipPath>
                </defs>
                <g clipPath={`url(#${clip})`}>
                  <g transform={`translate(${layout.pole.x} ${layout.pole.y})`}>
                    <g className={styles.beam} data-meteor style={motion}>
                      <ellipse className={styles.glow} data-glow cx={meteor.glow.cx} cy={meteor.glow.cy} rx={meteor.glow.rx} ry={meteor.glow.ry} fill={`url(#${id}-glow)`} />
                      <path className={styles.meteor} d={meteor.path} fill={`url(#${gradient})`} />
                    </g>
                  </g>
                </g>
              </g>
            );
          })}
        </g>
      )}
    </svg>
  );
});

/** The stage box, the pole of the sky and every element marked data-keep-clear, in the stage's own pixels. */
function measureStage(stage: HTMLElement): Layout | null {
  const s = stage.getBoundingClientRect();
  const sky = stage.querySelector('[data-etch="star-trails"] svg');
  if (!(s.width > 0 && s.height > 0) || !sky) return null;
  const k = sky.getBoundingClientRect();
  const pole = { x: k.left - s.left + (TRAILS_BOX.cx * k.width) / TRAILS_BOX.w, y: k.top - s.top + (TRAILS_BOX.cy * k.height) / TRAILS_BOX.h };
  const rel = (r: { left: number; top: number; width: number; height: number }): Box => ({ x: r.left - s.left, y: r.top - s.top, w: r.width, h: r.height });
  const items: KeepItem[] = [];
  stage.querySelectorAll<HTMLElement>('[data-keep-clear]').forEach(el => {
    const box = el.getBoundingClientRect();
    if (!(box.width > 0 && box.height > 0)) return;
    const mark = el.dataset.keepClear, kind: KeepKind = mark === 'text' || mark === 'before' || mark === 'start' || mark === 'etch' ? mark : 'box';
    if (kind !== 'text') { items.push({ kind, box: rel(box) }); return; }
    // The lines actually set, not the whole width they may take (a two-line title is often much shorter).
    const lines = typeof document.createRange === 'function' ? (() => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return Array.from(range.getClientRects?.() ?? []);
    })() : [];
    const set: Box[] = [];
    for (const line of lines) {
      const top = Math.max(line.top, box.top), bottom = Math.min(line.bottom, box.bottom);
      if (bottom > top && line.width > 0) set.push(rel({ left: line.left, top, width: line.width, height: bottom - top }));
    }
    items.push({ kind, box: rel(box), lines: set });
  });
  return { w: s.width, h: s.height, pole, arcs: chooseLightArcs(TRAILS, pole, { x: 0, y: 0, w: s.width, h: s.height }, items) };
}

function sameLayout(a: Layout | null, b: Layout | null): boolean {
  if (!a || !b) return a === b;
  if (Math.abs(a.w - b.w) > 0.5 || Math.abs(a.h - b.h) > 0.5 || Math.abs(a.pole.x - b.pole.x) > 0.5 || Math.abs(a.pole.y - b.pole.y) > 0.5) return false;
  const near = (x: LightWindow, y: LightWindow) => x.index === y.index && Math.abs(x.from - y.from) < 1e-3 && Math.abs(x.to - y.to) < 1e-3;
  return a.arcs.length === b.arcs.length && a.arcs.every((arc, i) => near(arc, b.arcs[i])
    && arc.windows.length === b.arcs[i].windows.length && arc.windows.every((w, k) => near(w, b.arcs[i].windows[k])));
}
