import React, { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { PlayerUI } from "./ui/PlayerUI.tsx";
import type {
  PlayerBridge,
  Surface,
  UIAction,
} from "./contracts/player.ts";
import { createNativeBridge } from "./bridge/nativeBridge.ts";
import { createLocalSession } from "./bridge/createLocalSession.ts";
import { createLocalClient } from "./bridge/localClient.ts";
import { createAdaptiveAudioEngine } from "./core/adaptiveAudio.ts";
import { startNativeHeartbeat } from "./bridge/nativeHealth.ts";
import { relayNativeAction } from "./bridge/nativeActionRelay.ts";
import {
  measureClockOffset,
  snapshotDelta,
} from "./bridge/snapshotTransport.ts";
import "./app/host.css";

function NativeSurface({
  bridge,
  surface,
}: {
  bridge: PlayerBridge;
  surface: Surface;
}) {
  const snapshot = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot);
  return (
    <div className="app-surface" data-surface={surface}>
      <PlayerUI
        snapshot={snapshot}
        surface={surface}
        onAction={bridge.dispatch}
      />
    </div>
  );
}
async function start() {
  const surface = await invoke<Surface>("surface_name");
  if (surface === "main") {
    const offset = await measureClockOffset(() =>
      invoke<number>("clock_sample"),
    );
    const session = createLocalSession({
      client: await createLocalClient(),
      engine: createAdaptiveAudioEngine({
        forceStreaming:
          (window as Window & { __CD_STREAM_AUDIO_TEST__?: boolean })
            .__CD_STREAM_AUDIO_TEST__ === true,
      }),
      actionTimeoutMs: 4000,
    });
    const connections = {
      main: session.connect("main"),
      mini: session.connect("mini"),
    };
    // Keep the original cached objects on the sending side; only changed fields cross IPC.
    let sending = Promise.resolve();
    for (const name of ["main", "mini"] as const) {
      const bridge = connections[name];
      let previous: ReturnType<PlayerBridge["getSnapshot"]> | null = null;
      const publish = () => {
        const next = bridge.getSnapshot(),
          delta = snapshotDelta(previous, next);
        previous = next;
        if (delta.player?.positionSampledAt !== undefined)
          delta.player = {
            ...delta.player,
            positionSampledAt: delta.player.positionSampledAt + offset,
          };
        sending = sending
          .then(() => invoke("push_snapshot", { surface: name, delta }))
          .then(
            () => {},
            (error) => {
              console.error("Snapshot transport", error);
            },
          );
      };
      bridge.subscribe(publish);
      publish();
    }
    await listen<{
      id: string;
      surface: Surface;
      action: UIAction;
      deadlineMs: number;
    }>("cd-action", (event) => {
      const { id, surface, action, deadlineMs } = event.payload;
      void relayNativeAction({
        surface, action, deadlineMs, clockOffset: offset, now: () => performance.now(),
        dispatch: (action, budget) => connections[surface].dispatchWithBudget(action, budget),
        publication: () => sending,
        report: (stage) => invoke("report_action_stage", { id, stage }),
        resolve: (result) => invoke("resolve_action", { id, result }),
      }).catch(() => {});
    });
    // A pending WebLock helps prevent discard when the playing main WebView is hidden.
    if (navigator.locks)
      void navigator.locks.request(
        "cd-audio-session",
        () => new Promise<void>(() => {}),
      );
    window.addEventListener("pagehide", () => session.destroy(), {
      once: true,
    });
    await sending;
    const stopHeartbeat = startNativeHeartbeat({
      async probe(signal) {
        const response = await fetch("/api/health", {
          signal,
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Local backend is unavailable");
      },
      report: (backendReady) => invoke("core_heartbeat", { backendReady }),
    });
    window.addEventListener("pagehide", stopHeartbeat, { once: true });
  }
  const bridge = await createNativeBridge(surface);
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <NativeSurface bridge={bridge} surface={surface} />
    </React.StrictMode>,
  );
  await invoke("surface_ready");
  window.addEventListener("pagehide", bridge.destroy, { once: true });
}
void start().catch((error) => {
  void invoke("frontend_error", { message: String(error) }).catch(() => {});
  document.getElementById("root")!.textContent =
    error instanceof Error ? error.message : "桌面播放器未能启动。";
});
