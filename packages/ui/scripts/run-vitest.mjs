#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const forwardedArgs = args[0] === '--' ? args.slice(1) : args;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, '..');
const repoRoot = resolve(packageDir, '../..');
const vitestExecutable = process.platform === 'win32' ? 'vitest.cmd' : 'vitest';

function findVitestBin() {
  for (const baseDir of [packageDir, repoRoot]) {
    const candidate = resolve(baseDir, 'node_modules', '.bin', vitestExecutable);
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

let vitestBin = findVitestBin();
if (!vitestBin) {
  const install = spawnSync('pnpm', ['install', '--frozen-lockfile'], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (install.error) {
    console.error(install.error.message);
    process.exit(install.error.code === 'ENOENT' ? 127 : 1);
  }

  if (install.status !== 0) {
    process.exit(install.status ?? 1);
  }

  vitestBin = findVitestBin();
}

const child = spawn(vitestBin ?? vitestExecutable, ['run', ...forwardedArgs], {
  cwd: packageDir,
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32',
});

child.on('error', error => {
  console.error(error.message);
  process.exit(error.code === 'ENOENT' ? 127 : 1);
});

child.on('close', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
