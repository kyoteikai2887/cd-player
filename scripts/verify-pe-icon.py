"""Compare every ICO frame byte-for-byte with RT_ICON resources in a built Windows EXE."""
import hashlib
import json
from pathlib import Path
import struct
import sys

root = Path(__file__).resolve().parent.parent
exe = Path(sys.argv[1]) if len(sys.argv) > 1 else root / "src-tauri/target/release/cd-player-desktop.exe"
data = exe.read_bytes()
u16 = lambda pos: struct.unpack_from("<H", data, pos)[0]
u32 = lambda pos: struct.unpack_from("<I", data, pos)[0]
pe = u32(0x3C)
assert data[:2] == b"MZ" and data[pe:pe + 4] == b"PE\0\0"
opt = pe + 24
directory = opt + (112 if u16(opt) == 0x20B else 96)
resource_rva = u32(directory + 16)
sections = []
for n in range(u16(pe + 6)):
    pos = opt + u16(pe + 20) + n * 40
    sections.append((u32(pos + 12), max(u32(pos + 8), u32(pos + 16)), u32(pos + 20)))
def offset(rva):
    for address, size, raw in sections:
        if address <= rva < address + size:
            return raw + rva - address
    raise AssertionError("RVA outside PE sections")
base = offset(resource_rva)
resources = {}
def visit(relative, keys):
    pos = base + relative
    for n in range(u16(pos + 12) + u16(pos + 14)):
        name, target = struct.unpack_from("<II", data, pos + 16 + n * 8)
        key = name if not name & 0x80000000 else "named"
        if target & 0x80000000:
            visit(target & 0x7FFFFFFF, keys + [key])
        else:
            address, length = struct.unpack_from("<II", data, base + target)
            start = offset(address)
            resources[tuple(keys + [key])] = data[start:start + length]
visit(0, [])
ico = (root / "src-tauri/icons/icon.ico").read_bytes()
count = struct.unpack_from("<H", ico, 4)[0]
frames = []
sha = lambda b: hashlib.sha256(b).hexdigest()
for n in range(count):
    width, height, _, _, _, _, size, start = struct.unpack_from("<BBBBHHII", ico, 6 + n * 16)
    frames.append({"width": width or 256, "height": height or 256, "sha256": sha(ico[start:start + size])})
embedded = [sha(b) for keys, b in resources.items() if keys[0] == 3]
assert sorted(f["sha256"] for f in frames) == sorted(embedded), "Embedded RT_ICON differs from selected ICO"
groups = [b for keys, b in resources.items() if keys[0] == 14]
assert any(struct.unpack_from("<H", b, 4)[0] == count for b in groups)
print(json.dumps({"passed": True, "exe": str(exe), "exeSHA256": sha(data), "frames": frames,
                  "embeddedFramesMatchICO": True, "groupIconPresent": True}, indent=2))
