import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createBoundedDispatcher } from "./boundedDispatch.ts";
import type {
  ActionResult,
  PlayerBridge,
  Surface,
  UISnapshot,
} from "../contracts/player.ts";
import type { SnapshotDelta } from "./snapshotTransport.ts";
import { applySnapshotDelta, measureClockOffset } from "./snapshotTransport.ts";

export interface NativeSnapshotEnvelope {
  sequence: number;
  snapshot: SnapshotDelta;
  full?: boolean;
}
/** Each receiving WebView has a different performance.now() origin. */
export function receiveNativeSnapshot(
  previous: UISnapshot | null,
  envelope: NativeSnapshotEnvelope,
  offset: number,
) {
  const delta = envelope.snapshot;
  if (
    previous &&
    delta.player?.sampleSequence !== undefined &&
    delta.player.sampleSequence < previous.player.sampleSequence
  )
    return previous;
  return applySnapshotDelta(
    previous,
    delta.player?.positionSampledAt === undefined
      ? delta
      : {
          ...delta,
          player: {
            ...delta.player,
            positionSampledAt: delta.player.positionSampledAt - offset,
          },
        },
  );
}

export async function createNativeBridge(
  surface: Surface,
): Promise<PlayerBridge> {
  const offset = await measureClockOffset(() => invoke<number>("clock_sample"));
  let cached: UISnapshot | null = null,
    sequence = -1,
    disposed = false;
  const listeners = new Set<() => void>(),
    early: NativeSnapshotEnvelope[] = [];
  const accept = (envelope: NativeSnapshotEnvelope) => {
    if (disposed || envelope.sequence <= sequence) return;
    if (!cached && !envelope.full) {
      early.push(envelope);
      return;
    }
    cached = receiveNativeSnapshot(cached, envelope, offset);
    sequence = envelope.sequence;
    for (const listener of listeners) listener();
  };
  const unlisten = await listen<NativeSnapshotEnvelope>(
    "cd-snapshot",
    (event) => accept(event.payload),
    // The default Any target also receives the other surface's stream. Each stream
    // has its own sequence counter and visibility, so mixing them hides mini lyrics.
    { target: { kind: "WebviewWindow", label: surface } },
  );
  try {
    const deadline = performance.now() + 15000;
    let first: NativeSnapshotEnvelope;
    for (;;) {
      try {
        first = await invoke<NativeSnapshotEnvelope>("request_snapshot");
        break;
      } catch (error) {
        if (performance.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    accept(first);
    for (const envelope of early.sort((a, b) => a.sequence - b.sequence))
      accept(envelope);
    early.length = 0;
    if (!cached) throw Error("桌面核心尚未准备好。");
  } catch (error) {
    unlisten();
    throw error;
  }
  const bounded = createBoundedDispatcher(async (action) => {
    try {
      const result = await invoke<ActionResult>("dispatch_action", {
        action,
        surface,
        deadlineMs: performance.now() + offset + 4500,
      });
      if (
        (!result.ok && result.code === "conflict") ||
        [
          "saveLyrics",
          "setLyricsOffset",
          "setNoLyrics",
          "updateAlbum",
          "updateTrack",
          "updateSettings",
          "applyLyricsCandidate",
        ].includes(action.type)
      ) {
        // Events and command replies use separate channels. Read the acknowledged native
        // cache so the caller can compare/rebase against the latest snapshot immediately.
        accept(await invoke<NativeSnapshotEnvelope>("request_snapshot"));
      }
      return result;
    } catch {
      return {
        ok: false,
        code: "unavailable",
        message: "桌面核心未及时响应，请重试。",
      };
    }
  });
  return {
    getSnapshot: () => cached!,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch: bounded.dispatch,
    destroy() {
      disposed = true;
      bounded.destroy();
      unlisten();
      listeners.clear();
    },
  };
}
