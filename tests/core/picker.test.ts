import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { prepareWindowsPicker } from '../../scripts/prepare-picker.mjs';
import { pickWindowsFile } from '../../src/local/server.ts';

const run = promisify(execFile);
const windows = process.platform === 'win32';
let directory = '', realPicker = '', protocolPicker = '';
before(async () => {
  if (!windows) return;
  directory = await mkdtemp(path.join(os.tmpdir(), 'cd-picker-'));
  realPicker = await prepareWindowsPicker(path.join(directory, 'real'));
  const source = path.join(directory, 'Protocol.cs');
  await writeFile(source, String.raw`using System; using System.IO; using System.Text; using System.Threading;
    class Protocol { static int Main(string[] args) {
      Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true });
      if (args.Length != 2 || args[0] != "--kind") return 2;
      if (args[1] == "folder") Console.Write(@"C:\CD 测试\窓の光 [TV]");
      else if (args[1] == "cover") Thread.Sleep(10000);
      return 0;
    } }`, 'utf8');
  protocolPicker = await prepareWindowsPicker(path.join(directory, 'protocol'), source);
});
after(async () => {
  if (directory) {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('the actual WinForms executable initializes even with Restricted PowerShell policy', { skip: !windows }, async () => {
  const result = await run(realPicker, ['--check'], {
    windowsHide: true, env: { ...process.env, PSExecutionPolicyPreference: 'Restricted' },
  });
  assert.equal(result.stdout, 'ready');
  assert.equal(result.stderr, '');
});
test('picker process round-trips paths containing spaces, Chinese and Japanese without a shell', { skip: !windows }, async () => {
  assert.equal(await pickWindowsFile('folder', new AbortController().signal, protocolPicker), 'C:\\CD 测试\\窓の光 [TV]');
});
test('a cancelled selection resolves to null instead of an error', { skip: !windows }, async () => {
  assert.equal(await pickWindowsFile('lyrics', new AbortController().signal, protocolPicker), null);
});
test('cancelling a pending picker terminates its process and rejects without late selection', { skip: !windows }, async () => {
  const controller = new AbortController();
  const pending = pickWindowsFile('cover', controller.signal, protocolPicker);
  const timer = setTimeout(() => controller.abort(), 30);
  try { await assert.rejects(pending, { name: 'AbortError' }); }
  finally { clearTimeout(timer); }
});
test('missing picker runtime reports an actionable IO error', { skip: !windows }, async () => {
  await assert.rejects(pickWindowsFile('folder', new AbortController().signal, path.join(directory, 'missing.exe')),
    (error: any) => error.code === 'io' && error.message.includes('文件是否完整'));
});
