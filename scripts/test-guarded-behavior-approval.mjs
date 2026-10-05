#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { analyzeGuardedBehaviorApproval } from './guarded-behavior-approval.mjs';

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OLD_HEAD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const GUARDED_DIFF = `diff --git a/packages/ui/src/App.tsx b/packages/ui/src/App.tsx
--- a/packages/ui/src/App.tsx
+++ b/packages/ui/src/App.tsx
@@ -1,2 +1,2 @@
 // guarded-behavior: selection-camera-inert
-const selectionMovesCamera = false;
+const selectionMovesCamera = true;
`;

function review({ login = 'human-reviewer', type = 'User', state = 'APPROVED', commitId = HEAD, id = 1 }) {
  return {
    id,
    state,
    commit_id: commitId,
    submitted_at: `2026-08-28T00:00:${String(id).padStart(2, '0')}Z`,
    user: { login, type },
  };
}

function analyze(reviews, diffText = GUARDED_DIFF) {
  return analyzeGuardedBehaviorApproval({ diffText, headSha: HEAD, reviews });
}

function assertAppearsBefore(source, before, after, message) {
  const beforeIndex = source.indexOf(before);
  const afterIndex = source.indexOf(after);

  assert.notEqual(beforeIndex, -1, `${message}: missing ${before}`);
  assert.notEqual(afterIndex, -1, `${message}: missing ${after}`);
  assert.ok(beforeIndex < afterIndex, message);
}

assert.deepEqual(analyze([], 'diff --git a/README.md b/README.md\n+ordinary\n'), {
  eligible: true,
  guarded: false,
  markers: [],
  reason: 'unguarded-diff',
});

assert.equal(analyze([]).eligible, false, 'guarded diff without reviews must be denied');
assert.equal(analyze([review({ login: 'review-bot[bot]', type: 'Bot' })]).eligible, false, 'bot approval must be denied');
assert.equal(analyze([review({ commitId: OLD_HEAD })]).eligible, false, 'stale-head approval must be denied');
assert.equal(analyze([review({ state: 'DISMISSED' })]).eligible, false, 'dismissed approval must be denied');
assert.equal(analyze([
  review({ state: 'APPROVED', id: 1 }),
  review({ state: 'CHANGES_REQUESTED', id: 2 }),
]).eligible, false, 'a later changes-requested review must deny');

assert.deepEqual(analyze([review({ state: 'APPROVED' })]), {
  eligible: true,
  guarded: true,
  markers: [{ id: 'selection-camera-inert', path: 'packages/ui/src/App.tsx', line: 1 }],
  reason: 'current-head-human-approval',
  approvingReviewers: ['human-reviewer'],
});

const landStackSource = readFileSync(new URL('./land-stack.mjs', import.meta.url), 'utf8');
const cronSource = readFileSync(new URL('./cron-pr-auto-label.sh', import.meta.url), 'utf8');
assertAppearsBefore(
  landStackSource,
  'checkGuardedBehaviorApprovalForPr',
  "labels[]=admin-bypass",
  'land-stack must check guarded approval before its direct label add',
);
assertAppearsBefore(
  cronSource,
  'guarded_bypass_is_eligible "$num"',
  '--add-label admin-bypass',
  'cron must check guarded approval before generating its label task',
);
const bumpSource = readFileSync(new URL('./open-daily-release-bump-pr.sh', import.meta.url), 'utf8');
assertAppearsBefore(
  bumpSource,
  'guarded-behavior-approval.mjs',
  '--add-label admin-bypass',
  'daily release bump must check guarded approval before labeling admin-bypass',
);

const directLabelFiles = execFileSync('rg', [
  '-l',
  'labels\\[\\]=admin-bypass|--add-label admin-bypass',
  'scripts',
], { encoding: 'utf8' })
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .filter(path => !/\/(?:test[-_]|fixtures\/)/.test(path))
  .sort();
assert.deepEqual(directLabelFiles, [
  'scripts/cron-pr-auto-label.sh',
  'scripts/land-stack.mjs',
  'scripts/open-daily-release-bump-pr.sh',
]);

console.log('guarded-behavior approval policy tests passed');
