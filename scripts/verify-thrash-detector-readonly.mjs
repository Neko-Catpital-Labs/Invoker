#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const workerPath = resolve(repoRoot, 'packages/execution-engine/src/workers/thrash-detector-worker.ts');
const source = readFileSync(workerPath, 'utf8');

const forbidden = [
  'invoker:fix-with-agent',
  'invoker:approve',
  'invoker:reject',
  'recreate-task',
  'recreateTask',
  'approveTask',
  'rejectTask',
  'submitter.',
  '.submit(',
];

const hits = forbidden.filter((needle) => source.includes(needle));
if (hits.length > 0) {
  console.error(`thrash-detector read-only check failed: ${hits.join(', ')}`);
  process.exit(1);
}

console.log('thrash-detector read-only check passed');
