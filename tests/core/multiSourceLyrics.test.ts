import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoData } from '../../src/mock/fixtures.ts';
import { parseLyrics } from '../../src/core/lyrics.ts';
import { createOnlineServices } from '../../src/local/online/providers.ts';
import { createOnlineHttp, ONLINE_USER_AGENT } from '../../src/local/online/http.ts';
import { prepareLyricsReview } from '../../src/local/online/candidates.ts';
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
const enc = (v: string) => Buffer.from(v).toString('base64');
function fixture() {
  const data = createDemoData(), track = data.library.tracks[0], album = data.library.albums.find(a => a.id === track.albumId)!;
  Object.assign(track, { title: '窓の光', artistCredit: '空野ミオ', artists: ['空野ミオ'], durationMs: 180000 });
  Object.assign(album, { title: '原创收藏', albumArtists: ['空野ミオ'] });
  return { track, album, document: parseLyrics('', track.id) };
}
function fake(run: (url: URL, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (url, init) => run(new URL(String(url)), init)) as typeof fetch;
}
function records(f: ReturnType<typeof fixture>, url: URL, init?: RequestInit) {
  if (url.hostname === 'lrclib.net') return json([{ id: 1, trackName: f.track.title, artistName: f.track.artistCredit,
    albumName: f.album.title, duration: 180, syncedLyrics: '[00:01]原创一\n[00:02]原创二' }]);
  if (url.hostname === 'u.y.qq.com') {
    assert.equal(init?.method, 'POST');
    assert.equal((init?.headers as Record<string, string>)['Content-Type'], 'application/json');
    const request = JSON.parse(String(init!.body)).request;
    return json({ code: 0, request: { code: 0, data: request.method === 'DoSearchForQQMusicLite' ? {
      body: { item_song: [{ id: 1, title: f.track.title, singer: [{ name: f.track.artistCredit }], album: { name: f.album.title }, interval: 180 }] },
    } : { crypt: 0, qrc: 0, lyric: enc('[00:01]原创 &amp; 一\n[00:02]原创二'), trans: enc('[00:01.020]译文一\n[00:02]译文二') } } });
  }
  if (url.hostname === 'music.163.com') return json(url.pathname.endsWith('/pc') ? { code: 200, result: { songs: [
    { id: 1, name: f.track.title, ar: [{ name: f.track.artistCredit }], al: { name: f.album.title }, dt: 180020 },
  ] } } : { code: 200, lrc: { lyric: '[offset:100]\n[00:01.100]原创一\n[00:02.100]原创二' },
    tlyric: { lyric: '[00:01]译文一\n[00:02]译文二\n[00:09]无法配对' } });
  return json(url.pathname === '/search' ? { status: 200, candidates: [
    { id: '1', song: f.track.title, singer: f.track.artistCredit, accesskey: 'synthetic-key', duration: 180050 },
  ] } : { status: 200, fmt: 'lrc', content: enc('[00:01]原创一\n[00:02]原创二') });
}
test('four sources merge as previews with distinct source IDs, correct timing and safely paired translations', async () => {
  const f = fixture(), before = JSON.stringify(f), urls: URL[] = [];
  const services = createOnlineServices({ sleep: async () => {}, fetch: fake((url, init) => {
    urls.push(url); assert.equal((init?.headers as Record<string, string>)['User-Agent'], ONLINE_USER_AGENT);
    if (url.hostname !== 'u.y.qq.com') { assert.equal(init?.method, undefined); assert.equal(init?.body, undefined); }
    return records(f, url, init);
  }) });
  const result = await services.searchLyricsSources!(f.track, f.album, new AbortController().signal);
  assert.equal(result.records.length, 4); assert.ok(result.sources.every(s => s.status === 'ready' && s.count === 1));
  const p = prepareLyricsReview(f.track, f.album, f.document, result.records);
  assert.equal(p.review.candidates.length, 4); assert.equal(f.document.kind, 'missing');
  assert.equal(JSON.stringify(f), before); assert.equal(new Set(p.review.candidates.map(c => c.provider)).size, 4);
  const qq = result.records.find(r => r.provider === 'QQ 音乐')!, ne = result.records.find(r => r.provider === '网易云音乐')!;
  assert.equal(qq.document.lines[0].original, '原创 & 一'); assert.equal(qq.document.translationStatus, 'available');
  assert.equal(ne.document.lines[0].startMs, 1000); assert.equal(ne.document.lines[0].translation, '译文一');
  assert.equal(ne.document.source.translation?.name, '网易云音乐');
  assert.ok(p.review.candidates.find(c => c.provider === '网易云音乐')!.warnings.some(w => w.includes('无法安全配对')));
  assert.ok(urls.every(u => u.protocol === 'https:' && !u.href.includes('file:') && !u.href.includes('audio')));
  assert.equal(result.records.find(r => r.provider === '酷狗音乐')!.albumTitle, '');
});
test('one failed source keeps other candidates and warns in the existing candidate UI data', async () => {
  const f = fixture(), services = createOnlineServices({ sleep: async () => {}, fetch: fake(url =>
    url.hostname === 'u.y.qq.com' ? json({}, 503) : records(f, url)) });
  const found = await services.searchLyrics!(f.track, f.album, new AbortController().signal);
  assert.equal(found.length, 3);
  assert.ok(prepareLyricsReview(f.track, f.album, f.document, found).review.candidates.every(c => c.warnings.some(w => w.includes('QQ 音乐'))));
});
test('failed searches are distinct from all sources successfully returning no results', async () => {
  const f = fixture(), services = createOnlineServices({ sleep: async () => {}, fetch: fake(url =>
    url.hostname === 'lrclib.net' ? json([]) : url.hostname === 'u.y.qq.com' ? json({ code: 0, request: { code: 0, data: { body: { item_song: [] } } } }) :
      url.hostname === 'music.163.com' ? json({ code: 200, result: { songCount: 0 } }) : json({ status: 200, candidates: [] })) });
  assert.deepEqual(await services.searchLyrics!(f.track, f.album, new AbortController().signal), []);
  const failed = createOnlineServices({ sleep: async () => {}, lyricSources: ['qq'], fetch: fake(() => json({ code: 1000 })) });
  await assert.rejects(failed.searchLyrics!(f.track, f.album, new AbortController().signal), /QQ 音乐查询未完成/);
});
test('same-source failed lyric detail does not discard previously retrieved lyrics', async () => {
  const f = fixture(); let details = 0;
  const s = createOnlineServices({ lyricSources: ['netease'], sleep: async () => {}, fetch: fake(url => {
    if (url.pathname.endsWith('/pc')) return json({ code: 200, result: { songs: [1, 2].map(id => ({ id, name: f.track.title,
      ar: [{ name: f.track.artistCredit }], al: { name: f.album.title }, dt: 180000 })) } });
    details++; return url.searchParams.get('id') === '1' ? records(f, url) : json({}, 500);
  }) });
  const result = await s.searchLyricsSources!(f.track, f.album, new AbortController().signal);
  assert.equal(details, 2); assert.equal(result.records.length, 1); assert.equal(result.sources[0].status, 'partial');
});
test('unrelated search hits, duplicate song IDs and irrelevant artists do not spend lyric downloads', async () => {
  const f = fixture(); let details = 0;
  const s = createOnlineServices({ lyricSources: ['netease'], sleep: async () => {}, fetch: fake(url => {
    if (url.pathname.endsWith('/pc')) return json({ code: 200, result: { songs: [
      { id: 1, name: '其他曲目', ar: [{ name: f.track.artistCredit }] },
      { id: 2, name: f.track.title, ar: [{ name: '其他人' }] },
      ...[3, 3].map(id => ({ id, name: f.track.title, ar: [{ name: f.track.artistCredit }] })),
    ] } });
    details++; return records(f, url);
  }) });
  const found = await s.searchLyrics!(f.track, f.album, new AbortController().signal);
  assert.equal(details, 1); assert.equal(found.length, 1);
});
test('downloads stay bounded across credit variants; unknown durations remain unknown', async () => {
  const f = fixture(); f.track.artistCredit = '空野ミオ & 月野ユイ'; let details = 0;
  const s = createOnlineServices({ lyricSources: ['netease'], sleep: async () => {}, fetch: fake(url => {
    if (url.pathname.endsWith('/pc')) return json({ code: 200, result: { songs: Array.from({ length: 20 }, (_, i) => ({ id: i + 1,
      name: f.track.title + ' (TV Size)', ar: [{ name: '空野ミオ' }, { name: '月野ユイ' }] })) } });
    details++; return records(f, url);
  }) });
  const found = await s.searchLyrics!(f.track, f.album, new AbortController().signal);
  assert.equal(details, 4); assert.ok(found.every(r => r.durationMs === null));
  assert.ok(prepareLyricsReview(f.track, f.album, f.document, found).review.candidates.every(c => c.match === 'check' && c.warnings.some(w => w.includes('时长'))));
});
test('explicit title-only search sends the revised terms without mutating collection credits', async () => {
  const f = fixture(), urls: URL[] = [];
  const s = createOnlineServices({ lyricSources: ['kugou'], sleep: async () => {}, fetch: fake(url => { urls.push(url); return records(f, url); }) });
  const before = JSON.stringify(f.track);
  await s.searchLyrics!(f.track, f.album, new AbortController().signal, { title: f.track.title, artist: '' });
  assert.equal(urls[0].searchParams.get('keyword'), f.track.title); assert.equal(JSON.stringify(f.track), before);
});
test('ordinary lyric search never consumes encrypted QRC, KRC or invalid UTF-8 as visible text', async () => {
  const f = fixture();
  const s = createOnlineServices({ lyricSources: ['qq', 'kugou'], sleep: async () => {}, fetch: fake((url, init) => {
    if (url.hostname === 'u.y.qq.com' && JSON.parse(String(init!.body)).request.method !== 'DoSearchForQQMusicLite')
      return json({ code: 0, request: { code: 0, data: { crypt: 1, qrc: 1, lyric: enc('[00:01]不应显示') } } });
    if (url.hostname === 'lyrics.kugou.com' && url.pathname === '/download') return json({ status: 200, fmt: 'lrc', content: Buffer.from([0xff, 0xfe, 0xfd]).toString('base64') });
    return records(f, url, init);
  }) });
  await assert.rejects(s.searchLyrics!(f.track, f.album, new AbortController().signal), /查询未完成/);
});
test('cancel aborts every source request and no late candidate list is returned', async () => {
  const f = fixture(), controller = new AbortController(); let started = 0, aborted = 0;
  const s = createOnlineServices({ sleep: async () => {}, fetch: fake((_url, init) => new Promise((_resolve, reject) => {
    started++; init!.signal!.addEventListener('abort', () => { aborted++; reject(Error('cancelled')); }, { once: true });
  })) });
  const pending = s.searchLyrics!(f.track, f.album, controller.signal);
  await new Promise(r => setTimeout(r, 15)); assert.equal(started, 4); controller.abort();
  await assert.rejects(pending, /取消/); assert.equal(aborted, 4);
});
test('per-source budget limits unresponsive services while preserving an available result', async () => {
  const f = fixture();
  const s = createOnlineServices({ lyricSources: ['lrclib', 'qq'], lyricSourceTimeoutMs: 20, sleep: async () => {}, fetch: fake((url, init) => {
    if (url.hostname === 'lrclib.net') return records(f, url);
    return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(Error('timeout')), { once: true }));
  }) });
  const result = await s.searchLyricsSources!(f.track, f.album, new AbortController().signal);
  assert.equal(result.records.length, 1); assert.equal(result.sources[1].status, 'failed'); assert.match(result.sources[1].message!, /超时/);
});
test('source allowlists reject media endpoints, plain HTTP and cross-source redirects before sending', async () => {
  let calls = 0;
  const http = createOnlineHttp({ sleep: async () => {}, fetch: fake(() => { calls++; return json({}, 302); }) });
  for (const [url, source] of [ ['https://music.163.com/song/media/outer/url?id=1', 'netease'],
    ['http://lyrics.kugou.com/download?id=1', 'kugou'], ['https://u.y.qq.com.evil.example/cgi-bin/musicu.fcg', 'qq'] ] as const)
    await assert.rejects(http.json(url, source, new AbortController().signal), /地址/);
  assert.equal(calls, 0);
  const redirect = createOnlineHttp({ sleep: async () => {}, fetch: fake(() => { calls++; return new Response(null, { status: 302, headers: { location: 'https://evil.example/lyrics' } }); }) });
  await assert.rejects(redirect.json('https://lyrics.kugou.com/search', 'kugou', new AbortController().signal), /地址/);
  assert.equal(calls, 1);
});
test('strict automatic lookup contacts only LRCLIB and cannot adopt additional-source candidates', async () => {
  const f = fixture(), hosts: string[] = [];
  const s = createOnlineServices({ sleep: async () => {}, fetch: fake(url => { hosts.push(url.hostname); return url.pathname.endsWith('/get') ? json(null, 404) : json([]); }) });
  assert.equal(await s.lyrics(f.track, f.album, new AbortController().signal), null);
  assert.ok(hosts.length > 0 && hosts.every(h => h === 'lrclib.net'));
});
test('a large source result cannot remove all alternatives from the twelve candidate slots', () => {
  const f = fixture(), doc = parseLyrics('[00:01]原创', f.track.id);
  const records = Array.from({ length: 20 }, (_, i) => ({ provider: 'LRCLIB', recordId: String(i + 1), title: f.track.title,
    artistCredit: f.track.artistCredit, albumTitle: f.album.title, durationMs: f.track.durationMs, document: doc }));
  for (const provider of ['QQ 音乐', '网易云音乐', '酷狗音乐']) records.push({ ...records[0], provider, recordId: '999', albumTitle: '' });
  const p = prepareLyricsReview(f.track, f.album, f.document, records);
  assert.equal(p.review.candidates.length, 12); assert.equal(p.documents.size, 12);
  assert.equal(new Set(p.review.candidates.map(c => c.provider)).size, 4);
});
test('malformed lyric responses are not cached as a successful result and a retry can recover', async () => {
  const f = fixture(); let details = 0;
  const s = createOnlineServices({ lyricSources: ['kugou'], sleep: async () => {}, fetch: fake(url => {
    if (url.pathname === '/search') return records(f, url);
    details++; return details === 1 ? json({ status: 200, fmt: 'lrc', content: 'invalid????' }) : records(f, url);
  }) });
  await assert.rejects(s.searchLyrics!(f.track, f.album, new AbortController().signal), /查询未完成/);
  assert.equal((await s.searchLyrics!(f.track, f.album, new AbortController().signal)).length, 1); assert.equal(details, 2);
});
test('wrapped empty source results expire after one hour rather than hiding new lyrics for a week', async () => {
  let now = 1000, calls = 0;
  const http = createOnlineHttp({ now: () => now, sleep: async () => {}, fetch: fake(() => { calls++; return json({ status: 200, candidates: [] }); }) });
  const url = 'https://lyrics.kugou.com/search?keyword=imaginary', signal = new AbortController().signal;
  await http.json(url, 'kugou', signal); now += 1000; await http.json(url, 'kugou', signal); assert.equal(calls, 1);
  now += 3600000; await http.json(url, 'kugou', signal); assert.equal(calls, 2);
});
test('QQ POST cache keys distinguish query bodies and cannot enable POST to other services', async () => {
  let calls = 0;
  const http = createOnlineHttp({ sleep: async () => {}, fetch: fake((_url, init) => { calls++; return json({ body: init!.body }); }) });
  const url = 'https://u.y.qq.com/cgi-bin/musicu.fcg', signal = new AbortController().signal;
  assert.deepEqual(await http.json(url, 'qq', signal, undefined, '{"query":"甲"}'), { body: '{"query":"甲"}' });
  assert.deepEqual(await http.json(url, 'qq', signal, undefined, '{"query":"乙"}'), { body: '{"query":"乙"}' });
  await http.json(url, 'qq', signal, undefined, '{"query":"甲"}'); assert.equal(calls, 2);
  await assert.rejects(http.json('https://musicbrainz.org/ws/2/release/', 'musicbrainz', signal, undefined, '{}'), /不支持/);
  await assert.rejects(http.json(url, 'qq', signal, undefined, 'x'.repeat(64001)), /不支持/);
  assert.equal(calls, 2);
});
