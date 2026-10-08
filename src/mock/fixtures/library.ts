import type { Album, LibrarySnapshot, Track } from '../../contracts/player.ts';

/** Original fictional collection; each call owns all nested objects. */
export function createDemoLibrary(): LibrarySnapshot {
  const album = (id: string, title: string, artists: string[], trackIds: string[], cover: string | null): Album => ({
    id, title, albumArtists: artists, albumArtistCredit: artists.join(' / '), trackIds,
    cover: cover ? { thumbUrl: cover, fullUrl: cover, width: 600, height: 600 } : null,
    revision: 0, workTitle: null, releaseYear: 2026, catalogNumber: null, label: null,
    language: 'ja', titleSort: null, discs: [{ number: 1 }], addedAt: Date.UTC(2026, 9, 3),
    metadataStatus: 'unmatched', userEditedFields: [],
    rip: { hasLog: true, hasCue: true, accurateRip: 'unknown' },
  });
  const track = (id: string, albumId: string, title: string, artists: string[], number: number, durationMs: number): Track => ({
    id, albumId, title, artists, artistCredit: artists.join(' / '), revision: 0, available: true,
    discNumber: 1, trackNumber: number, durationMs, language: 'ja', versionKind: null,
    versionLabel: null, userEditedFields: [],
  });
  const albums = [
    album('album-blue', '蒼い窓辺 — Original Soundtrack', ['空色アンサンブル'], ['track-blue', 'track-tv', 'track-piano'], '/covers/blue.svg'),
    album('album-white', '白い軌道 — Character Songs', ['Various Artists'], ['track-plain', 'track-missing', 'track-spoken'], '/covers/white.svg'),
    album('album-no-cover', '星の図書室 — Disc 1 & 2', ['月野ユイ'], ['track-partial', 'track-disc2'], null),
  ];
  albums[0].workTitle = '蒼い窓辺'; albums[0].catalogNumber = 'DEMO-001';
  albums[2].releaseYear = 2025; albums[2].discs.push({ number: 2, title: '朝の図書室' });
  const tracks = [
    track('track-blue', 'album-blue', '窓辺の青', ['空野ミオ', '月野ユイ'], 1, 180000),
    track('track-tv', 'album-blue', '窓辺の青', ['空野ミオ', '月野ユイ'], 2, 90000),
    track('track-piano', 'album-blue', '午後の光', ['空色アンサンブル'], 3, 120000),
    track('track-plain', 'album-white', '白い軌道', ['星野レナ', '月野ユイ'], 1, 160000),
    track('track-missing', 'album-white', '次のページへ', ['月野ユイ'], 2, 140000),
    track('track-spoken', 'album-white', '収録後のお話', ['星野レナ'], 3, 60000),
    track('track-partial', 'album-no-cover', '星の栞', ['月野ユイ'], 1, 150000),
    track('track-disc2', 'album-no-cover', '朝の図書室', ['月野ユイ'], 1, 110000),
  ];
  tracks[0].artistCredit = tracks[1].artistCredit = '空野ミオ (CV.月野ユイ)';
  tracks[0].versionKind = 'full'; tracks[0].versionLabel = 'Full version';
  tracks[1].versionKind = 'short'; tracks[1].versionLabel = 'TV size';
  tracks[7].discNumber = 2;
  albums[0].label = '架空レコード'; albums[0].releaseYear = 2026;
  albums[1].workTitle = '白い軌道';

  // Claude R1: a fuller fictional shelf (all names, titles, lyrics and covers are invented).
  // Appended after the original entries so existing indices and IDs stay unchanged.
  const more: Album[] = [
    album('album-soda', 'ソーダ色の放課後', ['Lumière Note'],
      ['track-soda', 'track-soda-promise', 'track-soda-tv', 'track-soda-off'], '/covers/soda.svg'),
    album('album-starsea', '星海航路 Original Game Soundtrack', ['架空サウンドチーム'],
      ['track-sea-title', 'track-sea-morning', 'track-sea-chart', 'track-sea-storm', 'track-sea-home'], '/covers/starsea.svg'),
    album('album-radio', '夜明けのラジオ Drama CD Vol.1', ['星野レナ', '月野ユイ'],
      ['track-radio-talk', 'track-radio-drama', 'track-radio-ed'], '/covers/radio.svg'),
    album('album-rain', '雨音コンサート 2025 (Live)', ['空色アンサンブル'],
      ['track-rain-blue', 'track-rain-mc', 'track-rain-light'], '/covers/rain.svg'),
    album('album-spring', '春風ステップ — Character Song Series 03', ['春野ひより'],
      ['track-spring', 'track-spring-off'], '/covers/spring.svg'),
  ];
  const [soda, sea, radio, rain, spring] = more;
  Object.assign(soda, { workTitle: '放課後ソーダ部', catalogNumber: 'DEMO-1041', label: '架空レコード', releaseYear: 2024,
    addedAt: Date.UTC(2026, 8, 12), metadataStatus: 'matched', rip: { hasLog: true, hasCue: true, accurateRip: 'verified' } });
  Object.assign(sea, { workTitle: '星海航路', catalogNumber: 'DEMO-2077', label: '架空ゲームス', releaseYear: 2023,
    addedAt: Date.UTC(2026, 7, 2), metadataStatus: 'matched', discs: [{ number: 1, title: '航海編' }, { number: 2, title: '帰港編' }],
    rip: { hasLog: true, hasCue: true, accurateRip: 'partial' } });
  Object.assign(radio, { workTitle: '白い軌道', catalogNumber: 'DEMO-3010', releaseYear: 2025, albumArtistCredit: '星野レナ、月野ユイ',
    addedAt: Date.UTC(2026, 9, 1), metadataStatus: 'partial' });
  Object.assign(rain, { releaseYear: 2025, addedAt: Date.UTC(2026, 6, 20), metadataStatus: 'partial',
    rip: { hasLog: false, hasCue: true, accurateRip: 'unknown' } });
  Object.assign(spring, { workTitle: '放課後ソーダ部', catalogNumber: 'DEMO-1043', label: '架空レコード', releaseYear: 2024,
    albumArtistCredit: '春野ひより (CV.水城ことり)', addedAt: Date.UTC(2026, 8, 30), metadataStatus: 'matched',
    userEditedFields: ['albumArtistCredit'] });
  albums.push(...more);

  const t = (id: string, albumId: string, title: string, artists: string[], number: number, durationMs: number,
    extra: Partial<Track> = {}): Track => ({ ...track(id, albumId, title, artists, number, durationMs), ...extra });
  tracks.push(
    t('track-soda', 'album-soda', 'ソーダ色の放課後', ['Lumière Note'], 1, 248000, { versionKind: 'full' }),
    t('track-soda-promise', 'album-soda', 'ふたりの約束', ['Lumière Note'], 2, 231000),
    t('track-soda-tv', 'album-soda', 'ソーダ色の放課後', ['Lumière Note'], 3, 89000, { versionKind: 'short', versionLabel: 'TV size' }),
    t('track-soda-off', 'album-soda', 'ソーダ色の放課後', ['Lumière Note'], 4, 248000, { versionKind: 'offVocal', versionLabel: 'off vocal' }),
    t('track-sea-title', 'album-starsea', 'Title Theme — 星海航路', ['架空サウンドチーム'], 1, 102000),
    t('track-sea-morning', 'album-starsea', '出航の朝', ['架空サウンドチーム'], 2, 154000),
    t('track-sea-chart', 'album-starsea', '静かな海図', ['架空サウンドチーム'], 3, 188000),
    t('track-sea-storm', 'album-starsea', '嵐の前', ['架空サウンドチーム'], 1, 143000, { discNumber: 2 }),
    t('track-sea-home', 'album-starsea', '帰港', ['架空サウンドチーム'], 2, 201000, { discNumber: 2 }),
    t('track-radio-talk', 'album-radio', 'オープニングトーク', ['星野レナ', '月野ユイ'], 1, 312000, { artistCredit: '星野レナ、月野ユイ' }),
    t('track-radio-drama', 'album-radio', 'ドラマ「夜明けの約束」', ['星野レナ', '月野ユイ'], 2, 1265000, { artistCredit: '星野レナ、月野ユイ' }),
    t('track-radio-ed', 'album-radio', '朝を待つ', ['星野レナ', '月野ユイ'], 3, 214000,
      { artistCredit: '白波ルカ (CV.星野レナ)、黒羽ミナ (CV.月野ユイ)' }),
    t('track-rain-blue', 'album-rain', '窓辺の青', ['空色アンサンブル', '空野ミオ'], 1, 236000,
      { versionKind: 'live', versionLabel: 'Live', artistCredit: '空色アンサンブル feat. 空野ミオ' }),
    t('track-rain-mc', 'album-rain', 'MC', ['空色アンサンブル'], 2, 95000, { versionKind: 'other', versionLabel: 'MC' }),
    t('track-rain-light', 'album-rain', '午後の光', ['空色アンサンブル'], 3, 133000, { versionKind: 'live', versionLabel: 'Live' }),
    t('track-spring', 'album-spring', '春風ステップ', ['春野ひより'], 1, 232000, { artistCredit: '春野ひより (CV.水城ことり)' }),
    t('track-spring-off', 'album-spring', '春風ステップ', ['春野ひより'], 2, 232000,
      { artistCredit: '春野ひより (CV.水城ことり)', versionKind: 'offVocal', versionLabel: 'off vocal' }),
  );
  return { revision: 0, albums, tracks };
}
