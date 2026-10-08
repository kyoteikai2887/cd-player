import path from "node:path";
import { createReadStream } from "node:fs";
import { stat, realpath } from "node:fs/promises";
import { createInterface } from "node:readline";
import { openLocalStore } from "../src/local/store.ts";
import { startLocalServer, pickWindowsFile } from "../src/local/server.ts";

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
};
export async function startDesktopBackend({ directory, assets, pickerExecutable, recoverDeadOwner = false }) {
  const root = await realpath(assets),
    store = await openLocalStore(directory, { recoverDeadOwner });
  let server;
  try {
    server = await startLocalServer({
      store,
      dataDirectory: directory,
      port: 0,
      picker: (kind, signal) => pickWindowsFile(kind, signal, pickerExecutable),
      middleware(req, res) {
        void (async () => {
          if (req.method !== "GET" && req.method !== "HEAD") {
            res.writeHead(405);
            res.end();
            return;
          }
          let name;
          try {
            name = decodeURIComponent(
              new URL(req.url, "http://localhost").pathname,
            );
          } catch {
            res.writeHead(400);
            res.end();
            return;
          }
          const target = path.resolve(
            root,
            "." + (name === "/" ? "/desktop.html" : name),
          );
          const relative = path.relative(root, target);
          if (relative.startsWith("..") || path.isAbsolute(relative)) {
            res.writeHead(403);
            res.end();
            return;
          }
          try {
            const resolved = await realpath(target),
              inside = path.relative(root, resolved);
            if (inside.startsWith("..") || path.isAbsolute(inside)) {
              res.writeHead(403);
              res.end();
              return;
            }
            const info = await stat(resolved);
            if (!info.isFile()) {
              res.writeHead(404);
              res.end();
              return;
            }
            res.writeHead(200, {
              "content-type":
                mime[path.extname(resolved)] ?? "application/octet-stream",
              "content-length": info.size,
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
              "content-security-policy":
                "default-src 'self'; script-src 'self' 'unsafe-inline' http://ipc.localhost; connect-src 'self' ipc: http://ipc.localhost; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
            });
            if (req.method === "HEAD") {
              res.end();
              return;
            }
            const stream = createReadStream(resolved);
            stream.on("error", () => res.destroy());
            res.on("close", () => stream.destroy());
            stream.pipe(res);
          } catch {
            res.writeHead(404);
            res.end();
          }
        })().catch(() => {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
      },
    });
  } catch (error) {
    await store.close();
    throw error;
  }
  let closing;
  return {
    origin: server.origin,
    close() {
      return (closing ??= (async () => {
        await server.close();
        await store.close();
      })());
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const argument = (name) => {
    const at = args.indexOf(name);
    if (at < 0 || !args[at + 1]) throw Error("Missing " + name);
    return path.resolve(args[at + 1]);
  };
  const backend = await startDesktopBackend({
    directory: argument("--data"),
    assets: argument("--assets"),
    pickerExecutable: argument("--picker"),
    recoverDeadOwner: args.includes("--recover-stale-lock"),
  });
  process.stdout.write(JSON.stringify({ origin: backend.origin }) + "\n");
  const input = createInterface({ input: process.stdin });
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    input.close();
    void backend.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  input.on("line", (line) => {
    if (line === "shutdown") close();
  });
  input.on("close", close);
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}
// Bundler defines this for the executable entry; importing for tests has no side effects.
if (typeof CD_DESKTOP_ENTRY !== "undefined" && CD_DESKTOP_ENTRY)
  void main().catch((error) => {
    // One structured startup frame lets the hidden native host display the real failure.
    process.stdout.write(JSON.stringify({ startupError: { code: error.code ?? "io", message: error.message } }) + "\n");
    console.error(error.message);
    process.exitCode = 1;
  });
