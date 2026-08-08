#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-disk-reclaim-asar-enotdir.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

ASAR_PATH="$TMP_DIR/worktrees/wt-1/node_modules/electron/dist/resources/default_app.asar"
SCRIPT_PATH="$TMP_DIR/repro-disk-reclaim-asar-enotdir.cjs"

mkdir -p "$(dirname "$ASAR_PATH")"

node - "$ASAR_PATH" <<'NODE'
const fs = require('node:fs');

const asarPath = process.argv[2];

function alignUInt32(size) {
  return size + ((4 - (size % 4)) % 4);
}

function makePickle(payload) {
  const buffer = Buffer.alloc(4 + alignUInt32(payload.length));
  buffer.writeUInt32LE(payload.length, 0);
  payload.copy(buffer, 4);
  return buffer;
}

function makeUInt32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}

const headerJson = JSON.stringify({ files: {} });
const headerPayload = Buffer.concat([
  makeUInt32(Buffer.byteLength(headerJson, 'utf8')),
  Buffer.from(headerJson, 'utf8'),
]);
const headerPickle = makePickle(headerPayload);
const sizePickle = makePickle(makeUInt32(headerPickle.length));

fs.writeFileSync(asarPath, Buffer.concat([sizePickle, headerPickle, Buffer.alloc(512)]));
NODE

cat > "$SCRIPT_PATH" <<'NODE'
const fs = require('node:fs');

const asarPath = process.argv.at(-1);

function fail(message) {
  console.error(`[repro] FAIL: ${message}`);
  process.exit(1);
}

if (!asarPath) {
  fail('missing asar path argument');
}

const virtualStat = fs.statSync(asarPath);
if (!virtualStat.isDirectory()) {
  fail(`expected Electron to stat ${asarPath} as a virtual directory`);
}

let rmdirError;
try {
  fs.rmdirSync(asarPath);
} catch (error) {
  rmdirError = error;
}

if (!rmdirError) {
  fail(`expected rmdirSync(${asarPath}) to throw ENOTDIR`);
}
if (rmdirError.code !== 'ENOTDIR') {
  fail(`expected ENOTDIR from rmdirSync(${asarPath}), got ${rmdirError.code ?? String(rmdirError)}`);
}

console.log(String(rmdirError));

process.noAsar = true;
const realStat = fs.statSync(asarPath);
if (!realStat.isFile()) {
  fail(`expected process.noAsar to reveal ${asarPath} as a real file`);
}

console.log('[repro] reproduced: Electron asar patching breaks in-process directory sweeps (guard pending in this stack)');
process.exit(0);
NODE

cd "$REPO_ROOT"
node ./scripts/electron.cjs \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --disable-gpu-compositing \
  --disable-gpu-sandbox \
  --disable-software-rasterizer \
  "$SCRIPT_PATH" \
  "$ASAR_PATH"
