import type { LocalView } from '../local/model.ts';

const button = document.getElementById('run') as HTMLButtonElement,
  report = document.getElementById('report')!;
button.addEventListener('click', () => {
  void run();
});
async function run() {
  button.disabled = true;
  report.textContent = '检查中…';
  try {
    const { view } = (await (await fetch('/api/bootstrap')).json()) as {
      view: LocalView;
    };
    const names = ['窓の光', '青い空', '02 Wave', '01 Mp3'],
      buffers: AudioBuffer[] = [],
      rows: string[] = [];
    const decoder = new OfflineAudioContext(1, 44100, 44100);
    for (const name of names) {
      const track = view.library.tracks.find((t) => t.title === name);
      if (!track) throw new Error('请先按开发说明导入生成的测试音频。');
      const response = await fetch('/api/media/' + track.id);
      if (!response.ok) throw new Error('测试文件无法读取。');
      const buffer = await decoder.decodeAudioData(
        await response.arrayBuffer(),
      );
      buffers.push(buffer);
      const values = buffer.getChannelData(0);
      let energy = 0;
      for (const value of values) energy += value * value;
      if (!(energy > 0)) throw new Error(name + ' 未得到非零 PCM。');
      rows.push(
        name +
          ': 解码通过，' +
          buffer.length +
          ' 个采样，' +
          buffer.duration.toFixed(3) +
          ' 秒，' +
          buffer.sampleRate +
          ' Hz',
      );
    }
    const [a, b] = buffers,
      total = a.length + b.length,
      offline = new OfflineAudioContext(1, total, 44100);
    const first = offline.createBufferSource(),
      second = offline.createBufferSource();
    first.buffer = a;
    second.buffer = b;
    first.connect(offline.destination);
    second.connect(offline.destination);
    first.start(0);
    second.start(a.duration);
    const rendered = await offline.startRendering(),
      output = rendered.getChannelData(0),
      left = a.getChannelData(0),
      right = b.getChannelData(0);
    let maximumDifference = 0;
    for (let i = 0; i < total; i++)
      maximumDifference = Math.max(
        maximumDifference,
        Math.abs(output[i] - (i < a.length ? left[i] : right[i - a.length])),
      );
    if (maximumDifference > 0.000001)
      throw new Error('连续拼接出现未预期的采样差异。');
    rows.push(
      'FLAC 连续拼接：通过；边界无插入/丢失采样，最大采样误差 ' +
        maximumDifference,
    );
    rows.push(
      '全部数字音频检查通过。Windows 原生设备输出与主观听测仍需后续验证。',
    );
    report.textContent = rows.join('\n');
  } catch (error) {
    report.textContent =
      '检查未完成：' + (error instanceof Error ? error.message : String(error));
  } finally {
    button.disabled = false;
  }
}
