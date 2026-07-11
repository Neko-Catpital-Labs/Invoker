#!/usr/bin/env node
// Repro: the workflow-resume worker must treat `failed` (and `closed` / `stale`)
// as terminal, so a workflow whose only unfinished work is a failed task is left
// alone instead of being re-submitted for retry on every 60s poll.
//
// This drives the SAME predicate the worker uses (`isWorkflowIncomplete` in
// packages/execution-engine/src/workers/workflow-resume-worker.ts: a workflow is
// resumed when ANY task status is NOT in TERMINAL_TASK_STATUSES). It reads the
// real TERMINAL_TASK_STATUSES set straight out of the source, so it FAILS on
// unfixed code (reproducing the bug) and PASSES once the fix lands. Real unit
// coverage lives in the worker's __tests__/workflow-resume-worker.test.ts.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// Defaults to the shipped worker source; accepts an explicit path so the same
// guard can be pointed at an older revision to confirm it reproduces the bug.
const workerSrc = process.argv[2]
  ? resolve(process.argv[2])
  : join(here, '..', '..', 'packages', 'execution-engine', 'src', 'workers', 'workflow-resume-worker.ts');

const src = readFileSync(workerSrc, 'utf8');
const setLiteral = src.match(/TERMINAL_TASK_STATUSES[\s\S]*?new Set<[^>]*>\(\[([\s\S]*?)\]\)/);
if (!setLiteral) {
  console.error('FAIL: could not locate the TERMINAL_TASK_STATUSES set in the worker source.');
  process.exit(1);
}
// The terminal set the worker actually ships with today (only the `'x' as TaskState`
// entries, not the `TaskState['status']` type annotations).
const SOURCE_TERMINAL = new Set(
  [...setLiteral[1].matchAll(/'([a-z_]+)'\s+as\s+TaskState/g)].map((x) => x[1]),
);
// The terminal set BEFORE the fix, kept as the baseline the bug is measured against.
const OLD_TERMINAL = new Set(['completed', 'review_ready']);

// workflowId -> its task statuses
const FIXTURES = {
  'wf-failed-only': ['failed'],
  'wf-closed-only': ['closed'],
  'wf-stale-only': ['stale'],
  'wf-completed+failed': ['completed', 'failed'],
  'wf-failed+pending': ['failed', 'pending'],
  'wf-running': ['running'],
  'wf-done': ['completed', 'review_ready'],
};

const isIncomplete = (terminal, statuses) => statuses.some((s) => !terminal.has(s));
const resumedUnder = (terminal) =>
  Object.entries(FIXTURES)
    .filter(([, statuses]) => isIncomplete(terminal, statuses))
    .map(([id]) => id);

const oldResumed = resumedUnder(OLD_TERMINAL);
const sourceResumed = resumedUnder(SOURCE_TERMINAL);

console.log('old_terminal_set     =', [...OLD_TERMINAL].join(', '));
console.log('source_terminal_set  =', [...SOURCE_TERMINAL].join(', '));
console.log('resumed_under_old    =', oldResumed.join(' '));
console.log('resumed_under_source =', sourceResumed.join(' '));

const failures = [];
const expect = (cond, msg) => {
  if (!cond) failures.push(msg);
};

// Bug baseline: under the OLD set a failed-only workflow is resumed every poll.
expect(
  oldResumed.includes('wf-failed-only'),
  'expected OLD behavior to resume a failed-only workflow (the bug being reproduced)',
);

// Fix must be present in the source terminal set.
for (const status of ['completed', 'review_ready', 'failed', 'closed', 'stale']) {
  expect(SOURCE_TERMINAL.has(status), `expected source TERMINAL_TASK_STATUSES to include '${status}'`);
}

// Fixed behavior: dead-end workflows are left alone.
for (const id of ['wf-failed-only', 'wf-closed-only', 'wf-stale-only', 'wf-completed+failed']) {
  expect(!sourceResumed.includes(id), `expected the shipped worker to SKIP ${id}`);
}

// Targeting preserved: workflows with genuinely actionable work still resume.
for (const id of ['wf-failed+pending', 'wf-running']) {
  expect(sourceResumed.includes(id), `expected the shipped worker to STILL resume ${id}`);
}

// Sanity: an already-done workflow is never resumed under either policy.
expect(
  !oldResumed.includes('wf-done') && !sourceResumed.includes('wf-done'),
  'a completed/review_ready workflow must never be resumed',
);

if (failures.length > 0) {
  console.error('\nFAIL (bug present or fix incomplete):');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('\nPASS: failed/closed/stale workflows are no longer resumed; actionable work still is.');
