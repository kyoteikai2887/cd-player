import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { scanFolder } from '../src/local/scanner.ts';
import { parseLyrics } from '../src/core/lyrics.ts';
import { createOnlineServices } from '../src/local/online/providers.ts';
import { prepareLyricsReview } from '../src/local/online/candidates.ts';

// Run only with a folder whose owner explicitly authorized metadata-only online queries.
const folder = process.argv[2];
if (!folder || !path.isAbsolute(folder)) throw Error('An explicitly authorized absolute music folder is required.');
const output = path.resolve('.cache', 'lyrics-candidates-live-' + Date.now());
await mkdir(output, { recursive: true });
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 240000);
const results = [];
try {
  const scan = await scanFolder(folder, path.join(output, 'covers'), controller.signal);
  const services = createOnlineServices({ directory: path.join(output, 'private-cache') });
  for (const track of scan.tracks) {
    const album = scan.albums.find(a => a.id === track.albumId);
    try {
      const search = await services.searchLyricsSources(track, album, controller.signal);
      const records = search.records;
      const missing = parseLyrics('', track.id);
      missing.locked = false;
      const { review } = prepareLyricsReview(track, album, missing, records);
      results.push({ title: track.title, album: album.title, durationMs: track.durationMs, success: true, sources: search.sources,
        candidateCount: review.candidates.length, closeCount: review.candidates.filter(c => c.match === 'close').length,
        candidates: review.candidates.map(c => ({ provider: c.provider, recordId: c.recordId, title: c.title,
          artistCredit: c.artistCredit, albumTitle: c.albumTitle, durationMs: c.durationMs,
          durationDeltaMs: c.durationDeltaMs, match: c.match, kind: c.document.kind, warnings: c.warnings })) });
    } catch (error) {
      results.push({ title: track.title, success: false, code: error.code, message: error.message });
    }
    console.log(JSON.stringify({ title: track.title, ...results.at(-1), candidates: undefined }));
  }
  const report = { output, explicitUserAuthorization: true, tested: results.length,
    tracksWithCandidates: results.filter(r => r.success && r.candidateCount > 0).length,
    defaultStoreModified: false, originalMusicModified: false, musicOrPathsUploaded: false,
    fullLyricsIncludedInReport: false, results };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, tested: report.tested, tracksWithCandidates: report.tracksWithCandidates }));
} finally { clearTimeout(timer); }
