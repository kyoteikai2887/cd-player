/** Read ProductVersion from PE RT_VERSION resources, not incidental binary strings. */
export function nativeProductVersion(exe: Buffer): string {
  const fail = () => { throw Error('Invalid native Windows version resource'); };
  const bounds = (start: number, length: number) => {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > exe.length) fail();
  };
  const u16 = (at: number) => { bounds(at, 2); return exe.readUInt16LE(at); };
  const u32 = (at: number) => { bounds(at, 4); return exe.readUInt32LE(at); };
  bounds(0, 64); if (exe.toString('ascii', 0, 2) !== 'MZ') fail();
  const pe = u32(0x3c); bounds(pe, 24); if (exe.toString('ascii', pe, pe + 4) !== 'PE\0\0') fail();
  const count = u16(pe + 6), opt = pe + 24, optSize = u16(pe + 20), magic = u16(opt);
  if (!count || count > 96 || ![0x10b, 0x20b].includes(magic)) fail();
  bounds(opt, optSize); const dir = opt + (magic === 0x20b ? 112 : 96);
  if (dir + 24 > opt + optSize || u32(dir - 4) < 3) fail();
  const resourceRVA = u32(dir + 16), resourceSize = u32(dir + 20);
  if (!resourceRVA || !resourceSize) fail();
  const sections = opt + optSize; bounds(sections, count * 40);
  const mapped = (rva: number, size: number) => {
    for (let n = 0; n < count; n++) {
      const section = sections + n * 40, address = u32(section + 12), rawSize = u32(section + 16), raw = u32(section + 20);
      if (rva >= address && rva - address + size <= rawSize) { const at = raw + rva - address; bounds(at, size); return at; }
    }
    return fail();
  };
  const relative = (offset: number, size: number) => {
    if (offset < 0 || offset + size > resourceSize) fail(); return mapped(resourceRVA + offset, size);
  };
  const versions = new Set<string>();
  function versionBlock(start: number, limit: number, parents: string[] = []): number {
    const length = u16(start), valueLength = u16(start + 2), type = u16(start + 4), end = start + length;
    if (length < 6 || end > limit || parents.length > 4 || type > 1) fail();
    let cursor = start + 6, key = '';
    while (true) { if (cursor + 2 > end) fail(); const c = u16(cursor); cursor += 2; if (!c) break; key += String.fromCharCode(c); if (key.length > 256) fail(); }
    const valueStart = (cursor + 3) & ~3, valueBytes = type === 1 ? valueLength * 2 : valueLength;
    if (valueBytes && valueStart + valueBytes > end) fail();
    if (!parents.length && (key !== 'VS_VERSION_INFO' || type !== 0 || valueBytes < 52 || u32(valueStart) !== 0xfeef04bd)) fail();
    if (key === 'ProductVersion' && parents.length === 3 && parents[0] === 'VS_VERSION_INFO' && parents[1] === 'StringFileInfo' && /^[a-f0-9]{8}$/i.test(parents[2])) {
      if (type !== 1 || !valueBytes || valueBytes > 512) fail();
      const value = exe.toString('utf16le', valueStart, valueStart + valueBytes).replace(/\0+$/, '');
      if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(value)) fail(); versions.add(value);
    }
    cursor = (valueStart + valueBytes + 3) & ~3;
    while (cursor + 6 <= end) { const next = versionBlock(cursor, end, [...parents, key]); cursor = (next + 3) & ~3; }
    return end;
  }
  function directory(offset: number, depth: number) {
    if (depth > 2) fail(); const at = relative(offset, 16), entries = u16(at + 12) + u16(at + 14);
    if (entries > 256) fail(); relative(offset + 16, entries * 8);
    for (let n = 0; n < entries; n++) {
      const item = at + 16 + n * 8, name = u32(item), target = u32(item + 4);
      if (!depth && name !== 16) continue;
      if (target & 0x80000000) directory(target & 0x7fffffff, depth + 1);
      else {
        if (depth !== 2) fail(); const entry = relative(target, 16), size = u32(entry + 4), data = mapped(u32(entry), size);
        if (size < 6 || size > 1024 * 1024) fail(); versionBlock(data, data + size);
      }
    }
  }
  directory(0, 0); if (versions.size !== 1) fail(); return [...versions][0];
}
