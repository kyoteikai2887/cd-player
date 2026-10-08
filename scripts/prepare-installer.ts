import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, realpath, stat, mkdir, copyFile } from 'node:fs/promises';
import { packagePortable, PORTABLE_DOCS } from './package-portable.ts';

/** Stage only the already verified release inputs; never scan a collection or profile. */
export async function prepareInstaller(options: {project:string; output:string; licenses:string}) {
  const project=await realpath(options.project),output=path.resolve(options.output);
  const config=JSON.parse(await readFile(path.join(project,'src-tauri/tauri.conf.json'),'utf8'));
  if(config.identifier!=='local.cdplayer.v1')throw Error('Installer app identity must remain stable');
  const version=JSON.parse(await readFile(path.join(project,'package.json'),'utf8')).version;
  if(config.version!==version)throw Error('Installer configuration version does not match the package');
  const allowedResources={'../.native-runtime/':'runtime/','../dist/':'web/'};
  if(JSON.stringify(Object.entries(config.bundle.resources).sort())!==JSON.stringify(Object.entries(allowedResources).sort()))
    throw Error('Installer resources must only reference the prepared runtime and production web assets');
  for(const name of ['installer.nsi','installer-hooks.nsh','licenses/NSIS-COPYING.txt','licenses/NSIS-tauri-utils-LICENSE-MIT','licenses/NSIS-tauri-utils-LICENSE-APACHE-2.0','licenses/SOURCES.md'])
    if(!(await stat(path.join(project,'src-tauri/windows',name))).isFile())throw Error('Missing installer template');
  for(const name of ['Cargo.toml','Cargo.lock','icons/icon.ico'])
    if(!(await stat(path.join(project,'src-tauri',name))).isFile())throw Error('Missing native bundle input');
  const report=await packagePortable({project,output,licenses:options.licenses});
  const resources={[path.join(output,'runtime')+'/']:'runtime/',[path.join(output,'web')+'/']:'web/',
    [path.join(output,'licenses')+'/']:'licenses/',
    [path.join(project,'src-tauri/windows/licenses')+'/']:'licenses/installer/'};
  for(const target of Object.values(PORTABLE_DOCS))resources[path.join(output,target)]=target;
  const bundleConfig={...config,build:{frontendDist:path.join(output,'web')},bundle:{active:true,targets:['nsis'],useLocalToolsDir:true,resources,
    icon:[path.join(project,'src-tauri/icons/icon.ico')],
    windows:{allowDowngrades:false,webviewInstallMode:{type:'downloadBootstrapper',silent:true},
      nsis:{installMode:'currentUser',languages:['SimpChinese'],displayLanguageSelector:false,compression:'zlib',
        startMenuFolder:'CD 播放器',template:path.join(project,'src-tauri/windows/installer.nsi'),
        installerHooks:path.join(project,'src-tauri/windows/installer-hooks.nsh')}}}};
  // A separate bundle-only project prevents Tauri's overlay merge from reintroducing
  // entire development folders (e.g. obsolete server.cjs, pick.ps1, or private caches).
  const bundleProject=path.join(output,'bundle-project'),native=path.join(bundleProject,'src-tauri');
  await mkdir(path.join(native,'src'),{recursive:true});await mkdir(path.join(native,'target/release'),{recursive:true});
  for(const name of ['Cargo.toml','Cargo.lock'])await copyFile(path.join(project,'src-tauri',name),path.join(native,name));
  await writeFile(path.join(native,'src/main.rs'),'// Metadata target for bundle-only staging. No application compilation here.\nfn main() {}\n');
  await writeFile(path.join(native,'build.rs'),'compile_error!("Installer stage is bundle-only: build the original application, then prepare a new stage.");\n');
  await writeFile(path.join(bundleProject,'package.json'),JSON.stringify({name:'cd-player-installer-stage',private:true,version}));
  await copyFile(path.join(output,'CD播放器.exe'),path.join(native,'target/release/cd-player-desktop.exe'));
  const configurationPath=path.join(native,'tauri.conf.json');
  await writeFile(configurationPath,JSON.stringify(bundleConfig,null,2));
  // Configuration and manifest are build evidence, not installed application resources.
  return {...report,bundleProject,configurationPath,installerIsSigned:false};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),value=(name:string)=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
  const output=value('--output'),licenses=value('--licenses');
  if(!output||!licenses)throw Error('Usage: node scripts/prepare-installer.ts --output <new stage directory> --licenses <verified licenses>');
  console.log(JSON.stringify(await prepareInstaller({project:path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),output,licenses})));
}
