import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createDemoData } from '../src/mock/fixtures.ts';
import { openLocalStore } from '../src/local/store.ts';

// Manual Windows visual review only: fictional 20-album/300-track collection, isolated data and profile.
// The existing debug-only --smoke-manual mode terminates cleanly when report.stop is created.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.join(root, '.cache', 'ui-r2-1-' + Date.now());
await mkdir(workspace, { recursive: true });
const directory = path.join(workspace, 'data'), report = path.join(workspace, 'report.json');
const demo = createDemoData('large'), templates = createDemoData().library.albums;
// Require an explicit, previously generated synthetic fixture; never default to user's music.
const args = process.argv.slice(2);
assert.ok(args.length === 2 && args[0] === '--fixture' && path.isAbsolute(args[1]), 'Usage: node scripts/ui-r2-1-smoke.mjs --fixture <absolute synthetic 10-minute FLAC>');
const input = args[1];
const info = await stat(input);
const store = await openLocalStore(directory);
try {
  await store.transact(data => {
    data.library = demo.library;
    data.lyricsByTrack = demo.lyricsByTrack;
    data.settings = { ...demo.settings, background: 'blue', accentColor: '#6CACE4',
      glassIntensity: 0.65, motion: 'full' };
    demo.library.albums.forEach((album, i) => {
      const template = templates[i % templates.length];
      album.cover = template.cover ? { ...template.cover } : null;
      album.title = template.title + ' · ' + (i + 1);
      album.albumArtistCredit = template.albumArtistCredit;
      album.addedAt += i;
    });
    for (const track of data.library.tracks) {
      track.durationMs = 600000;
      data.files[track.id] = { path: input, size: info.size, mtimeMs: info.mtimeMs };
    }
  });
} finally { await store.close(); }
const child = spawn(path.join(root, 'src-tauri/target/debug/cd-player-desktop.exe'),
  ['--smoke-data', directory, '--smoke-report', report, '--smoke-manual'],
  { cwd: root, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
const completed = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
await writeFile(path.join(workspace, 'session.json'), JSON.stringify({ pid: child.pid, directory, report, stop: report.replace(/\.json$/, '.stop'),
  uiRound: 'R2.1', version: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version,
  albums: 20, tracks: 300, playbackInitiallyStopped: true, realMusicUsed: false, defaultUserDataModified: false }, null, 2));
console.log(JSON.stringify({ workspace, pid: child.pid, stop: report.replace(/\.json$/, '.stop') }));
const exit = await completed;
assert.equal(exit, 0, 'Native manual QA did not exit successfully');
const result = JSON.parse(await readFile(report, 'utf8'));
assert.equal(result.passed, true);
assert.equal(result.libraryAlbums, 20); assert.equal(result.libraryTracks, 300);
const reopened = await openLocalStore(directory);
try { assert.equal(reopened.view().library.tracks.length, 300); } finally { await reopened.close(); }
console.log(JSON.stringify({ report, passed: true, exit, storeReopened: true }));
