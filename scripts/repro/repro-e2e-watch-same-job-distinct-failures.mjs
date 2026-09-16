#!/usr/bin/env node
// E2E repro of the 2026-08-21 CI regression-watch lifecycle bug.
//
// Production incident:
//   Job: required-fast / Mergify Admin Requeue
//   Run: https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/32534741079/job/96936670245
//   First repair (PR #9923) fixed an earlier same-job failure (ledger hermeticity).
//   A later failure in repro-babysit-pr-body-human-split stayed red and DO1 never
//   filed a new repair, because identity was job-name only and the repair-filing
//   claim permanently keyed (job, firstBadSha).
//
// This script inlines the *legacy* keying/claim rules (job-only activeFailures +
// permanent claim) and proves they collapse two distinct repro failures into one
// lifecycle that cannot re-file. It does not import the fixed watcher module, so
// it stays a pure proof of the original defect class.
import assert from 'node:assert/strict';

const JOB = 'required-fast / Mergify Admin Requeue';
const SHA = '22891618af26fc7e3e19227ccc56ed183c0e7e26';
const RUN_ID = 32534741079;
const JOB_ID = 96936670245;

const FIRST_REPRO = 'repro-mergify-admin-requeue';
const SECOND_REPRO = 'repro-babysit-pr-body-human-split';
const SECOND_LOG = [
  `Cloning into '/tmp/${SECOND_REPRO}.ERdycn/seed'...`,
  `rm: cannot remove '/tmp/${SECOND_REPRO}.ERdycn/seed/.git/objects': Directory not empty`,
  '##[error]Process completed with exit code 1.',
].join('\n');

function extractReproIds(logText) {
  const found = new Set();
  for (const match of String(logText).matchAll(/(?:scripts\/repro\/)?(repro-[a-z0-9][a-z0-9._-]*)(?:\.sh)?/gi)) {
    found.add(match[1].replace(/\.sh$/i, '').toLowerCase());
  }
  for (const match of String(logText).matchAll(/\/tmp\/(repro-[a-z0-9][a-z0-9._-]*)\.[A-Za-z0-9]+\b/gi)) {
    found.add(match[1].toLowerCase());
  }
  return [...found];
}

/** Legacy watcher: one activeFailures entry per job name, ignore test identity. */
function legacyReconcileBroken(state, { jobName, sha, reproId }) {
  const existing = state.activeFailures[jobName];
  if (existing) {
    state.activeFailures[jobName] = {
      ...existing,
      lastBadSha: sha,
      occurrences: Number(existing.occurrences ?? 1) + 1,
      lastReproHint: reproId,
    };
    return;
  }
  state.activeFailures[jobName] = {
    jobName,
    firstBadSha: sha,
    firstReproHint: reproId,
    lastReproHint: reproId,
    occurrences: 1,
    attempts: 0,
  };
}

/** Legacy claim: permanent (job, firstBadSha) — no attempt ordinal, no test id. */
function legacyClaimKey(failure) {
  return `ci-regression:${failure.jobName}::${failure.firstBadSha}`;
}

function legacyShouldFile(failure, claims) {
  const key = legacyClaimKey(failure);
  if (claims.has(key)) return false;
  claims.add(key);
  failure.attempts = Number(failure.attempts ?? 0) + 1;
  return true;
}

function main() {
  const idsFromLog = extractReproIds(SECOND_LOG);
  assert.ok(
    idsFromLog.includes(SECOND_REPRO),
    `production log shape must yield ${SECOND_REPRO}, got ${JSON.stringify(idsFromLog)}`,
  );

  const state = { activeFailures: {} };
  const claims = new Set();

  // Observation 1: first distinct repro under the job goes red.
  legacyReconcileBroken(state, { jobName: JOB, sha: SHA, reproId: FIRST_REPRO });
  assert.equal(Object.keys(state.activeFailures).length, 1);
  assert.equal(legacyShouldFile(state.activeFailures[JOB], claims), true, 'first repro must file');

  // Observation 2: same job, different repro (the babysit human-split cleanup race).
  legacyReconcileBroken(state, { jobName: JOB, sha: SHA, reproId: SECOND_REPRO });

  assert.equal(
    Object.keys(state.activeFailures).length,
    1,
    'REPRODUCED: legacy job-only key collapses two distinct repros into one activeFailure',
  );
  assert.equal(state.activeFailures[JOB].firstReproHint, FIRST_REPRO);
  assert.equal(state.activeFailures[JOB].lastReproHint, SECOND_REPRO);
  assert.equal(state.activeFailures[JOB].occurrences, 2);

  assert.equal(
    legacyShouldFile(state.activeFailures[JOB], claims),
    false,
    'REPRODUCED: permanent (job, firstBadSha) claim blocks a second filing for the new repro',
  );

  console.log(JSON.stringify({
    ok: true,
    reproduced: true,
    incident: {
      job: JOB,
      runId: RUN_ID,
      jobId: JOB_ID,
      firstRepro: FIRST_REPRO,
      secondRepro: SECOND_REPRO,
      headSha: SHA,
    },
    legacyActiveFailureCount: Object.keys(state.activeFailures).length,
    legacySecondFilingBlocked: true,
    message: 'Legacy job-only identity + permanent claim collapses distinct same-job failures and blocks re-file',
  }, null, 2));
}

main();
