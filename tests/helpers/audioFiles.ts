import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Mp3Encoder } from '@breezystack/lamejs';

/** Original, quiet synthetic tones; no copyrighted recordings. */
export function pcm(seconds = 3, frequency = 440): Int16Array {
  return Int16Array.from({ length: Math.round(seconds * 44100) }, (_, i) =>
    Math.round(Math.sin((2 * Math.PI * frequency * i) / 44100) * 800),
  );
}
export function wav(samples: Int16Array): Buffer {
  const output = Buffer.alloc(44 + samples.length * 2);
  output.write('RIFF');
  output.writeUInt32LE(output.length - 8, 4);
  output.write('WAVEfmt ', 8);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(44100, 24);
  output.writeUInt32LE(88200, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write('data', 36);
  output.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((value, index) => output.writeInt16LE(value, 44 + index * 2));
  return output;
}
const le = (value: number) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
};
const crc = (bytes: Uint8Array, bits: number, polynomial: number) => {
  let value = 0;
  for (const byte of bytes) {
    value ^= byte << (bits - 8);
    for (let i = 0; i < 8; i++)
      value =
        ((value << 1) ^ (value & (1 << (bits - 1)) ? polynomial : 0)) &
        ((1 << bits) - 1);
  }
  return value;
};
/** Minimal verbatim FLAC frames written from RFC9639; test fixture encoder only. */
export function flac(
  samples: Int16Array,
  tags: Record<string, string>,
): Buffer {
  const block = 4096,
    frames: Buffer[] = [];
  for (
    let offset = 0, frame = 0;
    offset < samples.length;
    offset += block, frame++
  ) {
    const count = Math.min(block, samples.length - offset);
    if (frame >= 128) throw new Error('Keep fixtures short');
    const header = Buffer.from([
      0xff,
      0xf8,
      0x79,
      0x08,
      frame,
      (count - 1) >> 8,
      (count - 1) & 255,
    ]);
    const body = Buffer.alloc(count * 2 + 1);
    body[0] = 2;
    for (let i = 0; i < count; i++)
      body.writeInt16BE(samples[offset + i], 1 + i * 2);
    const withoutFooter = Buffer.concat([
      header,
      Buffer.from([crc(header, 8, 7)]),
      body,
    ]);
    const footer = Buffer.alloc(2);
    footer.writeUInt16BE(crc(withoutFooter, 16, 0x8005));
    frames.push(Buffer.concat([withoutFooter, footer]));
  }
  const info = Buffer.alloc(34);
  info.writeUInt16BE(Math.min(block, samples.length % block || block));
  info.writeUInt16BE(block, 2);
  info.writeBigUInt64BE(
    (44100n << 44n) | (15n << 36n) | BigInt(samples.length),
    10,
  );
  const raw = Buffer.alloc(samples.length * 2);
  samples.forEach((value, index) => raw.writeInt16LE(value, index * 2));
  createHash('md5').update(raw).digest().copy(info, 18);
  const comments = Object.entries(tags).map(([key, value]) =>
      Buffer.from(key + '=' + value, 'utf8'),
    ),
    vendor = Buffer.from('CD Player original tests');
  const vorbis = Buffer.concat([
    le(vendor.length),
    vendor,
    le(comments.length),
    ...comments.flatMap((value) => [le(value.length), value]),
  ]);
  const metadataHeader = Buffer.alloc(4);
  metadataHeader[0] = 0x84;
  metadataHeader.writeUIntBE(vorbis.length, 1, 3);
  return Buffer.concat([
    Buffer.from('fLaC'),
    Buffer.from([0, 0, 0, 34]),
    info,
    metadataHeader,
    vorbis,
    ...frames,
  ]);
}
export function mp3(samples: Int16Array): Buffer {
  const encoder = new Mp3Encoder(1, 44100, 128),
    parts: Uint8Array[] = [];
  for (let i = 0; i < samples.length; i += 1152)
    parts.push(encoder.encodeBuffer(samples.subarray(i, i + 1152)));
  parts.push(encoder.flush());
  return Buffer.concat(
    parts.map((part) =>
      Buffer.from(part.buffer, part.byteOffset, part.byteLength),
    ),
  );
}
export async function createAudioFolder(directory: string, seconds = 3) {
  await mkdir(path.join(directory, 'Disc 1'), { recursive: true });
  await mkdir(path.join(directory, 'Disc 2'), { recursive: true });
  await writeFile(
    path.join(directory, 'Disc 1', '01 原创音.flac'),
    flac(pcm(seconds), {
      ALBUM: '青い試験集',
      TITLE: '窓の光',
      ARTIST: '空野ミオ (CV.月野ユイ)',
      ARTISTS: '空野ミオ',
      ALBUMARTIST: '空色アンサンブル',
      TRACKNUMBER: '1',
      DISCNUMBER: '1',
      DATE: '2026',
    }),
  );
  await writeFile(
    path.join(directory, 'Disc 1', '02 第二音.flac'),
    flac(pcm(seconds, 520), {
      ALBUM: '青い試験集',
      TITLE: '青い空',
      ARTIST: '空野ミオ',
      ALBUMARTIST: '空色アンサンブル',
      TRACKNUMBER: '2',
      DISCNUMBER: '1',
      DATE: '2026',
    }),
  );
  await writeFile(
    path.join(directory, 'Disc 1', '02 Wave.wav'),
    wav(pcm(seconds, 550)),
  );
  await writeFile(
    path.join(directory, 'Disc 2', '01 Mp3.mp3'),
    mp3(pcm(seconds, 660)),
  );
  await writeFile(
    path.join(directory, 'Disc 1', '01 原创音.lrc'),
    '[offset:+100]\n[00:00.200]窓の光\n[00:01.000]\n[00:02.000]青い空',
  );
  await writeFile(
    path.join(directory, 'Disc 1', '01 原创音.zh.lrc'),
    '[00:00.100]窗边的光\n[00:01.900]蓝色天空',
  );
  await writeFile(
    path.join(directory, 'capture.log'),
    'Original test log, not an AccurateRip verification.',
  );
  await writeFile(
    path.join(directory, 'capture.cue'),
    'REM original synthetic test',
  );
  return directory;
}
