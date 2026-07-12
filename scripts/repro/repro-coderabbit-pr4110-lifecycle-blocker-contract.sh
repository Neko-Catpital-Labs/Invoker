#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "checking LifecycleHost.getExternalDependencyBlocker contract"

node --input-type=module - "$ROOT_DIR" <<'NODE'
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
const lifecycle = readFileSync(join(root, 'packages/workflow-core/src/orchestrator/lifecycle.ts'), 'utf8');
const orchestrator = readFileSync(join(root, 'packages/workflow-core/src/orchestrator.ts'), 'utf8');

const lifecycleMatch = lifecycle.match(/getExternalDependencyBlocker\s*\(\s*task\s*:\s*TaskState\s*\)\s*:\s*([^;]+);/);
const orchestratorMatch = orchestrator.match(/getExternalDependencyBlocker\s*\(\s*task\s*:\s*TaskState\s*\)\s*:\s*([^ {]+\s*\|\s*undefined)\s*\{/);

if (!lifecycleMatch) {
  console.error('FAIL: LifecycleHost.getExternalDependencyBlocker declaration was not found.');
  process.exit(1);
}
if (!orchestratorMatch) {
  console.error('FAIL: Orchestrator.getExternalDependencyBlocker implementation signature was not found.');
  process.exit(1);
}

const lifecycleReturn = lifecycleMatch[1].replace(/\s+/g, ' ').trim();
const orchestratorReturn = orchestratorMatch[1].replace(/\s+/g, ' ').trim();

if (lifecycleReturn !== orchestratorReturn) {
  console.error(`FAIL: LifecycleHost returns ${lifecycleReturn}, but Orchestrator returns ${orchestratorReturn}.`);
  process.exit(1);
}
if (lifecycleReturn !== 'string | undefined') {
  console.error(`FAIL: blocker contract must be string | undefined, got ${lifecycleReturn}.`);
  process.exit(1);
}
if (/\bExternalDependency\b/.test(lifecycle)) {
  console.error('FAIL: lifecycle.ts still imports or references ExternalDependency for the blocker contract.');
  process.exit(1);
}

console.log('PASS: LifecycleHost.getExternalDependencyBlocker matches the string blocker contract.');
NODE
