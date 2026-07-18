#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vendor = join(root, 'vendor');
const appPath = join(vendor, 'Invoker.app');
const appImage = join(vendor, 'Invoker.AppImage');

function commandExists(command) {
  return spawnSync('sh', ['-c', `command -v ${command} >/dev/null 2>&1`], { stdio: 'ignore' }).status === 0;
}

function doctor() {
  const checks = ['git', 'pnpm', 'gh', 'docker', 'codex', 'claude', 'ssh'];
  let ok = true;
  for (const command of checks) {
    const available = commandExists(command);
    ok &&= available;
    console.log(`${available ? 'ok' : 'missing'} ${command}`);
  }
  console.log(`${existsSync(appPath) || existsSync(appImage) ? 'ok' : 'missing'} invoker desktop artifact`);
  return ok ? 0 : 1;
}

if (process.argv[2] === 'doctor') {
  process.exit(doctor());
}

if (process.platform === 'darwin') {
  if (!existsSync(appPath)) {
    console.error(`Invoker.app is missing at ${appPath}. Reinstall @neko-catpital-labs/invoker-ui.`);
    process.exit(1);
  }
  const result = spawnSync('open', ['-a', appPath, '--args', ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(result.status ?? 0);
}

if (process.platform === 'linux') {
  if (!existsSync(appImage)) {
    console.error(`Invoker AppImage is missing at ${appImage}. Reinstall @neko-catpital-labs/invoker-ui.`);
    process.exit(1);
  }
  const result = spawnSync(appImage, process.argv.slice(2), { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

console.error(`Unsupported platform: ${process.platform}`);
process.exit(1);
