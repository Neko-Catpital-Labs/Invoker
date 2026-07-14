#!/usr/bin/env bash
set -euo pipefail

# CodeRabbit PR #4458 (discussion r3576416549): yieldToPendingRendererInput
# accepted delayMs but scheduled its timer with a hardcoded 0ms delay.
#
# The repro extracts the preload helper from the checked-out source and measures
# await yieldToPendingRendererInput(120). Buggy code resolves on the next macrotask
# instead of honoring the requested delay, so the script exits non-zero.

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-pr4458-yield-delay.XXXXXX.log")"
trap 'rm -f "$LOG_FILE"' EXIT

echo "[repro] PR #4458: yieldToPendingRendererInput(delayMs) must honor the requested delay."

if REPO_ROOT="$REPO_ROOT" node --input-type=module >"$LOG_FILE" 2>&1 <<'NODE'
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const sourcePath = `${process.env.REPO_ROOT}/packages/app/src/preload.ts`;
const source = readFileSync(sourcePath, 'utf8');
const start = source.indexOf('function yieldToPendingRendererInput');
if (start < 0) {
  throw new Error('yieldToPendingRendererInput was not found in packages/app/src/preload.ts');
}

const openBrace = source.indexOf('{', start);
let depth = 0;
let end = -1;
for (let i = openBrace; i < source.length; i += 1) {
  const char = source[i];
  if (char === '{') depth += 1;
  if (char === '}') depth -= 1;
  if (depth === 0) {
    end = i;
    break;
  }
}
if (end < 0) {
  throw new Error('yieldToPendingRendererInput body was not parsed');
}

const functionSource = source
  .slice(start, end + 1)
  .replace(': Promise<void>', '');
const yieldToPendingRendererInput = eval(`${functionSource}; yieldToPendingRendererInput`);
globalThis.requestAnimationFrame = (callback) => callback();

const requestedDelayMs = 120;
const startedAt = performance.now();
await yieldToPendingRendererInput(requestedDelayMs);
const elapsedMs = performance.now() - startedAt;
console.log(`observed delay: ${elapsedMs.toFixed(1)}ms`);
if (elapsedMs < 80) {
  throw new Error(`delayMs was ignored: requested ${requestedDelayMs}ms but resolved after ${elapsedMs.toFixed(1)}ms`);
}
NODE
then
  echo "[repro] PASS: yieldToPendingRendererInput honored delayMs before yielding to animation frame."
  exit 0
else
  status=$?
  echo "[repro] FAIL: yieldToPendingRendererInput resolved before the requested delay."
  cat "$LOG_FILE"
  exit "$status"
fi
