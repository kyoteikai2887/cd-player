# V1.2 主舞台音频可视化接口（0.6.0）

基于已经验收的 V1.2.0-rc.1（MV/PotPlayer 和播放条色光修正），本轮源码候选为 1.2.0-rc.2。还需 Claude 完成 UI、Codex 集成并在 Windows 上验收后才冻结为正式 V1.2。

## 数据入口

`PlayerUIProps.visualization?: AudioVisualizationSource` 是一个可选的本地只读接口，不属于 `UISnapshot`。主窗口持有真实声音引擎；迷你窗口只发送音量动作，不创建第二个音频引擎，不需要频谱。接线已在 desktop.tsx、App.tsx、PlayerUI.tsx 完成。

UI 内通过 `useAudioVisualizationSource()`（`src/ui/lib/audioVisualization.ts`）读取该接口，然后在可视化组件自己的帧循环中调用 `source.read()`。

```ts
interface AudioVisualizationFrame {
  status: 'live' | 'idle' | 'unavailable';
  source: 'audio' | 'demo';
  trackId: string | null;
  rms: number;   // 线性幅度，0..1
  peak: number;  // 当前采样窗口峰值，0..1；UI 可做短暂峰值保持
  level: number; // RMS 的 -60..0 dBFS 映射到 0..1，适合视觉响应
  bands: readonly number[]; // 固定 24 档，低频到高频，-80..0 dB 映射到 0..1
}
```

这是视觉用的音频信号接口。AI training、MLP、transformer 等可以成为构图灵感；不要将这些数值显示成真实 FLOPS、训练进度或模型指标。真实来源为 `source: 'audio'`；预览数据明确标记为 `demo`，生产代码不会用随机数据冒充声音。

## 时序与性能

- 可视区域内最高约 24 Hz 拉取数据，绘图可用 CSS 插值或局部 RAF；禁止把帧数据塞进整页 React state、音乐库、设置、IPC 快照。
- 组件卸载、主窗口隐藏、离开包含主舞台的页面、可视化被折叠或开关关闭时停止拉取。可以用 IntersectionObserver 判断舞台是否在视口内。
- 遵守现有 `useSurface()` 的 visible、reduced、online 及 forced-colors 状态。减少动态效果模式下采用静态构图或低频、幅度克制的数值变化；高对比度下隐藏装饰。
- 暂停、静音、音量为零、缓冲、停止时 `idle` 为零数据。切换 trackId 时清除上一首的视觉残留。
- 接口缺失或 `unavailable` 时呈现安静的静态外观，不显示重复错误条、不补造跳动。
- 生产端从 Web Audio gain 的旁路和流式 media.captureStream 旁路采样，分析支路不连接扬声器，不改变原有音频输出。流式 captureStream 是调音量之前的内容，所以采样端仅乘一次原有音量。
- 接口自身没有定时器；正常隐藏窗口播放、队列推进和歌词刷新维持现有流程。

## 预览

`src/mock/audioVisualization.ts` 导出 `createDemoVisualization(() => snapshot.player, {pattern: 'pulse'|'silence'|'bass'|'treble', now?})`。通过 PlayerUI 的 visualization 属性传入。要稳定截图可传 `now: () => 1200`。这些预览数据不能进入生产路径。

## 迷你音量

沿用 `setVolume`（0..1）和 `setMuted`（明确传入 muted 布尔值），读取全局 `snapshot.player.volume/muted`。主窗口与迷你窗口设置同一引擎，已有会话测试验证双向同步。现有 Transport.tsx 的 Volume 控件包含音量节流，可复用行为；拖动期间约每秒 8 次写入，松开时提交最终值。

迷你卡片约 360×92，歌词启用时约 360×140；原生透明窗口另有现有阴影边距。音量展开内容应收纳在现有卡片内，避免使用卡片外弹出浮层或增加原生窗口大小。入口点击展开、收起方式由 Claude 设计；需要键盘可达、Escape 关闭并恢复焦点，slider 正确 aria-label/value，输入操作不触发拖窗或双击展开主窗口。

## 接口参考

- https://developer.mozilla.org/en-US/docs/Web/API/AnalyserNode/getFloatTimeDomainData
- https://developer.mozilla.org/en-US/docs/Web/API/AnalyserNode/getFloatFrequencyData
- https://w3c.github.io/mediacapture-fromelement/ （捕获不受元素音量和静音影响）

浏览器真实信号检查覆盖缓冲/流式、1 kHz/4 kHz、20% 音量、静音、暂停/恢复和停止；完整原生 WebView2 和新 UI 验收在回传后执行。
