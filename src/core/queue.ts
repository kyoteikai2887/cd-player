import type { LibrarySnapshot, PlayerSnapshot, QueueEntry } from '../contracts/player.ts';

export function emptyPlayer(): PlayerSnapshot {
  return { status: 'idle', currentTrackId: null, currentEntryId: null, currentQueueIndex: -1,
    positionMs: 0, durationMs: 0, positionSampledAt: 0, sampleSequence: 0,
    volume: 0.7, muted: false, queue: [], repeat: 'off', shuffle: false, error: null };
}
/** Drop all removed tracks, including repeated entries, without starting a replacement song. */
export function pruneQueueForLibrary(state: PlayerSnapshot, library: LibrarySnapshot): PlayerSnapshot {
  const present = new Set(library.tracks.map(track => track.id));
  const queue = state.queue.filter(entry => present.has(entry.trackId));
  const currentRemoved = state.currentTrackId !== null && !present.has(state.currentTrackId);
  if (!currentRemoved && queue.length === state.queue.length) return state;
  if (currentRemoved) return { ...state, queue, status: 'idle', currentTrackId: null,
    currentEntryId: null, currentQueueIndex: -1, positionMs: 0, durationMs: 0, error: null };
  return { ...state, queue, currentQueueIndex: queue.findIndex(entry => entry.id === state.currentEntryId) };
}
export function selectQueueIndex(state: PlayerSnapshot, index: number, library: LibrarySnapshot): PlayerSnapshot {
  const entry = state.queue[index];
  const track = entry && library.tracks.find(item => item.id === entry.trackId && item.available);
  if (!track) return state;
  return { ...state, currentQueueIndex: index, currentEntryId: entry.id, currentTrackId: track.id,
    positionMs: 0, durationMs: track.durationMs, status: 'playing', error: null };
}
export function loadQueue(state: PlayerSnapshot, trackIds: string[], library: LibrarySnapshot, startIndex = 0, idPrefix = 'queue'): PlayerSnapshot {
  const selected = trackIds[startIndex];
  if (!selected || !library.tracks.some(track => track.id === selected && track.available)) return state;
  const valid = new Set(library.tracks.filter(track => track.available).map(track => track.id));
  const queue: QueueEntry[] = [];
  let selectedIndex = -1;
  trackIds.forEach((trackId, index) => {
    if (!valid.has(trackId)) return;
    if (index === startIndex) selectedIndex = queue.length;
    queue.push({ id: idPrefix + '-' + index, trackId, originalOrder: queue.length });
  });
  let next = selectQueueIndex({ ...state, queue }, selectedIndex, library);
  if (next.shuffle) next = setShuffle(next, true);
  return next;
}
export function advance(state: PlayerSnapshot, library: LibrarySnapshot, reason: 'manual' | 'ended'): PlayerSnapshot {
  if (!state.queue.length) return state;
  if (reason === 'ended' && state.repeat === 'one') return selectQueueIndex(state, state.currentQueueIndex, library);
  const candidates = [...state.queue.keys()].filter(index => index > state.currentQueueIndex);
  if (state.repeat === 'all') candidates.push(...[...state.queue.keys()].filter(index => index <= state.currentQueueIndex));
  for (const index of candidates) {
    const next = selectQueueIndex(state, index, library);
    if (next !== state) return next;
  }
  return { ...state, status: 'paused', positionMs: state.durationMs };
}
export function previous(state: PlayerSnapshot, library: LibrarySnapshot): PlayerSnapshot {
  if (!state.queue.length) return state;
  if (state.positionMs > 3000) return { ...state, positionMs: 0 };
  const candidates = [...state.queue.keys()].filter(index => index < state.currentQueueIndex).reverse();
  if (state.repeat === 'all') candidates.push(...[...state.queue.keys()].filter(index => index >= state.currentQueueIndex).reverse());
  for (const index of candidates) {
    const next = selectQueueIndex(state, index, library);
    if (next !== state) return next;
  }
  return { ...state, positionMs: 0 };
}
export function seek(state: PlayerSnapshot, positionMs: number): PlayerSnapshot {
  if (!Number.isFinite(positionMs)) return state;
  return { ...state, positionMs: Math.max(0, Math.min(positionMs, state.durationMs)) };
}
export function setShuffle(state: PlayerSnapshot, enabled: boolean, random: () => number = Math.random): PlayerSnapshot {
  const current = state.queue[state.currentQueueIndex];
  if (!current) return { ...state, shuffle: enabled };
  let queue: QueueEntry[];
  if (enabled) {
    const remaining = state.queue.slice(state.currentQueueIndex + 1);
    for (let i = remaining.length - 1; i > 0; i--) {
      const j = Math.floor(Math.max(0, Math.min(random(), 0.999999999)) * (i + 1));
      [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
    }
    queue = [...state.queue.slice(0, state.currentQueueIndex + 1), ...remaining];
  } else queue = [...state.queue].sort((a, b) => a.originalOrder - b.originalOrder);
  return { ...state, queue, shuffle: enabled, currentQueueIndex: queue.findIndex(entry => entry.id === current.id) };
}
/** Explicit edits establish the visible order as the new unshuffle baseline. */
export function editQueue(state: PlayerSnapshot, queue: QueueEntry[], library: LibrarySnapshot): PlayerSnapshot {
  const normalized = queue.map((entry, index) => ({ ...entry, originalOrder: index }));
  const index = normalized.findIndex(entry => entry.id === state.currentEntryId);
  if (index >= 0) return { ...state, queue: normalized, currentQueueIndex: index };
  const next = { ...state, queue: normalized, currentQueueIndex: -1, currentEntryId: null,
    currentTrackId: null, status: 'idle' as const, positionMs: 0, durationMs: 0 };
  if (!state.currentEntryId) return next;
  for (let candidate = state.currentQueueIndex; candidate < normalized.length; candidate++) {
    const selected = selectQueueIndex(next, candidate, library);
    if (selected !== next) return selected;
  }
  return next;
}
