import type {AudioVisualizationSource, PlayerSnapshot} from '../contracts/player.ts';
import {quietVisualization, VISUALIZATION_BANDS} from '../core/audioVisualization.ts';

/** Explicit preview fixture only. Production never uses synthetic visualization data. */
export function createDemoVisualization(player: () => PlayerSnapshot, options: {now?: () => number; pattern?: 'pulse' | 'silence' | 'bass' | 'treble'} = {}): AudioVisualizationSource {
  return {read() {
    const p=player(), pattern=options.pattern ?? 'pulse';
    if (p.status !== 'playing' || p.muted || p.volume<=0) return {...quietVisualization('idle',p.currentTrackId),source:'demo'};
    const t=(options.now?.() ?? performance.now())/1000, beat=pattern==='silence'?0:0.2+0.6*(Math.sin(t*5)+1)/2;
    const rms=beat*0.15*p.volume;
    const bands=Array.from({length:VISUALIZATION_BANDS},(_,i)=>pattern==='silence'?0:Math.min(1,beat*p.volume*(pattern==='bass'?Math.exp(-i/6):pattern==='treble'?Math.exp((i-23)/6):0.5+0.5*Math.sin(i*0.6+t*2)**2)));
    return {status:'live',source:'demo',trackId:p.currentTrackId,rms,peak:Math.min(1,rms*2),level:rms>0?Math.max(0,1+20*Math.log10(rms)/60):0,bands};
  }};
}
