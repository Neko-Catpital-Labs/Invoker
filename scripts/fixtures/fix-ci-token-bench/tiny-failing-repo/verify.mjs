#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const result = spawnSync(process.execPath, ['--test', 'test/'], {
  cwd: here,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
