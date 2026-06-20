#!/usr/bin/env node

const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
if (args[0] === '--') args.shift();

const result = spawnSync(process.execPath, [require.resolve('vitest/vitest.mjs'), 'run', ...args], {
  stdio: 'inherit',
  env: process.env,
});

if (typeof result.status === 'number') {
  process.exit(result.status);
}

process.exit(result.signal ? 1 : 0);
