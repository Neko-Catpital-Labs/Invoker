#!/usr/bin/env node

const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
const normalizedArgs = args[0] === '--' ? args.slice(1) : args;
const vitestCli = require.resolve('vitest/vitest.mjs');

const result = spawnSync(process.execPath, [vitestCli, 'run', ...normalizedArgs], {
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

if (result.signal) {
  process.kill(process.pid, result.signal);
} else {
  process.exit(result.status ?? 1);
}
