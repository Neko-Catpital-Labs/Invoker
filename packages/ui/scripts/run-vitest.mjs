import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.on('uncaughtException', (error) => {
  console.error(error);
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  console.error(error);
  process.exit(1);
});

const forwardedArgs = process.argv.slice(2);
const vitestArgs = forwardedArgs[0] === '--' ? forwardedArgs.slice(1) : forwardedArgs;
const uiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(uiDir, '../..');
const vitestBin = resolve(
  uiDir,
  process.platform === 'win32' ? 'node_modules/.bin/vitest.cmd' : 'node_modules/.bin/vitest',
);

async function run(command, args, options = {}) {
  return await new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      ...options,
    });

    child.on('error', rejectProcess);
    child.on('exit', (code, signal) => {
      resolveProcess({ code: code ?? 1, signal });
    });
  });
}

function forwardSignal(signal) {
  if (!signal) return;
  process.kill(process.pid, signal);
  process.exit(1);
}

if (!existsSync(vitestBin)) {
  const install = await run('pnpm', ['install', '--frozen-lockfile'], { cwd: workspaceRoot });
  forwardSignal(install.signal);
  if (install.code !== 0) {
    process.exit(install.code);
  }
}

if (!existsSync(vitestBin)) {
  console.error(`Vitest binary was not found after install: ${vitestBin}`);
  process.exit(1);
}

const test = await run(vitestBin, ['run', ...vitestArgs], { cwd: uiDir });
forwardSignal(test.signal);
process.exit(test.code);
