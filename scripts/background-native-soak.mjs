import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createAudioFolder } from '../tests/helpers/audioFiles.ts';
import { openLocalStore } from '../src/local/store.ts';
import { scanFolder, mergeScan } from '../src/local/scanner.ts';

const seconds=Number(process.argv[2]??1800);
assert.ok(Number.isInteger(seconds)&&seconds>=60&&seconds<=86400,'Seconds per mode must be 60..86400');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const directory=path.join(root,'.cache','background-soak-'+Date.now());
const music=path.join(directory,'original-fixtures'),dataDirectory=path.join(directory,'data');
await createAudioFolder(music,8);
async function fingerprints(folder) {
  const result={};
  for(const item of await readdir(folder,{withFileTypes:true})) {
    const name=path.join(folder,item.name);
    if(item.isDirectory())for(const [rel,digest]of Object.entries(await fingerprints(name)))result[item.name+'/'+rel]=digest;
    else if(item.isFile())result[item.name]=createHash('sha256').update(await readFile(name)).digest('hex');
  }
  return result;
}
const before=await fingerprints(music),store=await openLocalStore(dataDirectory);
try {const scan=await scanFolder(music,path.join(dataDirectory,'covers'),new AbortController().signal);
  assert.equal(scan.warnings.length,0);assert.equal(scan.tracks.length,4);await store.transact(d=>mergeScan(d,scan));
} finally {await store.close();}
const reports=[];
for(const mode of ['adaptive','streaming']) {
  const report=path.join(directory,mode+'.json'),log=path.join(directory,mode+'.log');
  const child=spawn(path.join(root,'src-tauri/target/debug/cd-player-desktop.exe'),
    ['--smoke-data',dataDirectory,'--smoke-report',report,'--smoke-background','--smoke-soak-seconds',String(seconds),...(mode==='streaming'?['--smoke-stream-only']:[])],
    {cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>output+=b.toString());child.stderr.on('data',b=>output+=b.toString());
  console.log(JSON.stringify({mode,phase:'started',nativePid:child.pid}));
  const timer=setTimeout(()=>child.kill(),(seconds+240)*1000);
  const progress=setInterval(()=>console.log(JSON.stringify({mode,phase:'hidden-playback-running'})),20000);
  const exit=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);})
    .finally(()=>{clearTimeout(timer);clearInterval(progress);});
  await writeFile(log,output);
  const result=JSON.parse(await readFile(report,'utf8'));
  const reopened=await openLocalStore(dataDirectory);await reopened.close();
  const record={...result,mode,exit,storeReopened:true};reports.push(record);
  await writeFile(report,JSON.stringify(record,null,2));
  assert.equal(result.passed,true,JSON.stringify(record));assert.equal(exit,0);assert.ok(result.backgroundSoak);assert.equal(result.requestedSeconds,seconds);
  assert.ok(result.elapsedMs>=seconds*1000);assert.equal(result.cycleCount,result.cycles.length);
  for(const cycle of result.cycles){assert.equal(cycle.entryCount,12);assert.equal(cycle.idleChecks.length,3);assert.ok(cycle.backgroundOperations.length>=9);assert.ok(cycle.queueEndedNaturally);}
  console.log(JSON.stringify({mode,phase:'passed',elapsedMs:result.elapsedMs,cycles:result.cycleCount,operations:result.cycles.reduce((n,c)=>n+c.backgroundOperations.length,0)}));
}
assert.deepEqual(await fingerprints(music),before,'Original audio or attachments were changed');
const diagnosticNames=(await readdir(path.join(dataDirectory,'logs'))).filter(n=>/^diagnostics(?:\.[1-3])?\.ndjson$/.test(n));
const events=[];
for(const name of diagnosticNames)for(const line of (await readFile(path.join(dataDirectory,'logs',name),'utf8')).trim().split('\n'))if(line)events.push(JSON.parse(line));
const results=events.filter(e=>e.event==='action_result'),timeouts=events.filter(e=>e.event==='action_timeout');
assert.ok(results.length>=20);assert.equal(timeouts.length,0);
assert.ok(events.some(e=>e.event==='action_stage'&&e.stage==='published'));
assert.equal(events.filter(e=>e.event==='stopped').length,2);
const latencies=results.map(e=>e.elapsedMs).sort((a,b)=>a-b);
const summary={passed:true,prototypeVersion:JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version,
  reports,actionResults:results.length,actionTimeouts:timeouts.length,
  actionMedianMs:latencies[Math.floor(latencies.length/2)],actionP95Ms:latencies[Math.floor(latencies.length*.95)],
  actionMaxMs:latencies.at(-1),bothModesHaveNaturalQueueEnd:true,secondsPerMode:seconds,elapsedMs:reports.reduce((n,r)=>n+r.elapsedMs,0),
  totalNaturalQueues:reports.reduce((n,r)=>n+r.cycleCount,0),originalAudioAndAttachmentsUnchanged:true,
  defaultUserDataModified:false,physicalDevicesChanged:false,inspectorConnected:false,
  limits:['Reported duration is measured wall time per mode, including hidden idle and control operations; do not claim a longer soak','No physical device/sleep/multi-monitor test','No sample-accurate streaming gapless claim']};
await writeFile(path.join(directory,'report.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify({report:path.join(directory,'report.json'),passed:true,actionResults:results.length,actionP95Ms:summary.actionP95Ms}));
