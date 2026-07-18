#!/usr/bin/env node

const { spawnSync } = require('node:child_process');

const rawArgs = process.argv.slice(2);
const playwrightArgs = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;

const command = process.platform === 'linux' ? 'xvfb-run' : 'playwright';
const args = process.platform === 'linux'
  ? ['--auto-servernum', 'playwright', 'test', ...playwrightArgs]
  : ['test', ...playwrightArgs];

const result = spawnSync(command, args, {
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
