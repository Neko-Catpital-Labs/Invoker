#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const vitestPath = require.resolve('vitest/vitest.mjs');
const args = process.argv.slice(2);
const forwardedArgs = args[0] === '--' ? args.slice(1) : args;

const result = spawnSync(process.execPath, [vitestPath, 'run', ...forwardedArgs], {
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
