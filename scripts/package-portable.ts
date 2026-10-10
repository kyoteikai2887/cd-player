import path from 'node:path';
import { nativeProductVersion } from './native-version.ts';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, readdir, copyFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const PORTABLE_DOCS = {
  'V1_USER_GUIDE_ZH.md':'说明.md', 'V1_RELEASE_NOTES_ZH.md':'版本说明.md', 'COLLABORATION_ZH.md':'合作纪念.md', 'PUBLICATION_STATUS_ZH.md':'公开发布准备.md', 'ONLINE_ZH.md':'在线说明.md', 'PATH_RECOVERY_ZH.md':'目录恢复说明.md',
  'STARTUP_RECOVERY_ZH.md':'启动修复说明.md', 'V1_PROGRESS_ZH.md':'项目进度.md', 'SHORTCUTS_ZH.md':'快捷键.md',
  'BACKUP_ZH.md':'BACKUP_ZH.md', 'DIAGNOSTICS_ZH.md':'故障记录说明.md', 'SLEEP_WAKE_RECOVERY_ZH.md':'休眠恢复说明.md',
} as const;
export interface PortableOptions { project: string; output: string; licenses: string }
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
async function files(folder:string):Promise<string[]> {
  const result:string[]=[];
  for(const e of await readdir(folder,{withFileTypes:true})) {
    if(e.isSymbolicLink())throw Error('Package input contains a symbolic link');
    const p=path.join(folder,e.name);
    if(e.isDirectory())result.push(...await files(p));else if(e.isFile())result.push(p);
  }
  return result.sort();
}
export async function packagePortable(options:PortableOptions) {
  const project=await realpath(options.project),licenses=await realpath(options.licenses),output=path.resolve(options.output);
  const version=JSON.parse(await readFile(path.join(project,'package.json'),'utf8')).version as string;
  if(!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(version))throw Error('Invalid package version');
  const native=path.join(project,'src-tauri/target/release/cd-player-desktop.exe'),exe=await readFile(native);
  if(nativeProductVersion(exe)!==version)throw Error('Native build version does not match package.json');
  const runtime=path.join(project,'.native-runtime'),web=path.join(project,'dist');
  for(const source of [runtime,web,licenses]) {
    const rel=path.relative(source,output);
    if(!rel||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel)))throw Error('Output must be outside package inputs');
  }
  const licenseEntries=JSON.parse(await readFile(path.join(licenses,'INDEX.json'),'utf8')) as {file:string}[];
  if(!Array.isArray(licenseEntries)||!licenseEntries.length)throw Error('License index is empty');
  for(const entry of licenseEntries) {
    if(typeof entry.file!=='string'||path.isAbsolute(entry.file)||entry.file.split(/[\\/]/).includes('..'))throw Error('Invalid license path');
    const actual=await realpath(path.join(licenses,entry.file)),rel=path.relative(licenses,actual);
    if(!rel||rel.startsWith('..'+path.sep)||path.isAbsolute(rel)||!(await stat(actual)).isFile())throw Error('License entry escapes its directory');
  }
  const pairs:[string,string][]=[[native,'CD播放器.exe']];
  for(const name of ['node.exe','server.mjs','file-picker.exe'])pairs.push([path.join(runtime,name),'runtime/'+name]);
  for(const folder of [web,licenses])for(const p of await files(folder))pairs.push([p,(folder===web?'web/':'licenses/')+path.relative(folder,p).replaceAll(path.sep,'/')]);
  for(const [source,target] of Object.entries(PORTABLE_DOCS))pairs.push([path.join(project,'docs',source),target]);
  // Root notices are included when supplied, independently of dependency licenses.
  for(const name of ['LICENSE','ARTWORK_NOTICE.md']) {
    const source=path.join(project,name);
    try { if((await stat(source)).isFile())pairs.push([source,name]); } catch(error) {
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
    }
  }
  for(const [source] of pairs)if(!(await stat(source)).isFile())throw Error('Missing portable input');
  // Refuse to overwrite an existing directory or prior release.
  await mkdir(path.dirname(output),{recursive:true});await mkdir(output);
  for(const [source,rel]of pairs) {const target=path.join(output,rel);await mkdir(path.dirname(target),{recursive:true});await copyFile(source,target);}
  await writeFile(path.join(output,'README.txt'),`CD 播放器 ${version}\n先通过旧版托盘“退出”，再运行 CD播放器.exe。\n保留 runtime、web、licenses 文件夹；已有收藏与设置沿用。\nWindows x64 便携版；系统需已有 Microsoft Edge WebView2 Runtime。\n使用方法见 说明.md，故障记录见 故障记录说明.md。\n`);
  const manifest=[];
  for(const p of await files(output)) {const bytes=await readFile(p);manifest.push({path:path.relative(output,p).replaceAll(path.sep,'/'),bytes:bytes.length,sha256:digest(bytes)});}
  await writeFile(path.join(output,'MANIFEST.json'),JSON.stringify({version,files:manifest},null,2));
  return {output,version,files:manifest.length,licenseEntries:licenseEntries.length};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const args=process.argv.slice(2),value=(name:string)=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined;};
  const output=value('--output'),licenses=value('--licenses');
  if(!output||!licenses)throw Error('Usage: node --experimental-strip-types scripts/package-portable.ts --output <new directory> --licenses <verified license collection>');
  console.log(JSON.stringify(await packagePortable({project:root,output,licenses})));
}
