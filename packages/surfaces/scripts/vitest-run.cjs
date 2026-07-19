#!/usr/bin/env node

const { spawn } = require('node:child_process');

const args = process.argv.slice(2);
const passthroughArgs = args[0] === '--' ? args.slice(1) : args;
const command = process.platform === 'win32' ? 'vitest.cmd' : 'vitest';

const child = spawn(command, ['run', ...passthroughArgs], {
  stdio: 'inherit',
  env: process.env,
});

child.on('error', (error) => {
  console.error(`Failed to start vitest: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
