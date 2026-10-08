import type { PlayerSnapshot, UISnapshot } from "../contracts/player.ts";
import { CONTRACT_VERSION } from "../contracts/player.ts";

/** Private IPC envelope; the frozen UI snapshot remains the only public contract. */
export type SnapshotDelta = Partial<Omit<UISnapshot, "player">> & {
  player?: Partial<PlayerSnapshot>;
};

export function snapshotDelta(
  previous: UISnapshot | null,
  next: UISnapshot,
): SnapshotDelta {
  if (!previous) return next;
  const delta: SnapshotDelta = {};
  for (const key of Object.keys(next) as (keyof UISnapshot)[]) {
    if (key === "player" || next[key] === previous[key]) continue;
    Object.assign(delta, { [key]: next[key] });
  }
  if (next.player !== previous.player) {
    const player: Partial<PlayerSnapshot> = {};
    for (const key of Object.keys(next.player) as (keyof PlayerSnapshot)[]) {
      if (next.player[key] !== previous.player[key])
        Object.assign(player, { [key]: next.player[key] });
    }
    delta.player = player;
  }
  return delta;
}

/** Called after JSON IPC decoding; omitted library/lyrics/queue retain their references. */
export function applySnapshotDelta(
  previous: UISnapshot | null,
  delta: SnapshotDelta,
): UISnapshot {
  if (!previous) {
    if (
      !delta.host ||
      !delta.library ||
      !delta.player?.queue ||
      !delta.settings ||
      !delta.tasks ||
      !delta.notices ||
      !("lyrics" in delta) ||
      !("lyricsEditor" in delta) ||
      !("metadataReview" in delta) ||
      !("lyricsReview" in delta) ||
      typeof delta.player.positionSampledAt !== "number" ||
      typeof delta.player.sampleSequence !== "number" ||
      delta.contractVersion !== CONTRACT_VERSION
    )
      throw Error("Initial IPC snapshot is incomplete");
    return delta as UISnapshot;
  }
  return {
    ...previous,
    ...delta,
    player: delta.player
      ? { ...previous.player, ...delta.player }
      : previous.player,
  };
}

/** Calibrate against the native host's monotonic clock, keeping the lowest-latency probe. */
export async function measureClockOffset(
  sample: () => Promise<number>,
  now = () => performance.now(),
  probes = 5,
): Promise<number> {
  if (!Number.isSafeInteger(probes) || probes < 1 || probes > 20)
    throw Error("Invalid clock probe count");
  let fastest = Infinity,
    offset = 0;
  for (let i = 0; i < probes; i++) {
    const before = now(),
      remote = await sample(),
      after = now();
    if (![before, remote, after].every(Number.isFinite) || after < before)
      throw Error("Invalid monotonic clock sample");
    const elapsed = after - before;
    if (elapsed < fastest) {
      fastest = elapsed;
      offset = remote - (before + after) / 2;
    }
  }
  return offset;
}
