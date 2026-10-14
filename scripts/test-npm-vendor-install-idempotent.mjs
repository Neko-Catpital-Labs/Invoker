#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const WIPE = /rm\(vendor,\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}\)/;
const packages = [
  { path: 'packages/npm-cli/scripts/install.js', unzip: false },
  { path: 'packages/npm-ui/scripts/install.js', unzip: true },
  { path: 'packages/npm-slack/scripts/install.js', unzip: false },
  { path: 'packages/npm-watcher/scripts/install.js', unzip: false },
];

for (const pkg of packages) {
  const src = readFileSync(join(root, pkg.path), 'utf8');
  assert.match(src, WIPE, `${pkg.path} must wipe vendor/ before download/extract`);
  if (pkg.unzip) {
    assert.match(src, /unzip',\s*\['-qo'/, `${pkg.path} must unzip with -o so leftovers cannot block retry`);
  }
}

console.log('PASS: npm package postinstalls wipe vendor/ before extract (ui uses unzip -qo)');
