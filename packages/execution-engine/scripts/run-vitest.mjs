#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
const vitestArgs = args[0] === '--' ? args.slice(1) : args;
const hasTestTimeout = vitestArgs.some((arg, index) =>
  arg === '--testTimeout'
  || arg.startsWith('--testTimeout=')
  || (arg === '--test-timeout' && index < vitestArgs.length - 1)
  || arg.startsWith('--test-timeout='));
const defaultArgs = hasTestTimeout ? [] : ['--testTimeout=60000'];

let provisionedMissingDependencies = false;

function findWorkspaceRoot(startDir) {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(resolve(current, 'pnpm-lock.yaml')) || existsSync(resolve(current, 'pnpm-workspace.yaml'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return startDir;
    current = parent;
  }
}

function provisionDependencies() {
  const root = findWorkspaceRoot(process.cwd());
  console.error(`[run-vitest] vitest not found; running pnpm install --frozen-lockfile in ${root}`);
  return new Promise((resolveProvision, rejectProvision) => {
    const install = spawn('pnpm', ['install', '--frozen-lockfile'], {
      cwd: root,
      env: { ...process.env, NODE_ENV: 'development' },
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    install.on('exit', (code, signal) => {
      if (signal) {
        rejectProvision(new Error(`pnpm install terminated by ${signal}`));
        return;
      }
      if (code === 0) {
        resolveProvision();
        return;
      }
      rejectProvision(new Error(`pnpm install --frozen-lockfile failed with exit code ${code ?? 1}`));
    });
    install.on('error', rejectProvision);
  });
}

function runVitest() {
  const child = spawn('vitest', ['run', ...defaultArgs, ...vitestArgs], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });

  child.on('error', async (error) => {
    if ((error?.code === 'ENOENT' || error?.errno === -2) && !provisionedMissingDependencies) {
      provisionedMissingDependencies = true;
      try {
        await provisionDependencies();
        runVitest();
      } catch (provisionError) {
        console.error(provisionError);
        process.exit(1);
      }
      return;
    }
    console.error(error);
    process.exit(1);
  });
}

runVitest();
