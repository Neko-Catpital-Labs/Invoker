#!/usr/bin/env node
// Reproduces the CI "Verify Playwright shard inventory" step locally so the
// playwright / N-of-9 shard regression cannot recur silently. It asserts that
// every CI-owned packages/app/e2e spec is assigned to exactly one Playwright
// shard: no spec missing from the matrix, no spec listed that does not exist,
// and no spec assigned to more than one shard.
//
// The playwright / 8-of-9 shard first went red at
// d19a0f4af741226c3edb9509e2768529bf97fef9 because two specs
// (e2e/planning-terminal-live-model.proof.spec.ts and e2e/ui-delta-timeline.spec.ts)
// were listed in a second shard while already owned by 6-of-9 and 3-of-9.
// Duplicate assignment makes a shard run the same spec twice and fail.
//
// Usage:
//   node scripts/repro/repro-ci-playwright-shard-inventory.mjs [workflow.yml] [e2eDir]
// Exit 0 when the inventory is consistent, 1 when drift is detected.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import YAML from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflowPath = resolve(repoRoot, process.argv[2] ?? '.github/workflows/ci.yml');
const e2eDir = resolve(repoRoot, process.argv[3] ?? 'packages/app/e2e');

const MANUAL_ONLY_SPECS = new Set([
  // This spec intentionally drives the real `claude` binary and depends on
  // live auth/UI state, so it stays opt-in instead of becoming a CI shard.
  'planning-terminal-chat-tmux-toggle-real-claude-repro.spec.ts',
]);

function shardFiles(job) {
  if (!job?.strategy?.matrix?.include) return [];
  return job.strategy.matrix.include.flatMap((shard) =>
    String(shard.files ?? '').trim().split(/\s+/).filter(Boolean),
  );
}

function main() {
  const workflow = YAML.parse(readFileSync(workflowPath, 'utf8'));
  const listed = [
    ...shardFiles(workflow.jobs?.playwright),
    ...shardFiles(workflow.jobs?.['playwright-nightly-perf']),
  ];
  const discovered = readdirSync(e2eDir)
    .filter((file) => file.endsWith('.spec.ts'))
    .filter((file) => !MANUAL_ONLY_SPECS.has(file))
    .map((file) => `e2e/${file}`)
    .sort();

  const listedSet = new Set(listed);
  const discoveredSet = new Set(discovered);
  const missing = discovered.filter((file) => !listedSet.has(file));
  const extra = listed.filter((file) => !discoveredSet.has(file));
  const duplicates = [...new Set(listed.filter((file, index) => listed.indexOf(file) !== index))];

  if (missing.length || extra.length || duplicates.length) {
    console.error('[repro-ci-playwright-shard-inventory] Playwright shard inventory drift detected.');
    if (missing.length) console.error(`  Missing from shards: ${missing.join(', ')}`);
    if (extra.length) console.error(`  Extra in shards: ${extra.join(', ')}`);
    if (duplicates.length) console.error(`  Duplicate shard entries: ${duplicates.join(', ')}`);
    process.exit(1);
  }

  console.log(
    `[repro-ci-playwright-shard-inventory] OK: ${discovered.length} CI-owned spec files each assigned to exactly one shard.`,
  );
}

main();
