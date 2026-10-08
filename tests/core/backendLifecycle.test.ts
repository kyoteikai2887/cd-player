import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { get } from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { openLocalStore } from '../../src/local/store.ts';

async function fixture() {
  const root=await mkdtemp(path.join(tmpdir(),'cd-lifecycle-'));
  const data=path.join(root,'data'),assets=path.join(root,'web');await mkdir(assets);
  await writeFile(path.join(assets,'desktop.html'),'<!doctype html><title>Original lifecycle fixture</title>');
  await writeFile(path.join(assets,'large.txt'),'original fixture\n'.repeat(500000));
  const store=await openLocalStore(data);
  try { await store.transact(d=>{d.library.revision=23;d.settings.accentColor='#123456';}); }
  finally { await store.close(); }
  const bytes=await readFile(path.join(data,'library.json'));
  const entry=pathToFileURL(path.resolve('scripts/native-server.mjs')).href;
  const child=spawn(process.execPath,['--input-type=module','-e',
    `globalThis.CD_DESKTOP_ENTRY=true; await import(${JSON.stringify(entry)});`,'test-entry',
    '--data',data,'--assets',assets,'--picker',path.join(root,'unused.exe'),'--recover-stale-lock']);
  child.stderr.resume();
  const exited=once(child,'exit');
  const lines=createInterface({input:child.stdout});
  let timer: ReturnType<typeof setTimeout>|undefined;
  const frame=await Promise.race([once(lines,'line'),new Promise<never>((_,reject)=>{
    timer=setTimeout(()=>reject(Error('Backend did not start')),5000);
  })]).finally(()=>clearTimeout(timer));
  lines.close();child.stdout.resume();
  const {origin}=JSON.parse(frame[0] as string);assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/);
  return {root,data,bytes,origin,child,exited};
}
async function closeWithin(exit:Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout>|undefined;
  try {return await Promise.race([exit,new Promise<never>((_,reject)=>{
    timer=setTimeout(()=>reject(Error('Shutdown held writer lock beyond native grace period')),4000);
  })]);} finally {clearTimeout(timer);}
}
async function cleanup(f:Awaited<ReturnType<typeof fixture>>) {
  f.child.kill();await f.exited;
  assert.equal(path.dirname(path.resolve(f.root)),path.resolve(tmpdir()));
  assert.ok(path.basename(f.root).startsWith('cd-lifecycle-'));
  await rm(f.root,{recursive:true,force:true});
}

test('host pipe EOF shuts the actual backend with a blocked static stream and preserves saved data',async()=>{
  const f=await fixture();let request:ReturnType<typeof get>|undefined;
  try {
    await new Promise<void>((resolve,reject)=>{
      request=get(f.origin+'/large.txt',res=>{res.pause();res.on('error',()=>{});resolve();});
      request.on('error',reject);
    });
    f.child.stdin.end();const exit=await closeWithin(f.exited) as unknown[];assert.equal(exit[0],0);
    assert.deepEqual(await readFile(path.join(f.data,'library.json')),f.bytes);
    await assert.rejects(readFile(path.join(f.data,'writer.lock')),{code:'ENOENT'});
    const reopened=await openLocalStore(f.data);await reopened.close();
  } finally {request?.destroy();await cleanup(f);}
});

test('unknown control lines do not stop the backend, and repeated shutdown requests release it once',async()=>{
  const f=await fixture();
  try {
    f.child.stdin.write('not-a-shutdown-command\n');
    assert.equal((await fetch(f.origin+'/desktop.html')).status,200);
    f.child.stdin.write('shutdown\nshutdown\n');const exit=await closeWithin(f.exited) as unknown[];
    assert.equal(exit[0],0);assert.deepEqual(await readFile(path.join(f.data,'library.json')),f.bytes);
    await assert.rejects(readFile(path.join(f.data,'writer.lock')),{code:'ENOENT'});
  } finally {await cleanup(f);}
});

test('forced backend termination leaves a verifiable lease that guarded restart recovers without rewriting the collection',async()=>{
  const f=await fixture();
  try {
    const lease=await readFile(path.join(f.data,'writer.lock'),'utf8');
    assert.equal(JSON.parse(lease).pid,f.child.pid);
    f.child.kill('SIGKILL');await closeWithin(f.exited);
    assert.equal(await readFile(path.join(f.data,'writer.lock'),'utf8'),lease);
    const restored=await openLocalStore(f.data,{recoverDeadOwner:true});
    try {assert.equal(restored.view().library.revision,23);assert.equal(restored.view().settings.accentColor,'#123456');}
    finally {await restored.close();}
    assert.deepEqual(await readFile(path.join(f.data,'library.json')),f.bytes);
  } finally {await cleanup(f);}
});
