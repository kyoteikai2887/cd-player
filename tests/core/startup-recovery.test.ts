import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { get } from 'node:http';
import { openLocalStore } from '../../src/local/store.ts';
import { startDesktopBackend } from '../../scripts/native-server.mjs';
import { startLocalServer } from '../../src/local/server.ts';

const roots: string[] = [];
after(async () => {
  for (const root of roots) {
    const rel = path.relative(path.resolve(tmpdir()), root);
    assert.ok(rel.startsWith('cd-player-startup-') && !rel.includes(path.sep));
    await rm(root, { recursive: true, force: true });
  }
});
async function directory() {
  const root = await mkdtemp(path.join(tmpdir(), 'cd-player-startup-'));
  roots.push(root);
  return root;
}
async function deadPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const pid = child.pid!;
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  return pid;
}

test('guarded desktop recovery preserves data and quarantines a legacy dead-owner lock', async () => {
  const root = await directory();
  const original = await openLocalStore(root);
  await original.transact(data => { data.library.revision = 7; data.settings.accentColor = '#123456'; });
  await original.close();
  const bytes = await readFile(path.join(root, 'library.json'));
  const stale = JSON.stringify({ pid: await deadPid() });
  await writeFile(path.join(root, 'writer.lock'), stale);
  const restored = await openLocalStore(root, { recoverDeadOwner: true });
  try {
    assert.equal(restored.view().library.revision, 7);
    assert.equal(restored.view().settings.accentColor, '#123456');
    const history = (await readdir(root)).filter(name => name.startsWith('writer.lock.stale-'));
    assert.equal(history.length, 1);
    assert.equal(await readFile(path.join(root, history[0]), 'utf8'), stale);
    assert.deepEqual(await readFile(path.join(root, 'library.json')), bytes);
  } finally { await restored.close(); }
  await assert.rejects(readFile(path.join(root, 'writer.lock')), { code: 'ENOENT' });
  const again = await openLocalStore(root, { recoverDeadOwner: true });
  await again.close();
});

test('live lock owners and simultaneous contenders are rejected without touching the lease', async () => {
  const root = await directory(), owner = await openLocalStore(root);
  try {
    const bytes = await readFile(path.join(root, 'writer.lock'));
    const contenders = await Promise.allSettled(Array.from({ length: 8 }, () => openLocalStore(root, { recoverDeadOwner: true })));
    assert.ok(contenders.every(result => result.status === 'rejected'));
    assert.deepEqual(await readFile(path.join(root, 'writer.lock')), bytes);
    assert.equal((await readdir(root)).filter(name => name.startsWith('writer.lock.stale-')).length, 0);
  } finally { await owner.close(); }
});

test('unverifiable, empty and malformed locks are retained instead of stealing ownership', async () => {
  const root = await directory();
  for (const lock of ['', '{broken', '{}', '{"pid":0}', '{"pid":-1}', '{"pid":2147483648}']) {
    await writeFile(path.join(root, 'writer.lock'), lock);
    await assert.rejects(openLocalStore(root, { recoverDeadOwner: true }), /锁的状态无法确认/);
    assert.equal(await readFile(path.join(root, 'writer.lock'), 'utf8'), lock);
  }
});

test('unguarded local entry never reclaims even a confirmed dead-owner lock', async () => {
  const root = await directory(), bytes = JSON.stringify({ pid: await deadPid() });
  await writeFile(path.join(root, 'writer.lock'), bytes);
  await assert.rejects(openLocalStore(root));
  assert.equal(await readFile(path.join(root, 'writer.lock'), 'utf8'), bytes);
});

test('closing a store does not remove a replacement writer lease', async () => {
  const root = await directory(), owner = await openLocalStore(root);
  const replacement = JSON.stringify({ pid: process.pid, token: 'replacement-owner' });
  await writeFile(path.join(root, 'writer.lock'), replacement);
  await owner.close();
  assert.equal(await readFile(path.join(root, 'writer.lock'), 'utf8'), replacement);
});

test('desktop backend propagates guarded recovery and releases its lease on shutdown', async () => {
  const root = await directory(), assets = path.join(root, 'web'), data = path.join(root, 'data');
  await mkdir(assets); await mkdir(data);
  await writeFile(path.join(assets, 'desktop.html'), '<!doctype html><title>test</title>');
  await writeFile(path.join(data, 'writer.lock'), JSON.stringify({ pid: await deadPid() }));
  const backend = await startDesktopBackend({ directory: data, assets, recoverDeadOwner: true });
  try { assert.equal((await fetch(backend.origin + '/desktop.html')).status, 200); }
  finally { await backend.close(); }
  await assert.rejects(readFile(path.join(data, 'writer.lock')), { code: 'ENOENT' });
});

test('native CLI returns a structured startup failure instead of only invisible stderr', async () => {
  const root = await directory(), assets = path.join(root, 'web'), data = path.join(root, 'data');
  await mkdir(assets); await mkdir(data);
  const bytes = JSON.stringify({ pid: process.pid });
  await writeFile(path.join(data, 'writer.lock'), bytes);
  const entry = pathToFileURL(path.resolve('scripts/native-server.mjs')).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `globalThis.CD_DESKTOP_ENTRY=true; await import(${JSON.stringify(entry)});`, 'native-test-entry',
    '--data', data, '--assets', assets, '--picker', path.join(root, 'unused.exe'), '--recover-stale-lock']);
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.resume();
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
  const frame = JSON.parse(output.trim());
  assert.equal(frame.startupError.code, 'unavailable');
  assert.match(frame.startupError.message, /资料库正在使用/);
  assert.equal(await readFile(path.join(data, 'writer.lock'), 'utf8'), bytes);
});

test('shutdown closes lingering client streams so the writer can release before native timeout', async () => {
  const root = await directory(), store = await openLocalStore(root);
  const server = await startLocalServer({ store, dataDirectory: root, port: 0,
    middleware(_req, res) { res.writeHead(200); res.write('unfinished streaming response'); } });
  let request: ReturnType<typeof get> | undefined, shutdown: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      request = get(server.origin + '/slow-client', res => { res.pause(); res.on('error', () => {}); resolve(); });
      request.on('error', reject);
    });
    shutdown = server.close();
    await Promise.race([shutdown, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Active client kept shutdown pending')), 1500);
    })]);
  } finally {
    clearTimeout(timer); request?.destroy();
    await (shutdown ?? server.close()); await store.close();
  }
  const reopened = await openLocalStore(root);
  await reopened.close();
});
