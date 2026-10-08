import test from 'node:test';
import { nativeVersionFixture } from './nativeVersion.fixture.ts';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtemp,mkdir,readFile,writeFile,rm,access } from 'node:fs/promises';
import { prepareInstaller } from '../../scripts/prepare-installer.ts';
import { PORTABLE_DOCS } from '../../scripts/package-portable.ts';
const config={version:'0.4.0-original-test.1',identifier:'local.cdplayer.v1',bundle:{resources:{'../.native-runtime/':'runtime/','../dist/':'web/'}}};
async function fixture() {
  const root=await mkdtemp(path.join(tmpdir(),'cd-installer-')),project=path.join(root,'project'),licenses=path.join(root,'licenses'),output=path.join(root,'output');
  for(const folder of ['src-tauri/target/release','src-tauri/icons','src-tauri/windows/licenses','.native-runtime','dist','docs','.local-data'])await mkdir(path.join(project,folder),{recursive:true});
  await mkdir(licenses);await writeFile(path.join(project,'package.json'),JSON.stringify({version:config.version}));
  await writeFile(path.join(project,'src-tauri/tauri.conf.json'),JSON.stringify(config));
  for(const name of ['Cargo.toml','Cargo.lock','icons/icon.ico'])await writeFile(path.join(project,'src-tauri',name),'original native metadata fixture');
  await writeFile(path.join(project,'src-tauri/target/release/cd-player-desktop.exe'),nativeVersionFixture(config.version));
  for(const name of ['installer.nsi','installer-hooks.nsh'])await writeFile(path.join(project,'src-tauri/windows',name),'original fixture');
  for(const name of ['NSIS-COPYING.txt','NSIS-tauri-utils-LICENSE-MIT','NSIS-tauri-utils-LICENSE-APACHE-2.0','SOURCES.md'])await writeFile(path.join(project,'src-tauri/windows/licenses',name),'original license fixture');
  for(const name of ['node.exe','server.mjs','file-picker.exe'])await writeFile(path.join(project,'.native-runtime',name),'original fixture');
  await writeFile(path.join(project,'.native-runtime/obsolete-server.cjs'),'obsolete runtime or private development fixture');
  await writeFile(path.join(project,'dist/app.js'),'original frontend');
  for(const name of Object.keys(PORTABLE_DOCS))await writeFile(path.join(project,'docs',name),'original documentation');
  await writeFile(path.join(project,'.local-data/library.json'),'private metadata');
  await writeFile(path.join(licenses,'LICENSE.txt'),'original license');await writeFile(path.join(licenses,'INDEX.json'),JSON.stringify([{file:'LICENSE.txt'}]));
  return {root,project,licenses,output};
}
async function cleanup(root:string){assert.equal(path.dirname(root),path.resolve(tmpdir()));assert.ok(path.basename(root).startsWith('cd-installer-'));await rm(root,{recursive:true,force:true});}
test('installer overlay retains verified release resources and licenses without collecting personal data',async()=>{
  const f=await fixture();try {
    const r=await prepareInstaller(f),o=JSON.parse(await readFile(r.configurationPath,'utf8'));
    assert.equal(o.bundle.windows.nsis.installMode,'currentUser');assert.equal(o.bundle.windows.allowDowngrades,false);
    assert.equal(o.bundle.windows.webviewInstallMode.type,'downloadBootstrapper');
    assert.equal(await readFile(path.join(f.output,'licenses/LICENSE.txt'),'utf8'),'original license');
    assert.ok(Object.values(o.bundle.resources).includes('licenses/'));
    assert.ok(Object.keys(o.bundle.resources).every(p=>!p.includes('.local-data')));
    assert.ok(Object.keys(o.bundle.resources).every(p=>!p.includes('.native-runtime')));
    assert.ok(Object.keys(o.bundle.resources).some(p=>p.startsWith(f.output)&&p.endsWith('runtime/')));
    await assert.rejects(access(path.join(f.output,'runtime/obsolete-server.cjs')));
    assert.deepEqual(await readFile(path.join(r.bundleProject,'src-tauri/target/release/cd-player-desktop.exe')),nativeVersionFixture(config.version));
    await assert.rejects(access(path.join(f.output,'.local-data')));await assert.rejects(prepareInstaller(f),/EEXIST/);
  }finally{await cleanup(f.root);}
});
test('identity, version, and unexpected personal resource paths are rejected before staging',async()=>{
  const f=await fixture();try {
    for(const bad of [{...config,identifier:'different.app'},{...config,version:'9.0.0'},{...config,bundle:{resources:{...config.bundle.resources,'../.local-data/':'private/'}}}]) {
      await writeFile(path.join(f.project,'src-tauri/tauri.conf.json'),JSON.stringify(bad));
      await assert.rejects(prepareInstaller(f));await assert.rejects(access(f.output));
    }
  }finally{await cleanup(f.root);}
});
test('install and uninstall template cannot force-terminate processes or delete application data',async()=>{
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
  const template=await readFile(path.join(root,'src-tauri/windows/installer.nsi'),'utf8');
  const guard=await readFile(path.join(root,'src-tauri/windows/installer-hooks.nsh'),'utf8');
  assert.equal((template.match(/!insertmacro CD_CheckAppStopped/g)||[]).length,2);
  assert.doesNotMatch(template,/!insertmacro CheckIfAppIsRunning|DeleteAppDataCheckbox|RmDir\s+\/r(?:\s|$)/im);
  assert.doesNotMatch(guard,/RmShutdown|TerminateProcess|taskkill|KillProcess/i);
  assert.match(guard,/writer\.lock/);assert.match(guard,/RestartManager_EndSession/);
  const init=template.slice(template.indexOf('Function .onInit'),template.indexOf('Section EarlyChecks'));
  assert.match(init,/!insertmacro CD_CheckVersion/);assert.match(guard,/SemverCompare/);
  assert.match(template,/!define UNINSTKEY "[^\n]*\$\{BUNDLEID\}"/);
});
