import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDemoData } from '../../src/mock/fixtures.ts';
import { createMockSession } from '../../src/mock/createMockBridge.ts';
import { parseLyrics } from '../../src/core/lyrics.ts';
import { prepareLyricsReview, selectedLyrics, applyLyricsReview } from '../../src/local/online/candidates.ts';
import { createOnlineServices } from '../../src/local/online/providers.ts';
import { openLocalStore } from '../../src/local/store.ts';
import { startLocalServer } from '../../src/local/server.ts';
import type { LocalData } from '../../src/local/model.ts';
import type { UIAction } from '../../src/contracts/player.ts';

function fixture() {
  const demo=createDemoData(),track=demo.library.tracks[0],album=demo.library.albums.find(a=>a.id===track.albumId)!;
  const document=parseLyrics('',track.id);document.locked=false;document.offsetMs=230;
  const data:LocalData={...demo,schemaVersion:1,archivedLyrics:{},roots:[],files:{},covers:{},lyricsByTrack:{[track.id]:document}};
  const record={provider:'原创测试源',recordId:'test-1',title:track.title,artistCredit:'罗马字署名',albumTitle:'另一张原创专辑',
    durationMs:track.durationMs+1000,document:parseLyrics('[00:01]原创歌词\n[00:02]下一句',track.id)};
  return {data,track,album,document,record};
}
test('cross-album and credit variants are previews; timings and version warnings rank short edits separately',()=>{
  const f=fixture(),tv={...f.record,recordId:'tv',title:f.track.title+' (TV Size)',durationMs:90000};
  const p=prepareLyricsReview(f.track,f.album,f.document,[tv,f.record,f.record]);
  assert.equal(p.review.candidates.length,2);assert.equal(p.review.candidates[0].recordId,'test-1');
  assert.equal(p.review.candidates[0].match,'close');assert.equal(p.review.candidates[0].durationDeltaMs,1000);
  assert.ok(p.review.candidates[0].warnings.some(w=>w.includes('署名')));
  assert.ok(p.review.candidates[1].warnings.some(w=>w.includes('版本')));
  assert.equal(f.data.lyricsByTrack[f.track.id].kind,'missing');
});
test('adoption uses private text, preserves local offset and cannot overwrite existing lyrics',()=>{
  const f=fixture(),p=prepareLyricsReview(f.track,f.album,f.document,[f.record]);
  const c=p.review.candidates[0],a={trackId:f.track.id,reviewId:p.review.id,candidateId:c.id};
  c.document.lines[0].original='UI篡改';applyLyricsReview(f.data,p,a);
  assert.equal(f.data.lyricsByTrack[f.track.id].lines[0].original,'原创歌词');
  assert.equal(f.data.lyricsByTrack[f.track.id].offsetMs,230);
  assert.throws(()=>applyLyricsReview(f.data,p,a),/修改/);
  const latest=f.data.lyricsByTrack[f.track.id],p2=prepareLyricsReview(f.track,f.album,latest,[f.record]);
  assert.throws(()=>applyLyricsReview(f.data,p2,{...a,reviewId:p2.review.id,candidateId:p2.review.candidates[0].id}),/编辑器/);
});
test('expired, locked, removed, changed or forged candidates cannot be adopted',()=>{
  for(const mutate of [(f:ReturnType<typeof fixture>)=>f.track.revision++,f=>f.album.revision++,f=>f.document.revision++,
    f=>f.document.locked=true,f=>f.data.library.tracks=[]] as ((f:ReturnType<typeof fixture>)=>void)[]){
    const f=fixture(),p=prepareLyricsReview(f.track,f.album,f.document,[f.record]);mutate(f);
    assert.throws(()=>selectedLyrics(f.data,p,{trackId:f.track.id,reviewId:p.review.id,candidateId:p.review.candidates[0].id}));
  }
  const f=fixture(),p=prepareLyricsReview(f.track,f.album,f.document,[f.record],undefined,1000),a={trackId:f.track.id,reviewId:p.review.id,candidateId:p.review.candidates[0].id};
  assert.throws(()=>selectedLyrics(f.data,p,a,p.expiresAt),/过期/);
  assert.throws(()=>selectedLyrics(f.data,p,{...a,candidateId:'fake'},1001),/不存在/);
});
test('broad LRCLIB search omits album, tries structured credits, validates records and deduplicates IDs',async()=>{
  const f=fixture(),urls:URL[]=[];
  const service=createOnlineServices({lyricSources:['lrclib'],fetch:(async(raw)=>{
    const u=new URL(String(raw));urls.push(u);
    return new Response(JSON.stringify(u.searchParams.get('artist_name')===f.track.artistCredit?[]:[
      {id:1,trackName:f.track.title,artistName:'署名变体',albumName:'其他专辑',duration:180,instrumental:false,syncedLyrics:'[00:01]原创'},
      {id:1,trackName:f.track.title,artistName:'署名变体',albumName:'其他专辑',duration:180,syncedLyrics:'[00:01]原创'},
      {id:2,trackName:f.track.title,artistName:'歌手',albumName:'专辑',instrumental:true},
    ]));
  }) as typeof fetch,sleep:async()=>{}});
  const records=await service.searchLyrics!(f.track,f.album,new AbortController().signal);
  assert.equal(records.length,1);assert.ok(urls.length>=2);
  assert.ok(urls.every(u=>!u.searchParams.has('album_name')));
});
test('exact lookup still rejects broad credit variants and searches after a mismatched GET response',async()=>{
  const f=fixture(),urls:URL[]=[];
  const service=createOnlineServices({fetch:(async raw=>{
    const u=new URL(String(raw));urls.push(u);return new Response(JSON.stringify(u.pathname.endsWith('/get')?
      {id:1,trackName:f.track.title,artistName:'其他演唱者',albumName:f.album.title,duration:f.track.durationMs/1000,syncedLyrics:'[00:01]原创'}:[]));
  }) as typeof fetch,sleep:async()=>{}});
  assert.equal(await service.lyrics(f.track,f.album,new AbortController().signal),null);
  assert.equal(urls.at(-1)!.pathname,'/api/search');
});

test('joined ripper credits can search a component without changing stored credits or skipping human review',async()=>{
  const f=fixture(),credit='原创歌手 & 别名 [乐队]×原创歌手',urls:URL[]=[];
  f.track.artistCredit=credit;f.track.artists=[credit];f.album.albumArtists=[];
  const service=createOnlineServices({lyricSources:['lrclib'],fetch:(async raw=>{
    const u=new URL(String(raw));urls.push(u);
    return new Response(JSON.stringify(u.searchParams.get('artist_name')==='原创歌手' ?
      [{id:10,trackName:f.track.title,artistName:'原创歌手',albumName:'其他专辑',duration:f.track.durationMs/1000,syncedLyrics:'[00:01]原创'}] : []));
  }) as typeof fetch,sleep:async()=>{}});
  const records=await service.searchLyrics!(f.track,f.album,new AbortController().signal);
  assert.equal(records.length,1);assert.ok(urls.length<=3);
  assert.equal(f.track.artistCredit,credit);assert.deepEqual(f.track.artists,[credit]);
  assert.equal(f.document.kind,'missing');
  assert.ok(prepareLyricsReview(f.track,f.album,f.document,records).review.candidates[0].warnings.some(w=>w.includes('署名')));
});

test('DemoBridge previews, imports to an editor draft without a revision write, and rejects replay',async()=>{
  const session=createMockSession({autoTick:false,taskDelayMs:0}),main=session.connect('main'),mini=session.connect('mini');
  try {
    const track=main.getSnapshot().library.tracks[0];
    await main.dispatch({type:'openLyricsEditor',trackId:track.id});
    const base=main.getSnapshot().lyricsEditor!.document!.revision;
    await main.dispatch({type:'searchLyricsCandidates',trackId:track.id});
    for(let i=0;i<100&&main.getSnapshot().lyricsReview?.status==='searching';i++)await new Promise(r=>setTimeout(r,5));
    const review=main.getSnapshot().lyricsReview!;assert.equal(review.status,'ready');
    assert.equal(mini.getSnapshot().lyricsReview,review);
    const a:UIAction={type:'applyLyricsCandidate',trackId:track.id,reviewId:review.id,candidateId:review.candidates[0].id,destination:'editorDraft'};
    assert.equal((await main.dispatch(a)).ok,true);
    assert.ok(main.getSnapshot().lyricsEditor!.pendingImport);
    assert.equal(main.getSnapshot().lyricsEditor!.document!.revision,base);
    assert.equal((await main.dispatch(a)).ok,false);
  } finally {session.destroy();}
});

test('real local HTTP candidates remain previews, adopt atomically, reject replay, and closing cancels late results',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'cd-lyrics-review-')),store=await openLocalStore(root),f=fixture();
  await store.transact(d=>Object.assign(d,f.data));
  let unblock:(()=>void)|undefined;
  const server=await startLocalServer({store,dataDirectory:root,online:{metadata:async()=>[],lyrics:async()=>null,
    searchLyrics:async()=>{if(unblock)await new Promise<void>(r=>{unblock=r;});return [f.record];}}});
  const post=async(route:string,a:UIAction)=>(await fetch(server.origin+'/api/'+route,{method:'POST',headers:{'content-type':'application/json','x-cd-token':server.token},body:JSON.stringify(a)})).json();
  const task=async(id:string)=>{for(let i=0;i<100;i++){const t=await(await fetch(server.origin+'/api/task/'+id,{headers:{'x-cd-token':server.token}})).json();if(t.state!=='running')return t;await new Promise(r=>setTimeout(r,5));}throw Error('Timeout');};
  try {
    const started=await post('task',{type:'searchLyricsCandidates',trackId:f.track.id});assert.equal(started.lyricsReview.status,'searching');
    const result=await task(started.taskId),r=result.result.lyricsReview;
    assert.equal(store.read().lyricsByTrack[f.track.id].kind,'missing');
    const action:UIAction={type:'applyLyricsCandidate',trackId:f.track.id,reviewId:r.id,candidateId:r.candidates[0].id};
    const adopted=await post('action',action);assert.equal(adopted.ok,true);assert.equal(adopted.view.lyricsByTrack[f.track.id].kind,'synced');
    assert.equal((await post('action',action)).code,'conflict');
    const second=await post('task',{type:'searchLyricsCandidates',trackId:f.track.id}),r2=(await task(second.taskId)).result.lyricsReview;
    const revision=store.read().library.revision;
    const draft=await post('action',{...action,reviewId:r2.id,candidateId:r2.candidates[0].id,destination:'editorDraft'});
    assert.equal(draft.ok,true);assert.equal(draft.pendingImport.kind,'synced');assert.equal(store.read().library.revision,revision);
    unblock=()=>{};
    const third=await post('task',{type:'searchLyricsCandidates',trackId:f.track.id});
    await new Promise(r=>setTimeout(r,10));await post('action',{type:'closeLyricsReview'});unblock!();
    assert.equal((await task(third.taskId)).state,'cancelled');
  } finally {await server.close();await store.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));await rm(root,{recursive:true,force:true});}
});
