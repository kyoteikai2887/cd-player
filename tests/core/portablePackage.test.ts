import test from 'node:test';
import { nativeVersionFixture } from './nativeVersion.fixture.ts';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { packagePortable, PORTABLE_DOCS } from '../../scripts/package-portable.ts';
async function fixture() {
  const root=await mkdtemp(path.join(tmpdir(),'cd-portable-')),project=path.join(root,'project'),licenses=path.join(root,'licenses'),output=path.join(root,'output');
  for(const name of ['src-tauri/target/release','.native-runtime','dist/assets','docs','.cache','.local-data'])await mkdir(path.join(project,name),{recursive:true});
  await mkdir(licenses);await writeFile(path.join(project,'package.json'),JSON.stringify({version:'0.4.0-original-test.1'}));
  await writeFile(path.join(project,'src-tauri/target/release/cd-player-desktop.exe'),nativeVersionFixture('0.4.0-original-test.1'));
  for(const name of ['node.exe','server.mjs','file-picker.exe'])await writeFile(path.join(project,'.native-runtime',name),'original fixture');
  await writeFile(path.join(project,'dist/assets/app.js'),'original frontend');
  for(const name of Object.keys(PORTABLE_DOCS))await writeFile(path.join(project,'docs',name),'original documentation');
  await writeFile(path.join(project,'.local-data/library.json'),'private music metadata');
  await writeFile(path.join(project,'.cache/online.json'),'private lyrics');
  await writeFile(path.join(licenses,'LICENSE.txt'),'original license fixture');await writeFile(path.join(licenses,'INDEX.json'),JSON.stringify([{file:'LICENSE.txt'}]));
  return {root,project,licenses,output};
}
async function cleanup(root:string) {assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));assert.ok(path.basename(root).startsWith('cd-portable-'));await rm(root,{recursive:true,force:true});}
test('portable release packaging keeps runtime/assets/licenses and excludes private data, and never overwrites a prior release',async()=>{
  const f=await fixture();try {
    await writeFile(path.join(f.project,'LICENSE'),'MIT license fixture');
    await writeFile(path.join(f.project,'ARTWORK_NOTICE.md'),'separate artwork notice');
    const report=await packagePortable(f);assert.equal(report.version,'0.4.0-original-test.1');
    const manifest=JSON.parse(await readFile(path.join(f.output,'MANIFEST.json'),'utf8'));
    assert.ok(manifest.files.some((p:{path:string})=>p.path==='runtime/server.mjs'));
    assert.ok(manifest.files.every((p:{path:string})=>!p.path.includes('.cache')&&!p.path.includes('.local-data')));
    assert.equal(await readFile(path.join(f.output,'licenses/LICENSE.txt'),'utf8'),'original license fixture');
    assert.equal(await readFile(path.join(f.output,'LICENSE'),'utf8'),'MIT license fixture');
    assert.equal(await readFile(path.join(f.output,'ARTWORK_NOTICE.md'),'utf8'),'separate artwork notice');
    assert.ok(manifest.files.some((p:{path:string})=>p.path==='LICENSE'));
    assert.ok(manifest.files.some((p:{path:string})=>p.path==='ARTWORK_NOTICE.md'));
    await assert.rejects(packagePortable(f),/EEXIST/);assert.equal(await readFile(path.join(f.output,'web/assets/app.js'),'utf8'),'original frontend');
  } finally {await cleanup(f.root);}
});
test('incorrect native version and missing or escaping licenses stop packaging before creating an output',async()=>{
  const f=await fixture();try {
    await writeFile(path.join(f.project,'src-tauri/target/release/cd-player-desktop.exe'),Buffer.concat([nativeVersionFixture('9.0.0'), Buffer.from('0.4.0-original-test.1')]));
    await assert.rejects(packagePortable(f),/version/);await assert.rejects(access(f.output));
    await writeFile(path.join(f.project,'src-tauri/target/release/cd-player-desktop.exe'),nativeVersionFixture('0.4.0-original-test.1'));
    await writeFile(path.join(f.licenses,'INDEX.json'),JSON.stringify([{file:'absent.txt'}]));
    await assert.rejects(packagePortable(f));await assert.rejects(access(f.output));
    await writeFile(path.join(f.licenses,'INDEX.json'),JSON.stringify([{file:'../project/package.json'}]));
    await assert.rejects(packagePortable(f),/license path/);await assert.rejects(access(f.output));
  } finally {await cleanup(f.root);}
});
