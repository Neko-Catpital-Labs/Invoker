#!/usr/bin/env node

const { spawn } = require('node:child_process');

const args = process.argv.slice(2);
const forwarded = args[0] === '--' ? args.slice(1) : args;
const child = spawn('vitest', ['run', ...forwarded], {
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
  console.error(error.message);
  process.exit(1);
});
