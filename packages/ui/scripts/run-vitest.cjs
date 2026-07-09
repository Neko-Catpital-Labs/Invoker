#!/usr/bin/env node

const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
if (args[0] === '--') {
  args.shift();
}

const result = spawnSync('vitest', ['run', ...args], {
  env: process.env,
  shell: process.platform === 'win32',
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

if (result.signal) {
  process.kill(process.pid, result.signal);
}

process.exit(result.status ?? 1);
