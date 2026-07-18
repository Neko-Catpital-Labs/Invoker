#!/usr/bin/env node

const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
const vitestArgs = args[0] === '--' ? args.slice(1) : args;
const bin = process.platform === 'win32' ? 'vitest.cmd' : 'vitest';

const result = spawnSync(bin, ['run', ...vitestArgs], {
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
