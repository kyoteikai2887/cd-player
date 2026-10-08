import React from "react";
import { createRoot } from "react-dom/client";
import { createMockSession } from "./mock/createMockBridge.ts";
import { App } from "./app/App.tsx";
import { createLocalClient } from "./bridge/localClient.ts";
import { createLocalSession } from "./bridge/createLocalSession.ts";
import { createAdaptiveAudioEngine } from "./core/adaptiveAudio.ts";

async function start() {
  const local = new URLSearchParams(location.search).get("local") === "1";
  const session = local
    ? createLocalSession({
        client: await createLocalClient(),
        engine: createAdaptiveAudioEngine(),
      })
    : createMockSession();
  const main = session.connect("main"),
    mini = session.connect("mini");
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App main={main} mini={mini} mode={local ? "local" : "demo"} />
    </React.StrictMode>,
  );
  if ("hasUnsavedChanges" in session)
    window.addEventListener("beforeunload", (event) => {
      if (session.hasUnsavedChanges()) {
        event.preventDefault();
        event.returnValue = "";
      }
    });
  window.addEventListener("pagehide", () => session.destroy(), { once: true });
}
void start().catch((error) => {
  document.getElementById("root")!.textContent =
    error instanceof Error ? error.message : "播放器未能启动。";
});
