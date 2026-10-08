import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeProductVersion } from '../../scripts/native-version.ts';
import { nativeVersionFixture } from './nativeVersion.fixture.ts';

test('formal and prerelease versions are read from UTF-16 Windows resources in PE32 and PE32+', () => {
  for (const version of ['1.0.0', '0.4.0-original-test.1']) for (const pe32 of [false, true]) {
    const exe = nativeVersionFixture(version, pe32);
    assert.equal(exe.includes(Buffer.from(version)), false);
    assert.equal(nativeProductVersion(exe), version);
  }
});
test('incidental version strings cannot replace a missing or different native product version', () => {
  assert.throws(() => nativeProductVersion(Buffer.from('MZ unrelated 1.0.0'.padEnd(100))), /version/);
  const exe = Buffer.concat([nativeVersionFixture('2.0.0'), Buffer.from('incidental 1.0.0')]);
  assert.equal(nativeProductVersion(exe), '2.0.0');
});
test('truncated and out-of-range PE or version resources are rejected', () => {
  const exe = nativeVersionFixture('1.0.0');
  for (const length of [0, 63, 130, 0x250, exe.length - 20]) assert.throws(() => nativeProductVersion(exe.subarray(0, length)), /version/);
  for (const [offset, value, size] of [[0x3c, 0xfffffffc, 4], [0x214, 0x800ffff0, 4], [0x248, 0xfffffff0, 4], [0x280, 0xffff, 2], [0x284, 9, 2]]) {
    const invalid = Buffer.from(exe); if (size === 4) invalid.writeUInt32LE(value, offset); else invalid.writeUInt16LE(value, offset);
    assert.throws(() => nativeProductVersion(invalid), /version/);
  }
});
