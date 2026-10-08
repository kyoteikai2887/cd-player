import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, copyFile } from "node:fs/promises";
import { build } from "esbuild";
import { prepareWindowsPicker } from "./prepare-picker.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, ".native-runtime");
await mkdir(output, { recursive: true });
await build({
  entryPoints: [path.join(root, "scripts/native-server.mjs")],
  outfile: path.join(output, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  banner: {
    js: "import { createRequire as cdCreateRequire } from 'node:module'; const require = cdCreateRequire(import.meta.url);",
  },
  target: "node24",
  define: { CD_DESKTOP_ENTRY: "true" },
  logLevel: "warning",
});
await copyFile(process.execPath, path.join(output, "node.exe"));
await prepareWindowsPicker(output);
console.log("桌面运行文件已准备。");
