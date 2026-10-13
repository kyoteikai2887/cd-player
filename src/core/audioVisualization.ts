import type { AudioVisualizationFrame } from '../contracts/player.ts';

export const VISUALIZATION_BANDS = 24;
const zeros = Object.freeze(Array<number>(VISUALIZATION_BANDS).fill(0));
export function quietVisualization(status: 'idle' | 'unavailable', trackId: string | null = null): AudioVisualizationFrame {
  return { status, source: 'audio', trackId, rms: 0, peak: 0, level: 0, bands: zeros };
}
const clamp = (n: number) => Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
const displayDb = (amplitude: number, floor: number) => amplitude > 0 ? clamp((20 * Math.log10(amplitude) - floor) / -floor) : 0;

/** Passive branch: its output is never connected to a speaker or recording destination. */
export function createVisualizationTap(context: AudioContext, input: AudioNode) {
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.55;
  const waveform = new Float32Array(analyser.fftSize), frequencies = new Float32Array(analyser.frequencyBinCount);
  input.connect(analyser);
  let disposed = false;
  return {
    read(trackId: string, scale = 1): AudioVisualizationFrame {
      if (disposed || context.state !== 'running') return quietVisualization('unavailable', trackId);
      try {
        analyser.getFloatTimeDomainData(waveform);
        analyser.getFloatFrequencyData(frequencies);
        const gain = clamp(scale);
        let sum = 0, peak = 0;
        for (const value of waveform) {
          const magnitude = Math.abs(Number.isFinite(value) ? value : 0) * gain;
          sum += magnitude * magnitude; peak = Math.max(peak, magnitude);
        }
        const rms = clamp(Math.sqrt(sum / waveform.length));
        const hzPerBin = context.sampleRate / analyser.fftSize, high = Math.min(20000, context.sampleRate / 2);
        const bands = Array.from({length: VISUALIZATION_BANDS}, (_, band) => {
          const lo = 32 * (high / 32) ** (band / VISUALIZATION_BANDS);
          const hi = 32 * (high / 32) ** ((band + 1) / VISUALIZATION_BANDS);
          const first = Math.min(frequencies.length - 1, Math.max(1, Math.floor(lo / hzPerBin)));
          const last = Math.min(frequencies.length, Math.max(first + 1, Math.ceil(hi / hzPerBin)));
          let power = 0;
          for (let i = first; i < last; i++) if (Number.isFinite(frequencies[i])) power += 10 ** (frequencies[i] / 10);
          return displayDb(Math.sqrt(power / (last - first)) * gain, -80);
        });
        return {status: 'live', source: 'audio', trackId, rms, peak: clamp(peak), level: displayDb(rms, -60), bands};
      } catch { return quietVisualization('unavailable', trackId); }
    },
    dispose() {
      if (disposed) return; disposed = true;
      try { input.disconnect(analyser); } catch { /* Already released. */ }
      analyser.disconnect();
    },
  };
}
