import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = path.join(root, 'tests/core');
const files = readdirSync(core).filter(name => name.endsWith('.test.ts')).sort().map(name => path.join(core, name));
const commands = [['--test', ...files], [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run']];
for (const args of commands) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
