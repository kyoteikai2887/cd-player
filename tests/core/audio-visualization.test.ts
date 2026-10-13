import assert from 'node:assert/strict';
import test from 'node:test';
import {createVisualizationTap} from '../../src/core/audioVisualization.ts';
import {createStreamingAudioEngine} from '../../src/core/streamingAudio.ts';
import {createWebAudioEngine} from '../../src/core/audio.ts';

function graph() {
  const connections: unknown[] = []; let sample = 0.1, db = -20, disconnected = 0;
  const analyser = {fftSize: 2048, frequencyBinCount: 1024, smoothingTimeConstant: 0,
    getFloatTimeDomainData(a: Float32Array) { a.fill(sample); },
    getFloatFrequencyData(a: Float32Array) { a.fill(db); }, disconnect() {disconnected++;}};
  const input = {connect(n: unknown) {connections.push(n);}, disconnect() {disconnected++;}};
  const context = {state: 'running', currentTime: 0, sampleRate: 48000, destination: {},
    createAnalyser: () => analyser,
    addEventListener() {}, removeEventListener() {},
    createGain() {return {...input, gain: {value: 0, setValueAtTime() {}}};},
    createBufferSource() {return {...input, buffer: null, onended: null, start() {}, stop() {}};},
    async decodeAudioData() {return {duration: 60, length: 48000 * 60, numberOfChannels: 1};},
    createMediaStreamSource: () => input,
    async resume() {context.state = 'running';}, async close() {context.state = 'closed';}};
  return {ctx: context as unknown as AudioContext, input: input as unknown as AudioNode, context, connections, analyser,
    set(sampleValue: number, dbValue: number) {sample=sampleValue; db=dbValue;}, get disconnected() {return disconnected;}};
}
test('passive analysis reports finite RMS, peak and logarithmic bands; gain is applied once', () => {
  const g=graph(), tap=createVisualizationTap(g.ctx,g.input);
  const f=tap.read('track'); assert.equal(f.status,'live');assert.equal(f.source,'audio');
  assert.ok(Math.abs(f.rms-0.1)<1e-6);assert.ok(Math.abs(f.level-2/3)<1e-6);
  assert.equal(f.bands.length,24);assert.ok(f.bands.every(n=>Math.abs(n-0.75)<1e-6));
  const quiet=tap.read('track',0.1);assert.ok(Math.abs(quiet.rms-0.01)<1e-6);assert.ok(Math.abs(quiet.level-1/3)<1e-6);
  assert.ok(quiet.bands.every(n=>Math.abs(n-0.5)<1e-6));
  assert.deepEqual(g.connections,[g.analyser]);assert.ok(!g.connections.includes(g.context.destination));
  tap.dispose();tap.dispose();assert.equal(tap.read('track').status,'unavailable');
});
test('silence, malformed samples and a suspended output never fabricate activity', () => {
  const g=graph(),tap=createVisualizationTap(g.ctx,g.input);g.set(0,-Infinity);
  assert.equal(tap.read('a').level,0);assert.ok(tap.read('a').bands.every(n=>n===0));
  g.set(NaN,NaN);const f=tap.read('a');assert.equal(f.rms,0);assert.ok(f.bands.every(n=>n===0));
  g.context.state='suspended';assert.equal(tap.read('a').status,'unavailable');tap.dispose();
});
test('buffered analysis adds a speaker-free branch and returns idle on mute, pause and stop', async () => {
  const g=graph(),engine=createWebAudioEngine({context:()=>g.ctx,load:async()=>new ArrayBuffer(1)});
  await engine.activate();await engine.play('buffer',0,true,new AbortController().signal);
  assert.equal(engine.readVisualization!().status,'live');
  assert.equal(g.connections.filter(n=>n===g.context.destination).length,1);
  engine.setGain(0.4,true);assert.equal(engine.readVisualization!().level,0);
  engine.setGain(0.4,false);engine.pause();assert.equal(engine.readVisualization!().status,'idle');
  engine.stop();assert.equal(engine.readVisualization!().trackId,null);engine.destroy();
});
class Media extends EventTarget {
  volume=1;muted=false;src='';preload='';duration=60;currentTime=0;readyState=4;paused=true;ended=false;seeking=false;error=null;
  captures=0;stops=0;
  load() {} removeAttribute() {this.src='';} pause() {this.paused=true;} async play() {this.paused=false;}
  captureStream() {this.captures++;const track={stop:()=>this.stops++};return {getAudioTracks:()=>[track],getTracks:()=>[track]} as unknown as MediaStream;}
}
test('streamed analysis follows media gain without rerouting sound and releases each capture', async () => {
  const g=graph(),instances:Media[]=[];
  const engine=createStreamingAudioEngine({analysisContext:()=>g.ctx,media:()=>{const m=new Media();instances.push(m);return m as unknown as HTMLAudioElement;}});
  await engine.activate();engine.setGain(0.1,false);await engine.play('long',0,true,new AbortController().signal);
  const f=engine.readVisualization!();assert.equal(f.status,'live');assert.ok(Math.abs(f.rms-0.01)<1e-6);
  assert.equal(instances[0].volume,0.1);assert.equal(instances[0].captures,1);assert.ok(!g.connections.includes(g.context.destination));
  engine.readVisualization!();assert.equal(instances[0].captures,1);
  engine.pause();assert.equal(engine.readVisualization!().status,'idle');await engine.resume();assert.equal(engine.readVisualization!().status,'live');
  engine.setGain(0.1,true);assert.equal(engine.readVisualization!().status,'idle');engine.setGain(0.1,false);
  await engine.play('next',0,true,new AbortController().signal);assert.equal(instances[0].stops,1);
  engine.readVisualization!();engine.destroy();assert.equal(instances[1].stops,1);
});
test('capture failure remains a visualization fallback and cannot interrupt streaming playback', async () => {
  const g=graph(),m=new Media();m.captureStream=()=>{throw Error('unsupported');};
  const engine=createStreamingAudioEngine({analysisContext:()=>g.ctx,media:()=>m as unknown as HTMLAudioElement});
  await engine.play('long',0,true,new AbortController().signal);
  assert.equal(engine.readVisualization!().status,'unavailable');assert.equal(engine.sample().playing,true);engine.destroy();
});
