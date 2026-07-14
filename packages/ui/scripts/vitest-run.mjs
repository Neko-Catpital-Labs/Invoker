#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args[0] === '--') {
  args.shift();
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vitestBin = resolve(
  packageRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'vitest.cmd' : 'vitest',
);

const result = spawnSync(vitestBin, ['run', ...args], {
  cwd: packageRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? (result.signal ? 1 : 0));
