import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Functional prototype icon, pending Claude's final application artwork.
const size = 32,
  bitmap = Buffer.alloc(40 + size * size * 4 + size * 4);
bitmap.writeUInt32LE(40, 0);
bitmap.writeInt32LE(size, 4);
bitmap.writeInt32LE(size * 2, 8);
bitmap.writeUInt16LE(1, 12);
bitmap.writeUInt16LE(32, 14);
for (let y = 0; y < size; y++)
  for (let x = 0; x < size; x++) {
    const d = (x - 16) ** 2 + (y - 16) ** 2,
      i = 40 + ((size - 1 - y) * size + x) * 4;
    if (d >= 12 && d < 196) {
      bitmap[i] = 228;
      bitmap[i + 1] = 172;
      bitmap[i + 2] = 108;
      bitmap[i + 3] = 255;
    }
  }
const header = Buffer.alloc(22);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
header[6] = size;
header[7] = size;
header.writeUInt16LE(1, 10);
header.writeUInt16LE(32, 12);
header.writeUInt32LE(bitmap.length, 14);
header.writeUInt32LE(22, 18);
const directory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src-tauri/icons",
);
await mkdir(directory, { recursive: true });
await writeFile(
  path.join(directory, "icon.ico"),
  Buffer.concat([header, bitmap]),
);
