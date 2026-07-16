#!/usr/bin/env node

import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const forwardedArgs = args[0] === '--' ? args.slice(1) : args;

const child = spawn('vitest', ['run', ...forwardedArgs], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

child.on('error', (error) => {
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
