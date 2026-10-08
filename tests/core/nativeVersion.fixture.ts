/** Synthetic PE version resources only: never an executable fixture. */
export function nativeVersionFixture(version: string, pe32 = false): Buffer {
  const align = (n: number) => (n + 3) & ~3;
  function block(key: string, value: Buffer, type: number, children: Buffer[] = []): Buffer {
    const name = Buffer.from(key + '\0', 'utf16le'), valueStart = align(6 + name.length);
    const childStart = align(valueStart + value.length);
    const length = children.length ? childStart + children.reduce((n, b) => n + align(b.length), 0) : valueStart + value.length;
    const b = Buffer.alloc(length); b.writeUInt16LE(length); b.writeUInt16LE(type === 1 ? value.length / 2 : value.length, 2);
    b.writeUInt16LE(type, 4); name.copy(b, 6); value.copy(b, valueStart);
    let pos = childStart; for (const child of children) { child.copy(b, pos); pos += align(child.length); } return b;
  }
  const fixed = Buffer.alloc(52); fixed.writeUInt32LE(0xfeef04bd); fixed.writeUInt32LE(0x10000, 4);
  const info = block('VS_VERSION_INFO', fixed, 0, [block('StringFileInfo', Buffer.alloc(0), 1,
    [block('040904B0', Buffer.alloc(0), 1, [block('ProductVersion', Buffer.from(version + '\0', 'utf16le'), 1)])])]);
  const exe = Buffer.alloc(0x200 + align(0x80 + info.length));
  exe.write('MZ'); exe.writeUInt32LE(0x80, 0x3c); exe.write('PE\0\0', 0x80);
  exe.writeUInt16LE(1, 0x86); const opt = 0x98, optSize = pe32 ? 0xe0 : 0xf0;
  exe.writeUInt16LE(optSize, 0x94); exe.writeUInt16LE(pe32 ? 0x10b : 0x20b, opt);
  exe.writeUInt32LE(16, opt + (pe32 ? 92 : 108));
  const directory = opt + (pe32 ? 96 : 112); exe.writeUInt32LE(0x1000, directory + 16); exe.writeUInt32LE(0x80 + info.length, directory + 20);
  const section = opt + optSize; exe.write('.rsrc', section); exe.writeUInt32LE(exe.length - 0x200, section + 8);
  exe.writeUInt32LE(0x1000, section + 12); exe.writeUInt32LE(exe.length - 0x200, section + 16); exe.writeUInt32LE(0x200, section + 20);
  for (const relative of [0, 0x18, 0x30]) exe.writeUInt16LE(1, 0x200 + relative + 14);
  exe.writeUInt32LE(16, 0x210); exe.writeUInt32LE(0x80000018, 0x214);
  exe.writeUInt32LE(1, 0x228); exe.writeUInt32LE(0x80000030, 0x22c);
  exe.writeUInt32LE(1033, 0x240); exe.writeUInt32LE(0x48, 0x244);
  exe.writeUInt32LE(0x1080, 0x248); exe.writeUInt32LE(info.length, 0x24c); info.copy(exe, 0x280);
  return exe;
}
