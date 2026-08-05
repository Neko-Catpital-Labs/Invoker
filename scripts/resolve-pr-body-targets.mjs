#!/usr/bin/env node
// Resolves which PR(s) scripts/pr-body-rollout.mjs and validate-pr-body.mjs
// should actually evaluate.
//
// Mergify's merge queue re-runs pull_request_target workflows against a
// synthetic PR it opens itself (head ref mergify/merge-queue/<id>, author
// mergify[bot]). scripts/pr-body-rollout.mjs's selective-rollout gate keys
// off the reported author, so on that synthetic PR it always resolves to
// "not enforced" -- author mergify[bot] is never in PR_BODY_ENFORCED_AUTHORS
// -- even when the real PR underneath is by an enforced author and has a
// body that would fail validation. Confirmed live: PR Body validation
// failed on Neko-Catpital-Labs/Invoker#7534's own branch (missing required
// sections) but reported success on the synthetic queue PR (#7541, author
// mergify[bot]), and Mergify merged #7534 on that green check.
//
// Mergify embeds the real PR number(s) it is testing in a fenced yaml block
// in the synthetic PR's body, e.g. (from the real #7541 body):
//
//   ```yaml
//   ---
//   checking_base_sha: 8bfbe06f9ec6634bd7af985b1f7ab5b16aa863a4
//   previous_check_retries: []
//   previous_failed_batches: []
//   pull_requests:
//     - number: 7534
//       scopes: []
//   scopes: []
//   ...
//   ```
//
// resolveTargetPrNumbers extracts those numbers so the workflow can fetch
// and validate the real PR(s) instead of the synthetic wrapper.

import { shouldEnforcePrBody } from './pr-body-rollout.mjs';

const MERGE_QUEUE_HEAD_PREFIX = 'mergify/merge-queue/';
const MERGE_QUEUE_BOT_LOGINS = new Set(['mergify[bot]', 'mergify']);
const YAML_FENCE_PATTERN = /```ya?ml\r?\n([\s\S]*?)```/i;
// Mergify's own generated block: a flat "pull_requests:" list of
// "- number: <int>" entries. This is intentionally a narrow, dependency-free
// scan of that fixed shape, not a general yaml parser -- the queue PR body
// is otherwise untrusted, human-readable prose.
const PULL_REQUESTS_LIST_PATTERN = /^pull_requests:[ \t]*\r?\n((?:^[ \t]+\S.*\r?\n?)+)/m;
const NUMBER_ENTRY_PATTERN = /^[ \t]+-\s*number:\s*(\d+)\s*\r?$/gm;

// The reported author is the actual authenticated GitHub actor who opened
// the PR -- a regular contributor cannot make GitHub report it as
// mergify[bot]. The head ref, in contrast, is whatever branch name the PR's
// own author chose, so it is NOT trustworthy on its own: a PR author could
// name their branch "mergify/merge-queue/anything" and, if headRef alone
// were sufficient here, get resolveTargetPrNumbers() to parse THEIR OWN
// PR body for a forged pull_requests: block pointing at a different,
// already-compliant PR -- validating that PR's content instead of their
// own and getting a green check without ever satisfying it. Requiring the
// trusted bot author closes that: headRef is corroborating evidence, never
// sufficient by itself.
export function isMergeQueueRun({ author, headRef } = {}) {
  const normalizedAuthor = String(author ?? '').trim().toLowerCase();
  if (!MERGE_QUEUE_BOT_LOGINS.has(normalizedAuthor)) return false;
  const normalizedHeadRef = String(headRef ?? '').trim();
  return normalizedHeadRef.startsWith(MERGE_QUEUE_HEAD_PREFIX);
}

export function parseQueuedPrNumbers(body) {
  const fenceMatch = String(body ?? '').match(YAML_FENCE_PATTERN);
  if (!fenceMatch) return [];

  const listMatch = fenceMatch[1].match(PULL_REQUESTS_LIST_PATTERN);
  if (!listMatch) return [];

  const numbers = [];
  let match;
  NUMBER_ENTRY_PATTERN.lastIndex = 0;
  while ((match = NUMBER_ENTRY_PATTERN.exec(listMatch[1])) !== null) {
    const number = Number(match[1]);
    if (Number.isInteger(number) && number > 0 && !numbers.includes(number)) {
      numbers.push(number);
    }
  }
  return numbers;
}

// Fails closed: on a run that looks like a merge-queue run but whose body
// doesn't parse to any underlying PR number, this returns [] rather than
// falling back to the synthetic PR's own number. Callers must treat an
// empty result as "resolution failed" and hard-fail instead of silently
// validating (or skipping validation of) the wrong PR.
export function resolveTargetPrNumbers({ author, headRef, prNumber, body } = {}) {
  if (!isMergeQueueRun({ author, headRef })) {
    const number = Number(prNumber);
    return Number.isInteger(number) && number > 0 ? [number] : [];
  }
  return parseQueuedPrNumbers(body);
}

// A batch can bundle more than one PR (queue_rules.batch_size in
// .mergify.yml). Enforce if ANY resolved target's real author is enforced,
// so one enforced-author PR can't ride through validation-free behind a
// batchmate that isn't.
export function shouldEnforcePrBodyForTargets({ targets, enforceAll, enforcedAuthors }) {
  return targets.some(({ author }) => shouldEnforcePrBody({ author, enforceAll, enforcedAuthors }));
}
