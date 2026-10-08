import type { LyricsDocument } from '../../contracts/player.ts';
import { parseLyrics } from '../../core/lyrics.ts';

/** Pairs [time, original, translation?] into bilingual LRC text (duplicate timestamps). Empty original = break. */
function lrc(rows: [string, string, string?][]): string {
  return rows.flatMap(([time, original, translation]) =>
    translation ? [`[${time}]${original}`, `[${time}]${translation}`] : [`[${time}]${original}`]).join('\n');
}

export function createDemoLyrics(): Record<string, LyricsDocument> {
  const options = { source: { kind: 'demo' as const }, language: 'ja', translationLanguage: 'zh-Hans' };
  const text = '[00:00.000]窓の向こうに青い空\n[00:00.000]窗外是一片蓝色天空\n' +
    '[00:08.000]小さな光を手にのせて\n[00:08.000]把小小的光捧在手心\n' +
    '[00:16.000]今日のページを開こう\n[00:16.000]翻开今天的这一页\n' +
    '[00:24.000]静かな風と歩いてゆく\n[00:24.000]伴着安静的风向前走';
  const synced = (id: string) => parseLyrics(text, id, { ...options, duplicateTimestampMode: 'bilingual' });
  const bilingual = (id: string, rows: [string, string, string?][], extra = {}) =>
    parseLyrics(lrc(rows), id, { ...options, duplicateTimestampMode: 'bilingual', ...extra });

  // Claude R1: a full-length original song for the main demo track (all lines are invented).
  const blue: [string, string, string?][] = [
    ['00:12.00', '窓の向こうに青い空', '窗外是一片蓝色天空'],
    ['00:19.50', '小さな光を手にのせて', '把小小的光捧在手心'],
    ['00:27.00', '今日のページを開こう', '翻开今天的这一页'],
    ['00:34.50', '静かな風と歩いてゆく', '伴着安静的风向前走'],
    ['00:42.00', '名前のない朝が', '还没有名字的清晨'],
    ['00:48.50', 'そっと背中を押してくれる', '轻轻地推了我一把'],
    ['00:56.00', ''],
    ['01:10.00', '遠くで鳴るチャイムの音', '远处响起的铃声'],
    ['01:17.50', '覚えたての歌を重ねて', '和刚学会的歌叠在一起'],
    ['01:25.00', 'まだ知らない景色へ', '向着还不认识的风景'],
    ['01:32.50', '透明な羽をひろげよう', '张开透明的翅膀吧'],
    ['01:41.00', '窓辺の青 ずっと', '窗边的蓝 一直'],
    ['01:47.50', '君と見ていたいんだ', '想和你一起看下去'],
    ['01:55.00', ''],
    ['02:20.00', '窓の向こうに青い空', '窗外是一片蓝色天空'],
    ['02:27.50', '今日のページを開こう', '翻开今天的这一页'],
    ['02:35.00', '窓辺の青 ずっと', '窗边的蓝 一直'],
    ['02:42.00', '君と見ていたいんだ', '想和你一起看下去'],
    ['02:52.00', ''],
  ];
  const soda: [string, string, string?][] = [
    ['00:14.00', '炭酸の泡がはじけて', '汽水的泡泡啪地破开'],
    ['00:20.50', '放課後のベルが鳴った', '放学的铃声响了'],
    ['00:27.00', '自転車の影をのばして', '拉长自行车的影子'],
    ['00:33.50', '坂道を駆け下りてゆく', '沿着坡道一路冲下去'],
    ['00:41.00', 'ソーダ色の空の下', '在汽水色的天空下'],
    ['00:47.00', '言えなかったことばを', '那些没能说出口的话'],
    ['00:53.50', '今日こそ届けたいんだ', '今天一定要传达给你'],
    ['01:01.00', ''],
    ['01:15.00', '夕焼けまで あと少し', '离晚霞 还差一点点'],
    ['01:22.00', '笑い声が風になる', '笑声化作了风'],
    ['01:29.00', 'ふたりの影 並べて', '两个人的影子 并排着'],
    ['01:36.00', 'まだ帰りたくないな', '还不想回家呢'],
    ['01:44.00', 'ソーダ色の空の下', '在汽水色的天空下'],
    ['01:50.00', '君の名前を呼んだ', '我喊出了你的名字'],
    ['01:58.00', ''],
  ];
  const sodaTv: [string, string, string?][] = [
    ['00:06.00', '炭酸の泡がはじけて', '汽水的泡泡啪地破开'],
    ['00:12.50', '放課後のベルが鳴った', '放学的铃声响了'],
    ['00:19.00', 'ソーダ色の空の下', '在汽水色的天空下'],
    ['00:25.00', '言えなかったことばを', '那些没能说出口的话'],
    ['00:31.50', '今日こそ届けたいんだ', '今天一定要传达给你'],
    ['00:40.00', ''],
  ];
  const morning: [string, string, string?][] = [
    ['00:16.00', '夜明けまで そばにいて', '到天亮之前 请待在身边'],
    ['00:23.00', '小さな灯りをともして', '点起一盏小小的灯'],
    ['00:30.00', 'ラジオの声が やさしく', '收音机的声音 温柔地'],
    ['00:37.00', '眠れない夜をつつむ', '包裹住无眠的夜'],
    ['00:45.00', '朝を待つ ふたりで', '一起 等待早晨'],
    ['00:53.00', ''],
  ];
  const liveBlue: [string, string, string?][] = [
    ['00:21.00', '窓の向こうに青い空'],
    ['00:28.50', '小さな光を手にのせて'],
    ['00:36.00', '今日のページを開こう'],
    ['00:43.50', '静かな風と歩いてゆく'],
    ['00:52.00', '窓辺の青 ずっと'],
    ['00:58.50', '君と見ていたいんだ'],
    ['01:07.00', ''],
  ];
  const spring: [string, string, string?][] = [
    ['00:12.00', '春風ステップ ふみだして', '踏出春风的舞步'],
    ['00:18.50', '桜の道を かけてゆく'],
    ['00:25.00', 'ドキドキが とまらない', '心跳停不下来'],
    ['00:31.50', '今日はきっと 特別な日'],
    ['00:38.00', 'ひとつ ふたつ 数えたら', '一个 两个 数一数'],
    ['00:44.50', '君のとなりへ', '就走到你的身边'],
    ['00:52.00', ''],
  ];

  const documents: Record<string, LyricsDocument> = {
    'track-blue': bilingual('track-blue', blue),
    'track-tv': parseLyrics('[00:00.000]窓の向こうに青い空\n[00:08.000]今日のページを開こう', 'track-tv', options),
    'track-piano': { ...parseLyrics('', 'track-piano', options), kind: 'instrumental' },
    'track-plain': parseLyrics('白い道を見つけた\nまだ名前のない朝\nゆっくり歩いてゆこう', 'track-plain', options),
    'track-missing': parseLyrics('', 'track-missing', options),
    'track-spoken': { ...parseLyrics('', 'track-spoken', options), kind: 'spoken' },
    'track-partial': synced('track-partial'), 'track-disc2': synced('track-disc2'),

    'track-soda': bilingual('track-soda', soda),
    'track-soda-promise': parseLyrics('約束したね あの日の坂で\n夕陽がふたりを 照らしていた\nいつかまた ここで会おう', 'track-soda-promise', options),
    'track-soda-tv': bilingual('track-soda-tv', sodaTv),
    'track-soda-off': { ...parseLyrics('', 'track-soda-off', options), kind: 'instrumental' },
    'track-sea-title': { ...parseLyrics('', 'track-sea-title', options), kind: 'instrumental' },
    'track-sea-morning': { ...parseLyrics('', 'track-sea-morning', options), kind: 'instrumental' },
    'track-sea-chart': parseLyrics('', 'track-sea-chart', options),
    'track-sea-storm': parseLyrics('', 'track-sea-storm', options),
    'track-sea-home': parseLyrics('', 'track-sea-home', options),
    'track-radio-talk': { ...parseLyrics('', 'track-radio-talk', options), kind: 'spoken' },
    'track-radio-drama': { ...parseLyrics('', 'track-radio-drama', options), kind: 'spoken' },
    'track-radio-ed': bilingual('track-radio-ed', morning),
    'track-rain-blue': parseLyrics(lrc(liveBlue), 'track-rain-blue', options),
    'track-rain-mc': { ...parseLyrics('', 'track-rain-mc', options), kind: 'spoken' },
    'track-rain-light': { ...parseLyrics('', 'track-rain-light', options), kind: 'instrumental' },
    'track-spring': bilingual('track-spring', spring),
    'track-spring-off': { ...parseLyrics('', 'track-spring-off', options), kind: 'instrumental' },
  };
  delete documents['track-partial'].lines[1].translation;
  documents['track-partial'].translationStatus = 'partial';
  for (const document of Object.values(documents)) document.locked = false;
  // A hand-curated document is locked against automatic replacement.
  documents['track-soda'].locked = true;
  documents['track-soda'].source = { original: { kind: 'sidecar' }, translation: { kind: 'manual' } };
  documents['track-spring'].source = { original: { kind: 'embedded' }, translation: { kind: 'provider', name: '虚构歌词源' } };
  return documents;
}
