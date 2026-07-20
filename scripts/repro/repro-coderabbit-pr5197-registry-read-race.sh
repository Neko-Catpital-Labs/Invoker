#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
TARGET="$ROOT/scripts/cleanup-orphaned-automation-chrome.mjs"
echo "[repro] problem: registry reads must survive the file disappearing after the caller picked the path"
echo "[repro] check: ENOENT becomes an empty registry, but other read errors still fail"
node - "$TARGET" <<'NODE'
const fs = require('node:fs');
const vm = require('node:vm');

const targetPath = process.argv[2];
let source = fs.readFileSync(targetPath, 'utf8');
source = source
  .replace(/^#!.*\n/, '')
  .replace(/^import .*$/gm, '')
  .replace(/^export async function /gm, 'async function ')
  .replace(/^export function /gm, 'function ')
  .replace(/if \(import\.meta\.url === `file:\/\/\$\{process\.argv\[1\]\}`\) \{[\s\S]*$/, '');
source += '\nglobalThis.__exports = { readTrackedUserDataDirs };\n';

const context = {
  process: { argv: [], env: {}, kill: () => {} },
  execFileCb: () => {},
  existsSync: () => true,
  fsReadFileSync: () => '',
  promisify: (fn) => fn,
  console,
  setTimeout,
  clearTimeout,
  Date,
  Set,
  Map,
  Promise,
  globalThis: null,
};
context.globalThis = context;
vm.runInNewContext(source, context, { filename: targetPath });

const { readTrackedUserDataDirs } = context.__exports;

const enoent = new Error('missing');
enoent.code = 'ENOENT';
context.fsReadFileSync = () => {
  throw enoent;
};
const tracked = readTrackedUserDataDirs('/tmp/invoker-e2e-browser-registry-abc123/user-data-dirs.txt');
if (!Array.isArray(tracked) || tracked.length !== 0) {
  console.error('[repro] FAIL: ENOENT did not become an empty registry');
  process.exit(1);
}

const eacces = new Error('denied');
eacces.code = 'EACCES';
context.fsReadFileSync = () => {
  throw eacces;
};
let rethrew = false;
try {
  readTrackedUserDataDirs('/tmp/invoker-e2e-browser-registry-abc123/user-data-dirs.txt');
} catch (error) {
  rethrew = error === eacces;
}
if (!rethrew) {
  console.error('[repro] FAIL: non-ENOENT read errors were swallowed');
  process.exit(1);
}

console.log('[repro] PASS: disappearing registry files are ignored, other read failures still stop cleanup');
NODE
