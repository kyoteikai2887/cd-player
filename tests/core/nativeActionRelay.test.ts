import test from 'node:test';
import assert from 'node:assert/strict';
import { relayNativeAction } from '../../src/bridge/nativeActionRelay.ts';
import type { ActionResult } from '../../src/contracts/player.ts';

test('native relay preserves its original deadline budget and acknowledges only after committed publication',async()=>{
  const stages:string[]=[];let publish!:()=>void;let budget=0;let returned:ActionResult|undefined;
  const committed=new Promise<void>(r=>publish=r);
  const result:ActionResult={ok:false,code:'conflict',message:'版本更新'};
  const running=relayNativeAction({surface:'mini',action:{type:'rescanLibrary'},deadlineMs:5100,clockOffset:700,
    now:()=>900,dispatch:async(a,b)=>{assert.equal(a.type,'rescanLibrary');budget=b;return result;},
    publication:()=>committed,report:async s=>{stages.push(s);},resolve:async r=>{returned=r;}});
  await new Promise(r=>setImmediate(r));assert.equal(budget,3400);assert.equal(returned,undefined);
  assert.deepEqual(stages,['received','handled']);publish();await running;
  assert.deepEqual(stages,['received','handled','published']);assert.equal(returned,result);
});
test('unresponsive, rejected and synchronously failing diagnostics never hold up native actions',async()=>{
  for(const report of [()=>new Promise(()=>{}),()=>Promise.reject(Error('logger unavailable')),()=>{throw Error('logger unavailable');}]){
    let returned=false;
    await relayNativeAction({surface:'main',action:{type:'togglePlayback'},deadlineMs:5000,clockOffset:0,now:()=>0,
      dispatch:async()=>({ok:true,status:'applied'}),publication:async()=>{},report,
      resolve:async r=>{assert.equal(r.ok,true);returned=true;}});
    assert.equal(returned,true);
  }
});
test('relay returns a bounded handler failure without leaking exception text or duplicate resolution',async()=>{
  let count=0;
  await relayNativeAction({surface:'main',action:{type:'togglePlayback'},deadlineMs:4000,clockOffset:0,now:()=>0,
    dispatch:async()=>{throw Error('C:/private/music/secret-title.flac');},publication:async()=>{},report:async()=>{},
    resolve:async r=>{count++;assert.equal(r.ok,false);assert.ok(!JSON.stringify(r).includes('private'));}});
  assert.equal(count,1);
});
