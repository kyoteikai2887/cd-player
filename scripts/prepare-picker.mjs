import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);
export async function prepareWindowsPicker(output, source = path.join(root, 'scripts/FilePicker.cs')) {
  if (process.platform !== 'win32') throw new Error('Windows picker requires Windows');
  const windows = process.env.SystemRoot ?? 'C:\\Windows';
  const candidates = ['Framework64', 'Framework'].map(name =>
    path.join(windows, 'Microsoft.NET', name, 'v4.0.30319', 'csc.exe'));
  let compiler;
  for (const candidate of candidates) {
    try { await access(candidate); compiler = candidate; break; } catch {}
  }
  if (!compiler) throw new Error('Windows .NET Framework compiler is unavailable');
  await mkdir(output, { recursive: true });
  const executable = path.join(output, 'file-picker.exe');
  await run(compiler, [
    '/nologo', '/target:winexe', '/optimize+', '/codepage:65001',
    '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll',
    '/out:' + executable, source,
  ], { windowsHide: true, timeout: 30000 });
  return executable;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await prepareWindowsPicker(path.join(root, '.native-runtime')));
}
