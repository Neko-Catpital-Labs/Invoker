#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import {
  isMergeQueueRun,
  parseQueuedPrNumbers,
  resolveTargetPrNumbers,
  shouldEnforcePrBodyForTargets,
} from './resolve-pr-body-targets.mjs';

// Real body of https://github.com/Neko-Catpital-Labs/Invoker/pull/7541,
// the synthetic queue PR Mergify opened while testing #7534 -- captured
// live during the incident this resolver fixes.
const REAL_QUEUE_PR_BODY = `**🎉 This pull request has been checked successfully and will be merged soon. 🎉**

Branch **master** (8bfbe06) and [#7534](/Neko-Catpital-Labs/Invoker/pull/7534) are queued together for merge.

This pull request has been created by Mergify to check the mergeability of [#7534](/Neko-Catpital-Labs/Invoker/pull/7534).
You don't need to do anything. Mergify will close this pull request automatically when it is complete.

\`\`\`yaml
---
checking_base_sha: 8bfbe06f9ec6634bd7af985b1f7ab5b16aa863a4
previous_check_retries: []
previous_failed_batches: []
pull_requests:
  - number: 7534
    scopes: []
scopes: []
...

\`\`\`
`;

// --- isMergeQueueRun -------------------------------------------------------

assert.equal(isMergeQueueRun({ author: 'mergify[bot]', headRef: 'mergify/merge-queue/abc123' }), true);
assert.equal(isMergeQueueRun({ author: 'mergify[bot]', headRef: 'some-branch' }), false);
// A regular PR author fully controls their own branch name and PR body.
// Trusting headRef alone would let them name a branch
// "mergify/merge-queue/anything" and forge a pull_requests: block in their
// OWN PR body pointing at a different, already-compliant PR -- getting a
// green check by validating that PR's content instead of their own. The
// bot author can't be spoofed by a regular contributor, so it's required.
assert.equal(isMergeQueueRun({ author: 'EdbertChan', headRef: 'mergify/merge-queue/abc123' }), false);
assert.equal(isMergeQueueRun({ author: 'EdbertChan', headRef: 'stack/foo/bar' }), false);
assert.equal(isMergeQueueRun({}), false);

// --- parseQueuedPrNumbers ---------------------------------------------------

assert.deepEqual(parseQueuedPrNumbers(REAL_QUEUE_PR_BODY), [7534]);
assert.deepEqual(parseQueuedPrNumbers('no yaml block here'), []);
assert.deepEqual(parseQueuedPrNumbers(''), []);
assert.deepEqual(parseQueuedPrNumbers(undefined), []);

const batchedBody = `\`\`\`yaml
---
checking_base_sha: abc123
pull_requests:
  - number: 100
    scopes: []
  - number: 101
    scopes: []
scopes: []
...
\`\`\``;
assert.deepEqual(parseQueuedPrNumbers(batchedBody), [100, 101]);

const malformedBody = `\`\`\`yaml
---
pull_requests: not-a-list
...
\`\`\``;
assert.deepEqual(parseQueuedPrNumbers(malformedBody), []);

// GitHub normalizes PR bodies to CRLF line endings.
const crlfBody = [
  '```yaml',
  '---',
  'checking_base_sha: abc123',
  'pull_requests:',
  '  - number: 7534',
  '    scopes: []',
  'scopes: []',
  '...',
  '```',
].join('\r\n');
assert.deepEqual(parseQueuedPrNumbers(crlfBody), [7534]);

// --- resolveTargetPrNumbers -------------------------------------------------

// Ordinary PR run: resolves to itself, ignoring body content entirely.
assert.deepEqual(
  resolveTargetPrNumbers({ author: 'EdbertChan', headRef: 'stack/foo/bar', prNumber: 7534, body: 'anything' }),
  [7534],
);

// Merge-queue run: resolves through to the real underlying PR(s), not the
// synthetic wrapper's own number (7541).
assert.deepEqual(
  resolveTargetPrNumbers({
    author: 'mergify[bot]',
    headRef: 'mergify/merge-queue/0aaddf1196',
    prNumber: 7541,
    body: REAL_QUEUE_PR_BODY,
  }),
  [7534],
);

// Fails closed: a merge-queue run whose body doesn't parse resolves to []
// (the caller must hard-fail), never falls back to the synthetic PR number.
assert.deepEqual(
  resolveTargetPrNumbers({ author: 'mergify[bot]', headRef: 'mergify/merge-queue/xyz', prNumber: 7541, body: 'no yaml block' }),
  [],
);

// --- shouldEnforcePrBodyForTargets ------------------------------------------

assert.equal(
  shouldEnforcePrBodyForTargets({
    targets: [{ author: 'EdbertChan' }],
    enforceAll: 'false',
    enforcedAuthors: 'EdbertChan',
  }),
  true,
);

assert.equal(
  shouldEnforcePrBodyForTargets({
    targets: [{ author: 'mergify[bot]' }],
    enforceAll: 'false',
    enforcedAuthors: 'EdbertChan',
  }),
  false,
);

// This is the core regression this module exists to fix: the reported
// wrapper author (mergify[bot]) must never be what enforcement is decided
// on -- it must be decided on the real underlying PR's author. Author
// matching is also case-insensitive (matches shouldEnforcePrBody's own
// normalization), so a differently-cased enforcedAuthors config still works.
assert.equal(
  shouldEnforcePrBodyForTargets({
    targets: [{ author: 'EdbertChan' }], // resolved from #7534, not mergify[bot]
    enforceAll: 'false',
    enforcedAuthors: 'edbertchan',
  }),
  true,
  'enforcement must follow the resolved underlying author, not the queue wrapper author',
);

// Batch: enforce if ANY resolved target's author is enforced, so an
// enforced-author PR can't ride through unvalidated behind a batchmate.
assert.equal(
  shouldEnforcePrBodyForTargets({
    targets: [{ author: 'octocat' }, { author: 'EdbertChan' }],
    enforceAll: 'false',
    enforcedAuthors: 'EdbertChan',
  }),
  true,
);

assert.equal(
  shouldEnforcePrBodyForTargets({
    targets: [{ author: 'octocat' }, { author: 'someone-else' }],
    enforceAll: 'false',
    enforcedAuthors: 'EdbertChan',
  }),
  false,
);

console.log('OK: PR body target resolution checks passed');
