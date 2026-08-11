#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const binary = join(root, 'vendor', 'invoker-watcher');

if (!existsSync(binary)) {
  console.error(`invoker-watcher binary is missing at ${binary}. Reinstall @neko-catpital-labs/invoker-watcher.`);
  process.exit(1);
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' });
process.exit(result.status ?? 1);
