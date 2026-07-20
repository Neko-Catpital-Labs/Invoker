#!/usr/bin/env node

import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const vitestArgs = args[0] === '--' ? args.slice(1) : args;
const hasTestTimeout = vitestArgs.some((arg, index) =>
  arg === '--testTimeout'
  || arg.startsWith('--testTimeout=')
  || (arg === '--test-timeout' && index < vitestArgs.length - 1)
  || arg.startsWith('--test-timeout='));
const defaultArgs = hasTestTimeout ? [] : ['--testTimeout=60000'];

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

child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});
