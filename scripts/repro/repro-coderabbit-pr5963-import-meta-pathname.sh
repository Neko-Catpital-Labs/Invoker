#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TEST_FILE="packages/app/src/__tests__/plan-to-invoker-skill.test.ts"
URL='file:///C:/repo/packages/app/src/__tests__/plan-to-invoker-skill.test.ts'

if grep -Fq 'new URL(import.meta.url).pathname' "$TEST_FILE"; then
  echo "[repro] FAIL: $TEST_FILE still uses URL.pathname for a file URL"
  node - <<'JS'
const { dirname, join } = require('node:path');
const { fileURLToPath } = require('node:url');
const url = 'file:///C:/repo/packages/app/src/__tests__/plan-to-invoker-skill.test.ts';
const buggy = join(dirname(new URL(url).pathname), '..', '..', '..', '..');
const fixed = join(dirname(fileURLToPath(url, { windows: true })), '..', '..', '..', '..');
console.error(`[repro] pathname result: ${buggy}`);
console.error(`[repro] fileURLToPath result: ${fixed}`);
JS
  exit 1
fi

if ! grep -Fq 'fileURLToPath(import.meta.url)' "$TEST_FILE"; then
  echo "[repro] FAIL: $TEST_FILE does not use fileURLToPath(import.meta.url)"
  exit 1
fi

echo "[repro] PASS: test uses fileURLToPath for import.meta.url"