import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {createServer as netServer} from 'node:net';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,'.cache','visualization-browser-'+Date.now());await fs.mkdir(output,{recursive:true});
function wav(hz){const rate=48000,frames=rate*8,b=Buffer.alloc(44+frames*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(frames*2,40);for(let i=0;i<frames;i++)b.writeInt16LE(Math.round(0.3*32767*Math.sin(2*Math.PI*hz*i/rate)),44+i*2);return b;}
const source=`import {createWebAudioEngine} from './src/core/audio.ts';import {createStreamingAudioEngine} from './src/core/streamingAudio.ts';
const delay=ms=>new Promise(r=>setTimeout(r,ms));const check=(ok,m)=>{if(!ok)throw Error(m)};
window.runVisualizationCheck=async()=>{const checks=[];for(const mode of ['buffered','streaming']){
 const engine=mode==='buffered'?createWebAudioEngine({load:async id=>(await fetch('/'+id+'.wav')).arrayBuffer()}):createStreamingAudioEngine({url:id=>'/'+id+'.wav'});
 try{await engine.activate();engine.setGain(1,false);await engine.play('tone',0,true,new AbortController().signal);
 const read=()=>engine.readVisualization();const live=async()=>{for(let i=0;i<60;i++){const f=read();if(f.status==='live'&&f.rms>0.001)return f;await delay(50);}throw Error(mode+' produced no live samples: '+JSON.stringify(read()))};
 let f=await live();await delay(150);f=read();check(f.source==='audio'&&f.rms>0.05&&f.peak>0.1,mode+' amplitudes');
 const dominant=f.bands.indexOf(Math.max(...f.bands)),expected=Math.floor(24*Math.log(1000/32)/Math.log(20000/32));check(Math.abs(dominant-expected)<=1,mode+' frequency band');
 const loud=f.rms;engine.setGain(0.2,false);await delay(200);const quiet=read();check(quiet.rms/loud>0.14&&quiet.rms/loud<0.27,mode+' volume scaled once');
 engine.setGain(0.2,true);check(read().status==='idle'&&read().level===0,mode+' mute');engine.setGain(1,false);
 engine.pause();check(read().status==='idle',mode+' pause');await engine.resume();await live();
 await engine.play('high',0,true,new AbortController().signal);const hi=await live();check(hi.trackId==='high',mode+' changed track');
 for(let i=0;i<8;i++){await delay(60);read();}const hf=read(),hband=hf.bands.indexOf(Math.max(...hf.bands));check(hband>dominant+3,mode+' higher tone '+JSON.stringify({dominant,hband,bands:hf.bands}));
 engine.stop();check(read().status==='idle'&&read().trackId===null,mode+' stop');checks.push({mode,frequencyBand:dominant,highFrequencyBand:hband,rms:loud,volumeRatio:quiet.rms/loud});
 }finally{engine.destroy();}}
 return {passed:true,checks};};`;
const built=await build({stdin:{contents:source,resolveDir:root,sourcefile:'visualization-fixture.ts',loader:'ts'},bundle:true,platform:'browser',format:'iife',write:false});
const server=createServer((req,res)=>{if(req.url==='/tone.wav'||req.url==='/high.wav'){res.setHeader('Content-Type','audio/wav');res.end(wav(req.url==='/tone.wav'?1000:4000));}else if(req.url==='/test.js'){res.setHeader('Content-Type','text/javascript');res.end(built.outputFiles[0].contents);}else{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Isolated audio visualization test</title><script src="/test.js"></script>');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const pagePort=server.address().port;
const listen=netServer();await new Promise(r=>listen.listen(0,'127.0.0.1',r));const port=listen.address().port;await new Promise(r=>listen.close(r));
const exe='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const child=spawn(exe,['--headless=new','--disable-gpu','--mute-audio','--no-first-run','--no-default-browser-check','--autoplay-policy=no-user-gesture-required','--remote-debugging-port='+port,'--user-data-dir='+path.join(output,'profile'),'http://127.0.0.1:'+pagePort],{windowsHide:true,stdio:'ignore'});
const done=new Promise(r=>child.once('exit',r));const delay=ms=>new Promise(r=>setTimeout(r,ms));let socket,result;
try{let target;for(let i=0;i<100&&!target;i++){try{target=(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(t=>t.type==='page'&&t.url.includes(':'+pagePort));}catch{}if(!target)await delay(100);}assert.ok(target,'Owned test page not found');
 socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{socket.addEventListener('open',r,{once:true});socket.addEventListener('error',j,{once:true});});
 let id=0;const pending=new Map();socket.addEventListener('message',e=>{const msg=JSON.parse(e.data),p=pending.get(msg.id);if(p){pending.delete(msg.id);msg.error?p.reject(Error(JSON.stringify(msg.error))):p.resolve(msg.result);}});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});socket.send(JSON.stringify({id:key,method,params}));});
 for(let attempt=0;attempt<100;attempt++){const ready=await send('Runtime.evaluate',{expression:'typeof window.runVisualizationCheck === "function"',returnByValue:true});if(ready.result.value)break;await delay(50);}
 const response=await send('Runtime.evaluate',{expression:'window.runVisualizationCheck()',awaitPromise:true,returnByValue:true});if(response.exceptionDetails)throw Error(JSON.stringify(response.exceptionDetails));
 result=response.result.value;assert.equal(result.passed,true);await fs.writeFile(path.join(output,'RESULT.json'),JSON.stringify(result,null,2));
 await send('Browser.close').catch(()=>{});console.log(JSON.stringify({output,...result}));
}catch(error){await fs.writeFile(path.join(output,'RESULT.json'),JSON.stringify({passed:false,error:error.stack},null,2));throw error;}
finally{socket?.close();child.kill();await done;await new Promise(r=>server.close(r));}
