#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

fail() {
  echo "[repro] FAIL: $1"
  exit 1
}

node - "packages/app/e2e/visual-proof.spec.ts" <<'NODE'
const fs = require('node:fs');
const path = process.argv[2];
const source = fs.readFileSync(path, 'utf8');
const start = source.indexOf("test('terminal planning loads graph'");
if (start === -1) {
  console.error('[repro] FAIL: terminal planning test not found');
  process.exit(1);
}
const next = source.indexOf("test('dag loaded'", start);
const block = source.slice(start, next === -1 ? undefined : next);
const tryIndex = block.indexOf('try {');
const finallyIndex = block.indexOf('} finally {');
const clearIndex = block.indexOf('setTestPlanFromGoalResponse(null)');
if (tryIndex === -1 || finallyIndex === -1) {
  console.error('[repro] FAIL: override cleanup is not guarded by try/finally');
  process.exit(1);
}
if (clearIndex === -1 || clearIndex < finallyIndex) {
  console.error('[repro] FAIL: override clear does not run from the finally block');
  process.exit(1);
}
if (!block.slice(tryIndex, finallyIndex).includes('captureScreenshot(page, \'terminal-planned-graph\')')) {
  console.error('[repro] FAIL: screenshot/assertion flow is outside the guarded section');
  process.exit(1);
}
NODE

echo "[repro] PASS: terminal planning override cleanup is guarded"
