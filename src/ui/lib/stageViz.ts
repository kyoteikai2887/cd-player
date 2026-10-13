import type { AudioVisualizationFrame, SettingsPatch, UserSettings } from '../../contracts/player.ts';

/**
 * The stage's music field (Claude, V1.2). 24 tokens on a line, one per band of the real signal
 * (contract 0.6.0, AudioVisualizationFrame.bands): each token rises and falls with its band, and
 * under the line the tokens are joined by arcs, drawn the way attention between tokens is drawn,
 * each lit by how strongly both of its ends are sounding. A picture of the music in the shape of a
 * transformer's attention, not a measurement of any model: nothing here is labelled as one.
 *
 * Everything in this file is plain arithmetic, so it is tested without a DOM. The component
 * (components/AttentionField.tsx) owns the frame loop and writes the results straight into SVG.
 */

export const TOKENS = 24;

/** Stored like memorialPlates, in the free ui.main object: absent shows it, an explicit false hides it. */
export const AUDIO_VISUALIZATION_KEY = 'audioVisualization';
export function showAudioVisualization(settings: Pick<UserSettings, 'ui'>): boolean {
  return settings.ui?.main?.[AUDIO_VISUALIZATION_KEY] !== false;
}
export function audioVisualizationPatch(on: boolean): SettingsPatch {
  return { ui: { main: { [AUDIO_VISUALIZATION_KEY]: on } } };
}

/** Sampling: about 24 reads a second while sounding; a quiet or reduced field is read 4 times a second. */
export const LIVE_INTERVAL_MS = 1000 / 24;
export const QUIET_INTERVAL_MS = 250;

/** Attention edges under the line: each token to the next but one and to the fifth, and a few long ones; fixed. */
export const EDGES: readonly (readonly [number, number])[] = (() => {
  const edges: [number, number][] = [];
  for (let i = 0; i < TOKENS; i++) {
    for (const step of [2, 5]) if (i + step < TOKENS) edges.push([i, i + step]);
    if (i % 3 === 0 && i + 11 < TOKENS) edges.push([i, i + 11]);
  }
  return edges;
})();

export interface VizState {
  trackId: string | null;
  /** Shown height of each token, 0..1, attack fast and release slow. */
  value: Float32Array;
  /** Peak marker of each token, held for a moment then falling. */
  peak: Float32Array;
  hold: Float32Array;
  /** Running ceiling of the bands, so quiet recordings still move; never below CEILING_FLOOR. */
  ceiling: number;
  /** Overall loudness for the arcs' brightness, smoothed. */
  energy: number;
}

const FLOOR = 0.2;          // bands at or under this read as silence (-64 dB)
const CEILING_FLOOR = 0.5;  // the ceiling never drops under this, so a quiet song stays small
const ATTACK = 0.65;        // share of a rise taken in one sample
const RELEASE_PER_S = 2.2;  // falls at most this much (of full height) per second
const HOLD_MS = 420;
const PEAK_FALL_PER_S = 0.9;

export function createVizState(): VizState {
  return { trackId: null, value: new Float32Array(TOKENS), peak: new Float32Array(TOKENS), hold: new Float32Array(TOKENS), ceiling: CEILING_FLOOR, energy: 0 };
}

/** Drops everything shown: a new song, a return to view, or the field switched on again. */
export function resetViz(state: VizState, trackId: string | null = null) {
  state.trackId = trackId;
  state.value.fill(0); state.peak.fill(0); state.hold.fill(0);
  state.ceiling = CEILING_FLOOR; state.energy = 0;
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * Advances the field by one sample. `dtMs` is the time since the previous sample.
 * A frame that is not live (idle, unavailable) is silence: everything falls back to rest.
 * A change of track clears the previous song first, so none of it lingers.
 * Returns true while anything is still above rest (the caller may slow down otherwise).
 */
export function stepViz(state: VizState, frame: AudioVisualizationFrame | null, dtMs: number, reduced = false): boolean {
  const dt = Math.min(0.5, Math.max(0, dtMs / 1000));
  const live = !!frame && frame.status === 'live';
  if (frame && frame.trackId !== state.trackId) resetViz(state, frame.trackId);
  const bands = live ? frame!.bands : null;
  let top = 0;
  if (bands) for (let i = 0; i < TOKENS; i++) top = Math.max(top, clamp01(bands[i]));
  state.ceiling = Math.max(CEILING_FLOOR, top, state.ceiling - 0.08 * dt);
  const span = Math.max(0.05, state.ceiling - FLOOR);
  // Reduced motion: the same picture, smaller and slower (sampled 4 times a second, no peak marks).
  const scale = reduced ? 0.6 : 1;
  let any = false;
  for (let i = 0; i < TOKENS; i++) {
    const target = bands ? clamp01((clamp01(bands[i]) - FLOOR) / span) ** 1.25 * scale : 0;
    const v = state.value[i];
    const next = target > v ? v + (target - v) * (reduced ? 1 : ATTACK) : Math.max(target, v - RELEASE_PER_S * dt);
    state.value[i] = next;
    if (next >= state.peak[i]) { state.peak[i] = next; state.hold[i] = HOLD_MS; }
    else if (state.hold[i] > 0) state.hold[i] = Math.max(0, state.hold[i] - dt * 1000);
    else state.peak[i] = Math.max(next, state.peak[i] - PEAK_FALL_PER_S * dt);
    if (next > 0.002 || state.peak[i] > 0.002) any = true;
  }
  const loud = live ? clamp01(frame!.level) : 0;
  state.energy = loud > state.energy ? state.energy + (loud - state.energy) * 0.5 : Math.max(loud, state.energy - 1.5 * dt);
  if (state.energy > 0.002) any = true;
  return any;
}

/** How lit one attention arc is: both ends must sound (geometric mean), eased, scaled by loudness. */
export function edgeWeight(state: VizState, a: number, b: number): number {
  const w = Math.sqrt(state.value[a] * state.value[b]);
  return Math.min(0.8, w ** 1.4 * (0.6 + 0.4 * state.energy) * 1.5);
}

/* ── Geometry (SVG user units; the field is drawn in a fixed box and scaled to fit) ──── */

/**
 * Above the line each token is a column of cells (a small matrix, etched in full and lit from the
 * bottom up to the band's height); under it hang the arcs.
 *
 * Round 2: the drawing is the height of the facts beside it (the stage gives it the rows from the
 * credit down to the buttons, about 184px), its matrix reaching the credit's cap height and its
 * arcs the buttons' lower edge. It keeps its proportions: a wider stage does not space the tokens
 * out, and where the stage is narrow it first draws the tokens a little closer (down to
 * FIELD_MIN_W wide) before it scales down as a whole.
 */
export const FIELD = { w: 336, h: 184, baseline: 118, cell: 4, gap: 2, cells: 19, depth: 54, padX: 8 } as const;
export const PITCH = FIELD.cell + FIELD.gap;
export const RISE = FIELD.cells * PITCH - FIELD.gap;

/** Whole cells lit for a value 0..1 (a sounding band always lights at least one). */
export function litCells(value: number): number {
  return value <= 0.02 ? 0 : Math.max(1, Math.min(FIELD.cells, Math.round(value * FIELD.cells)));
}

/**
 * The drawing's width for a box: the box's own proportion at the drawing's height, within these
 * bounds, in steps so a resize redraws rarely. Wider boxes get FIELD_MAX_W (the box keeps the rest
 * as glass); narrower ones FIELD_MIN_W, scaled down to fit.
 */
export const FIELD_MIN_W = 240, FIELD_MAX_W = FIELD.w;
export function fieldWidth(boxW: number, boxH: number): number {
  if (!(boxW > 0) || !(boxH > 0)) return FIELD.w;
  const w = Math.round((boxW / boxH) * FIELD.h / 8) * 8;
  return Math.min(FIELD_MAX_W, Math.max(FIELD_MIN_W, w));
}

export function tokenX(i: number, w: number = FIELD.w): number {
  return FIELD.padX + (i + 0.5) * ((w - FIELD.padX * 2) / TOKENS);
}

/** An arc hanging under the line from token a to token b (sweep 0 runs below in SVG's y-down space). */
export function edgePath(a: number, b: number, w: number = FIELD.w): string {
  const x1 = tokenX(a, w), x2 = tokenX(b, w), rx = (x2 - x1) / 2;
  const ry = Math.min(FIELD.depth, rx * 0.92);
  const y = FIELD.baseline + 5;
  return `M${x1.toFixed(2)} ${y}A${rx.toFixed(2)} ${ry.toFixed(2)} 0 0 0 ${x2.toFixed(2)} ${y}`;
}
