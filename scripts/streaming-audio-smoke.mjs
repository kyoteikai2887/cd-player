import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createAudioFolder } from '../tests/helpers/audioFiles.ts';
import { openLocalStore } from '../src/local/store.ts';
import { scanFolder, mergeScan } from '../src/local/scanner.ts';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(project, '.cache', 'audio-streaming-' + Date.now());
const music = path.join(directory, 'original-fixtures');
await createAudioFolder(music, 6);
async function largeWav(name, rate, bits, seconds) {
  const channels = 2, frameBytes = channels * bits / 8;
  const header = Buffer.alloc(44), size = rate * seconds * frameBytes;
  header.write('RIFF'); header.writeUInt32LE(size + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * frameBytes, 28);
  header.writeUInt16LE(frameBytes, 32); header.writeUInt16LE(bits, 34);
  header.write('data', 36); header.writeUInt32LE(size, 40);
  const second = Buffer.alloc(rate * frameBytes);
  for (let i = 0; i < rate; i++) {
    const sample = Math.round(Math.sin(i * 2 * Math.PI * 440 / rate) * (bits === 16 ? 400 : 100000));
    for (let channel = 0; channel < channels; channel++) second.writeIntLE(sample, i * frameBytes + channel * bits / 8, bits / 8);
  }
  const handle = await open(path.join(music, name + '.wav'), 'wx');
  try { await handle.write(header); for (let i = 0; i < seconds; i++) await handle.write(second); }
  finally { await handle.close(); }
  return { title: name, sampleRate: rate, channels, bitsPerSample: bits, seconds, bytes: size + 44 };
}
const fixtures = [await largeWav('01 Long WAV', 44100, 16, 600), await largeWav('02 HiRes WAV', 192000, 24, 128)];
const dataDirectory = path.join(directory, 'data');
const store = await openLocalStore(dataDirectory);
try {
  const scan = await scanFolder(music, path.join(dataDirectory, 'covers'), new AbortController().signal);
  if (scan.warnings.length || scan.tracks.length !== 6) throw new Error(JSON.stringify(scan.warnings));
  await store.transact(data => mergeScan(data, scan));
} finally { await store.close(); }
await writeFile(path.join(directory, 'fixtures.json'), JSON.stringify(fixtures, null, 2));
const reports = [];
for (const mode of ['adaptive', 'streaming']) {
  const report = path.join(directory, mode + '.json');
  const child = spawn(path.join(project, 'src-tauri/target/debug/cd-player-desktop.exe'),
    ['--smoke-data', dataDirectory, '--smoke-report', report, '--smoke-audio', ...(mode === 'streaming' ? ['--smoke-stream-only'] : [])],
    { cwd: project, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
  const timer = setTimeout(() => child.kill(), 60000);
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }).finally(() => clearTimeout(timer));
  const result = JSON.parse(await readFile(report, 'utf8'));
  const reopened = await openLocalStore(dataDirectory); await reopened.close();
  reports.push({ ...result, mode, exit, report });
  if (!result.passed || exit !== 0) throw new Error(JSON.stringify(reports, null, 2));
}
const result = { passed: true, reports, fixtures };
await writeFile(path.join(directory, 'report.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, summaryPath: path.join(directory, 'report.json') }, null, 2));
