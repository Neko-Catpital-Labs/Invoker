#!/usr/bin/env node

import assert from 'node:assert/strict';
import { migrateJson } from './migrate-default-execution-harness.mjs';

const legacy = JSON.stringify({ defaultExecutionAgent: 'codex', defaultExecutionModel: 'gpt-5.6-luna' });
assert.throws(
  () => migrateJson(legacy, 'fixture', { consumerSupportsHarness: false }),
  /installed consumer capability was not proven/,
);
assert.deepEqual(
  JSON.parse(migrateJson(legacy, 'fixture', { consumerSupportsHarness: true })),
  { defaultExecutionModel: 'gpt-5.6-luna', defaultExecutionHarness: 'codex' },
);
console.log('PASS: migration refuses legacy-key deletion without consumer capability proof');
console.log('PASS: migration renames legacy key after consumer capability proof');
