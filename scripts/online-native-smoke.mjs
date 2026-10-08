import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";

// WebView2 devtools are enabled only for this isolated debug process, never for the release app.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const example = path.resolve(process.argv[2]);
assert.ok(path.isAbsolute(example), "Public example file required");
const listener = createServer();
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const output = path.join(root, ".cache", "online-native-" + Date.now());
await mkdir(output);
const child = spawn(
  process.execPath,
  [
    path.join(root, "scripts/ui-r2-2-smoke.mjs"),
    "--fixture",
    path.join(root, ".cache/audio-check/Disc 1/01 原创音.flac"),
    "--public-example",
    example,
  ],
  {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=" + port,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let logs = "",
  session;
child.stdout.on("data", (bytes) => {
  const text = bytes.toString();
  logs += text;
  for (const line of text.split("\n"))
    try {
      const value = JSON.parse(line);
      if (value.workspace && value.stop) session = value;
    } catch {}
});
child.stderr.on("data", (bytes) => {
  logs += bytes.toString();
});
const completed = new Promise((resolve, reject) => {
  child.once("exit", resolve);
  child.once("error", reject);
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url),
      pending = new Map();
    let seq = 0;
    socket.addEventListener("error", reject, { once: true });
    socket.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data),
        entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(Error(JSON.stringify(msg.error)));
      else entry.resolve(msg.result);
    });
    socket.addEventListener("open", () =>
      resolve({
        socket,
        send(method, params = {}) {
          return new Promise((resolve, reject) => {
            const id = ++seq;
            const timer = setTimeout(() => {
              pending.delete(id);
              reject(Error("CDP timeout: " + method));
            }, 10000);
            pending.set(id, { resolve, reject, timer });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
      }),
    );
  });
}
const evaluate = async (cdp, expression) => {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails)
    throw Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
const act = async (cdp, action) => {
  const result = await evaluate(
    cdp,
    `(async()=>{const i=window.__TAURI_INTERNALS__.invoke;
    const now=await i('clock_sample');return i('dispatch_action',{surface:'main',action:${JSON.stringify(action)},deadlineMs:now+4500});})()`,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
};
let cdp, report, primaryError;
try {
  for (let n = 0; n < 100 && !cdp; n++) {
    try {
      const targets = await (
        await fetch(`http://127.0.0.1:${port}/json/list`)
      ).json();
      for (const target of targets.filter((t) => t.type === "page")) {
        const candidate = await connect(target.webSocketDebuggerUrl);
        if (
          (await evaluate(
            candidate,
            `document.querySelector('.cdp')?.dataset.surface`,
          )) === "main"
        ) {
          cdp = candidate;
          break;
        }
        candidate.socket.close();
      }
    } catch {}
    if (!cdp) await delay(150);
  }
  assert.ok(cdp && session, "Isolated online main surface was not ready");
  const fixture = JSON.parse(await readFile(example, "utf8")),
    trackId = fixture.tracks[0].id;
  const started = await act(cdp, {
    type: "lookupMetadata",
    albumId: "public-album",
  });
  assert.equal(started.status, "started");
  let sheet;
  for (let n = 0; n < 160; n++) {
    sheet = await evaluate(
      cdp,
      `document.querySelector('[role="dialog"]')?.innerText ?? ''`,
    );
    if (sheet.includes("应用 ")) break;
    if (sheet.includes("查找失败") || sheet.includes("没有找到"))
      throw Error(sheet);
    await delay(250);
  }
  assert.ok(
    sheet.includes("Dummy") && sheet.includes("应用 "),
    "Real edition candidates did not reach the UI",
  );
  const ready = await cdp.send("Page.captureScreenshot", { format: "png" });
  await writeFile(
    path.join(output, "metadata-ready.png"),
    Buffer.from(ready.data, "base64"),
  );
  await evaluate(
    cdp,
    `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith('应用 '));if(!b||b.disabled)throw Error('Apply unavailable');b.click();})()`,
  );
  let persisted;
  for (let n = 0; n < 60; n++) {
    persisted = JSON.parse(
      await readFile(
        path.join(session.workspace, "data", "library.json"),
        "utf8",
      ),
    );
    if (
      persisted.library.albums[0].musicBrainzReleaseId &&
      !(await evaluate(cdp, `!!document.querySelector('[role="dialog"]')`))
    )
      break;
    await delay(100);
  }
  const album = persisted.library.albums[0];
  assert.ok(album.musicBrainzReleaseId);
  assert.ok(album.cover?.thumbUrl.startsWith("/api/cover/"));
  const lookup = await act(cdp, { type: "lookupLyrics", trackId });
  assert.equal(lookup.status, "started");
  let document;
  for (let n = 0; n < 140; n++) {
    persisted = JSON.parse(
      await readFile(
        path.join(session.workspace, "data", "library.json"),
        "utf8",
      ),
    );
    document = persisted.lyricsByTrack[trackId];
    if (document.kind === "synced") break;
    await delay(200);
  }
  assert.equal(document.kind, "synced");
  assert.equal(document.source.original.name, "LRCLIB");
  assert.equal(document.locked, false);
  await act(cdp, { type: "openLyricsEditor", trackId });
  assert.ok(await evaluate(cdp, `!!document.querySelector('[role="dialog"]')`));
  await act(cdp, { type: "closeLyricsEditor" });
  report = {
    passed: true,
    reference: fixture.reference,
    realProvidersQueried: ["MusicBrainz", "Cover Art Archive", "LRCLIB"],
    candidateReviewShown: true,
    selectedFieldsAdopted: true,
    releaseId: album.musicBrainzReleaseId,
    coverServedLocally: true,
    protectedFields: album.userEditedFields,
    lyrics: {
      kind: document.kind,
      lineCount: document.lines.length,
      source: document.source.original,
    },
    currentEditorDocumentShown: true,
    audioStarted: false,
    defaultUserStoreModified: false,
    localCollectionReadOrSent: false,
  };
} catch (error) {
  primaryError = error;
  await writeFile(
    path.join(output, "failure.json"),
    JSON.stringify({ error: String(error), stack: error.stack }, null, 2),
  );
} finally {
  if (cdp) await delay(800);
  if (cdp) cdp.socket.close();
  if (session) await writeFile(session.stop, "finish isolated online check");
  const exit = await completed;
  await writeFile(path.join(output, "native.log"), logs);
  if (!primaryError) assert.equal(exit, 0, logs);
}
if (primaryError) throw primaryError;
await writeFile(
  path.join(output, "report.json"),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify({ output, ...report }, null, 2));
