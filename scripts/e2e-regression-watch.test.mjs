import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildCiJobDefinitions,
  buildFailureKey,
  buildMarker,
  buildRepairFilingMetadata,
  claimNeedsHumanRepairFiling,
  claimRepairFiling,
  CATSTACK_REPO_URL,
  DEFAULT_TARGET_REPO,
  extractFailureIdentitiesFromLog,
  failureStorageKey,
  fileBugfixPlan,
  isCiRegressionReflectEnabled,
  getActionableFailures,
  groupFailuresBySha,
  isAutoFixCircuitBreakerPaused,
  isObservationStale,
  JOB_LEVEL_FAILURE_ID,
  jobNameIsMapped,
  loadEmptyState,
  liveQueryHasNonTerminalWork,
  loadWatchConfigFile,
  needsHumanRepairFilingKind,
  normalizeState,
  parseTargetRepoFlag,
  parseWatchConfigFlag,
  processFailureFilingSweep,
  reconcileCiRun,
  releaseRepairFilingClaim,
  repairFilingKind,
  resolveRepairFilingSubject,
  resolveStateDir,
  resolveTargetRepo,
  RECOVERY_COOLDOWN_MS,
  shouldSkipFilingAlreadyAddressed,
  STALE_OBSERVATION_MS,
} from './e2e-regression-watch.mjs';

function makeFailure(overrides = {}) {
  const jobName = overrides.jobName ?? 'playwright / launch-dispatch-stuck-lease';
  const failureId = overrides.failureId ?? JOB_LEVEL_FAILURE_ID;
  const failureKey = overrides.failureKey ?? buildFailureKey(jobName, failureId);
  return {
    jobName,
    failureId,
    failureKey,
    firstBadSha: 'a5d6b3e626ace9e963e924c0de9410dc0302de9a',
    firstBadRunId: 100,
    firstBadRunCreatedAt: '2026-08-18T00:00:00Z',
    firstJobDatabaseId: 200,
    firstJobUrl: 'https://example.test/job/200',
    lastBadSha: 'a5d6b3e626ace9e963e924c0de9410dc0302de9a',
    lastBadRunId: 100,
    lastJobDatabaseId: 200,
    lastJobUrl: 'https://example.test/job/200',
    lastObservedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    occurrences: 1,
    attempts: 0,
    lastFiledAt: null,
    needsHuman: false,
    ...overrides,
    jobName: overrides.jobName ?? jobName,
    failureId: overrides.failureId ?? failureId,
    failureKey: overrides.failureKey ?? buildFailureKey(
      overrides.jobName ?? jobName,
      overrides.failureId ?? failureId,
    ),
  };
}

function stateWithFailure(failure = makeFailure()) {
  const state = loadEmptyState();
  state.activeFailures[failureStorageKey(failure)] = failure;
  return state;
}

function stateWithFailures(failures) {
  const state = loadEmptyState();
  for (const failure of failures) state.activeFailures[failureStorageKey(failure)] = failure;
  return state;
}

function jobDefinitionsFor(jobNames) {
  return new Map(jobNames.map((jobName, index) => [
    jobName,
    { verifyCommand: `bash scripts/verify-${index + 1}.sh` },
  ]));
}

describe('liveQueryHasNonTerminalWork', () => {
  it('detects non-terminal work from a matching marker in valid JSON', () => {
    const queryFn = () => JSON.stringify([
      { status: 'running', description: `filed via ${buildMarker('abc1234', 'build')}` },
    ]);
    assert.equal(
      liveQueryHasNonTerminalWork({ firstBadSha: 'abc1234', jobName: 'build' }, undefined, queryFn),
      true,
    );
  });

  it('returns false when no live workflow matches the marker', () => {
    const queryFn = () => JSON.stringify([
      { status: 'completed', description: `filed via ${buildMarker('abc1234', 'build')}` },
    ]);
    assert.equal(
      liveQueryHasNonTerminalWork({ firstBadSha: 'abc1234', jobName: 'build' }, undefined, queryFn),
      false,
    );
  });

  it('fails closed (assumes work exists) instead of throwing on truncated query output', () => {
    // Reproduces the live incident: query workflows --output json truncated
    // mid-string when the standalone headless exit path didn't wait for a
    // large stdout write to flush before calling process.exit().
    const truncated = JSON.stringify([
      { status: 'running', description: 'a'.repeat(50_000) },
    ]).slice(0, 30_000);
    const queryFn = () => truncated;

    assert.doesNotThrow(() => {
      const result = liveQueryHasNonTerminalWork({ firstBadSha: 'abc1234', jobName: 'build' }, undefined, queryFn);
      assert.equal(result, true, 'must fail closed, not crash the sweep or risk a duplicate fix PR');
    });
  });

  it('fails closed on a query function that throws outright', () => {
    const queryFn = () => { throw new Error('headless_query timed out after 60s'); };
    assert.doesNotThrow(() => {
      const result = liveQueryHasNonTerminalWork({ firstBadSha: 'abc1234', jobName: 'build' }, undefined, queryFn);
      assert.equal(result, true);
    });
  });

  it('fails closed on valid JSON that parses to null instead of an array or {items}', () => {
    const queryFn = () => 'null';
    assert.doesNotThrow(() => {
      const result = liveQueryHasNonTerminalWork({ firstBadSha: 'abc1234', jobName: 'build' }, undefined, queryFn);
      assert.equal(result, true);
    });
  });
});

function makeFakeLedger() {
  const rows = new Map();
  return {
    rows,
    insert: ({ kind, subject, stateSha, metadata }) => {
      const key = `${kind} ${subject} ${stateSha}`;
      if (rows.has(key)) return { inserted: false, row: rows.get(key) };
      const row = { kind, subject, stateSha, metadata };
      rows.set(key, row);
      return { inserted: true, row };
    },
    release: ({ kind, subject, stateSha }) => {
      rows.delete(`${kind} ${subject} ${stateSha}`);
    },
  };
}

describe('repair_filings ledger gate (claimRepairFiling / releaseRepairFilingClaim)', () => {

  it('kind is namespaced per CI job, failure identity, and attempt ordinal', () => {
    assert.equal(
      repairFilingKind(makeFailure({ jobName: 'required-fast / Guardrails' })),
      'ci-regression:required-fast-guardrails:job:a1',
    );
    assert.equal(
      repairFilingKind(makeFailure({
        jobName: 'fleet / abc123d',
        markerJobName: 'fleet',
        failureId: 'job',
        attempts: 2,
      })),
      'ci-regression:fleet:job:a3',
    );
  });

  it('prevents a duplicate PR: a second claim for the identical (kind, subject, stateSha) is rejected', () => {
    const ledger = makeFakeLedger();
    const failure = makeFailure({ firstBadSha: 'shaA' });

    const firstAttemptSkips = claimRepairFiling(failure, ledger.insert);
    assert.equal(firstAttemptSkips, false, 'first claim must succeed (caller proceeds to file)');
    assert.equal(ledger.rows.size, 1);

    // A second, independent caller (e.g. a fresh sweep, or a different
    // process) tries to claim the exact same key.
    const secondAttemptSkips = claimRepairFiling(failure, ledger.insert);
    assert.equal(secondAttemptSkips, true, 'second claim for the identical key must be rejected');
    assert.equal(ledger.rows.size, 1, 'exactly one row must exist for this key, not two');
  });

  it('worked example: different kind or different stateSha both claim as new work; same kind+sha collapses to one', () => {
    const ledger = makeFakeLedger();
    const rebaseAtShaA = makeFailure({ jobName: 'admin-requeue / rebase-conflict', firstBadSha: 'shaA' });
    const uiVitestAtShaB = makeFailure({ jobName: 'admin-requeue / check-ui-vitest', firstBadSha: 'shaB' });
    const rebaseAtShaBAgain = makeFailure({ jobName: 'admin-requeue / rebase-conflict', firstBadSha: 'shaB' });

    assert.equal(claimRepairFiling(rebaseAtShaA, ledger.insert), false);
    assert.equal(claimRepairFiling(uiVitestAtShaB, ledger.insert), false);
    assert.equal(claimRepairFiling(rebaseAtShaBAgain, ledger.insert), false, 'different sha for the same kind must not be suppressed as a duplicate');
    // Re-detecting the same problem on the same state must collapse to one row.
    assert.equal(claimRepairFiling(rebaseAtShaBAgain, ledger.insert), true);
    assert.equal(ledger.rows.size, 3);
  });

  it('releasing a claim after a failed filing lets a later sweep reclaim the identical key', () => {
    const ledger = makeFakeLedger();
    const failure = makeFailure({ firstBadSha: 'shaA' });

    assert.equal(claimRepairFiling(failure, ledger.insert), false);
    assert.equal(ledger.rows.size, 1);

    // fileFailure threw downstream -- release the claim.
    releaseRepairFilingClaim(failure, ledger.release);
    assert.equal(ledger.rows.size, 0);

    // A later attempt for the identical key must succeed now.
    assert.equal(claimRepairFiling(failure, ledger.insert), false);
    assert.equal(ledger.rows.size, 1);
  });

  it('fails closed (treats as already claimed) when the ledger call throws', () => {
    const failure = makeFailure({ firstBadSha: 'shaA' });
    const throwingInsert = () => { throw new Error('headless_mutation timed out'); };
    assert.equal(claimRepairFiling(failure, throwingInsert), true);
  });

  it('processFailureFilingSweep counts an unreachable ledger as an infra error, not an already-addressed conflict', () => {
    const failure = makeFailure({ firstBadSha: 'shaA' });
    const state = stateWithFailure(failure);
    const throwingInsert = () => { throw new Error('ECONNREFUSED'); };

    const counts = processFailureFilingSweep(state, {
      now: new Date('2026-08-21T12:00:01Z'),
      liveQuery: (candidate, options, outcome) => shouldSkipFilingAlreadyAddressed(candidate, {
        hasLiveWork: () => false,
        claim: (inner, _insert, innerOutcome) => claimRepairFiling(inner, throwingInsert, innerOutcome),
      }, outcome),
      fileFailure: () => {},
      isPaused: () => false,
    });

    assert.equal(counts.groupsSkippedInfraError, 1);
    assert.equal(counts.groupsSkippedAlreadyAddressed, 0);
  });

  it('processFailureFilingSweep counts a genuine already-claimed ledger response as already-addressed, not an infra error', () => {
    const failure = makeFailure({ firstBadSha: 'shaA' });
    const state = stateWithFailure(failure);
    const alreadyClaimedInsert = () => ({ inserted: false, row: {} });

    const counts = processFailureFilingSweep(state, {
      now: new Date('2026-08-21T12:00:01Z'),
      liveQuery: (candidate, options, outcome) => shouldSkipFilingAlreadyAddressed(candidate, {
        hasLiveWork: () => false,
        claim: (inner, _insert, innerOutcome) => claimRepairFiling(inner, alreadyClaimedInsert, innerOutcome),
      }, outcome),
      fileFailure: () => {},
      isPaused: () => false,
    });

    assert.equal(counts.groupsSkippedAlreadyAddressed, 1);
    assert.equal(counts.groupsSkippedInfraError, 0);
  });

  it('puts the fleet member list in metadata, not the key', () => {
    const failure = makeFailure({
      jobName: 'fleet / abc123d',
      markerJobName: 'fleet',
      memberJobNames: ['required-fast / Vitest Workspace', 'quality / Dependency Cruise', 'docker / comprehensive'],
    });
    const metadata = buildRepairFilingMetadata(failure);
    assert.deepEqual(metadata.memberJobNames, failure.memberJobNames);
    assert.equal(repairFilingKind(failure), 'ci-regression:fleet:job:a1');
  });

  it('processFailureFilingSweep end-to-end: a second sweep for the same (kind, subject, stateSha) never calls fileFailure again', () => {
    const ledger = makeFakeLedger();
    const state = stateWithFailure(makeFailure({ firstBadSha: 'shaA' }));
    let filedCount = 0;

    processFailureFilingSweep(state, {
      now: new Date('2026-08-12T01:00:00Z'),
      liveQuery: (failure) => claimRepairFiling(failure, ledger.insert),
      releaseFiling: (failure) => releaseRepairFilingClaim(failure, ledger.release),
      fileFailure: () => { filedCount += 1; },
      isPaused: () => false,
    });
    assert.equal(filedCount, 1);

    // Simulate a second, independent sweep run (fresh local state entry for
    // the same underlying failure, same ledger backing store) racing to file
    // the identical (kind, subject, stateSha).
    const secondSweepState = stateWithFailure(makeFailure({ firstBadSha: 'shaA' }));
    processFailureFilingSweep(secondSweepState, {
      now: new Date('2026-08-12T01:00:01Z'),
      liveQuery: (failure) => claimRepairFiling(failure, ledger.insert),
      releaseFiling: (failure) => releaseRepairFilingClaim(failure, ledger.release),
      fileFailure: () => { filedCount += 1; },
      isPaused: () => false,
    });

    assert.equal(filedCount, 1, 'the second sweep must not file a duplicate for the identical key');
    assert.equal(ledger.rows.size, 1);
  });
});

describe('needs-human repair-filings claim (claimNeedsHumanRepairFiling)', () => {
  it('kind is namespaced per CI job and failure identity, with no attempt ordinal (needs-human is terminal per sha)', () => {
    assert.equal(
      needsHumanRepairFilingKind(makeFailure({ jobName: 'required-fast / Guardrails' })),
      'ci-regression-needs-human:required-fast-guardrails:job',
    );
    assert.equal(
      needsHumanRepairFilingKind(makeFailure({
        jobName: 'fleet / abc123d',
        markerJobName: 'fleet',
        failureId: 'job',
        attempts: 5,
      })),
      'ci-regression-needs-human:fleet:job',
    );
  });

  it('claims the key once; a second claim for the identical (kind, subject, stateSha) is rejected', () => {
    const ledger = makeFakeLedger();
    const failure = makeFailure({ firstBadSha: 'shaA' });

    assert.equal(claimNeedsHumanRepairFiling(failure, ledger.insert), true, 'first claim must succeed');
    assert.equal(ledger.rows.size, 1);

    assert.equal(claimNeedsHumanRepairFiling(failure, ledger.insert), false, 'second claim for the identical key must be rejected');
    assert.equal(ledger.rows.size, 1, 'exactly one row must exist for this key, not two');
  });

  it('fails closed to false (no crash) when the ledger call throws', () => {
    const failure = makeFailure({ firstBadSha: 'shaA' });
    const throwingInsert = () => { throw new Error('headless_mutation timed out'); };
    assert.equal(claimNeedsHumanRepairFiling(failure, throwingInsert), false);
  });

  it('processFailureFilingSweep end-to-end: reaching the attempt cap claims the needs-human key exactly once across repeated sweeps', () => {
    const ledger = makeFakeLedger();
    const state = stateWithFailure(makeFailure({ attempts: 3, firstBadSha: 'shaA' }));
    let claims = 0;

    const sweepOnce = (sweepState) => processFailureFilingSweep(sweepState, {
      now: new Date('2026-08-12T01:00:00Z'),
      maxAttempts: 3,
      liveQuery: () => false,
      fileFailure: () => {},
      onNeedsHuman: (failure) => {
        if (claimNeedsHumanRepairFiling(failure, ledger.insert)) claims += 1;
      },
    });

    sweepOnce(state);
    assert.equal(claims, 1);
    assert.equal(ledger.rows.size, 1);

    // A second sweep still under the same cap (same firstBadSha, still
    // needsHuman) must not claim a duplicate key.
    sweepOnce(state);
    assert.equal(claims, 1, 'a repeat sweep for the identical (kind, subject, stateSha) must not re-claim');
    assert.equal(ledger.rows.size, 1);
  });
});

describe('fleet SHA correlation', () => {
  it('groups active failures by first bad SHA', () => {
    const sha = 'abc123def456abc123def456abc123def456ab1';
    const failures = [
      makeFailure({ jobName: 'required-fast / Vitest Workspace', firstBadSha: sha }),
      makeFailure({ jobName: 'quality / Dependency Cruise', firstBadSha: sha }),
      makeFailure({ jobName: 'docker / comprehensive', firstBadSha: 'def456def456def456def456def456def456def4' }),
    ];

    const groups = groupFailuresBySha(failures);
    assert.equal(groups.get(sha).length, 2);
    assert.equal(groups.get('def456def456def456def456def456def456def4').length, 1);
  });

  it('files one consolidated plan for three same-SHA failures and names every member', () => {
    const sha = 'abc123def456abc123def456abc123def456ab1';
    const jobs = [
      'required-fast / Vitest Workspace',
      'quality / Dependency Cruise',
      'docker / comprehensive',
    ];
    const state = stateWithFailures(jobs.map((jobName, index) => makeFailure({
      jobName,
      firstBadSha: sha,
      firstBadRunId: 100 + index,
      firstJobDatabaseId: 200 + index,
      firstJobUrl: `https://example.test/job/${200 + index}`,
    })));
    const filed = [];
    const liveMarkers = [];

    const counts = processFailureFilingSweep(state, {
      jobDefinitions: jobDefinitionsFor(jobs),
      liveQuery: (failure) => {
        liveMarkers.push(buildMarker(failure.firstBadSha, failure.markerJobName ?? failure.jobName));
        return false;
      },
      fileFailure: (failure) => filed.push(failure),
    });

    assert.equal(filed.length, 1);
    assert.equal(filed[0].jobName, 'fleet / abc123d');
    assert.equal(filed[0].markerJobName, 'fleet');
    assert.ok(filed[0].verifyCommand.startsWith('bash scripts/verify-'));
    assert.equal(filed[0].description.includes('No local verify command is mapped'), false);
    for (const jobName of jobs) {
      assert.match(filed[0].description, new RegExp(jobName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal(state.activeFailures[jobName].memberOfFleetEvent, sha);
    }
    assert.deepEqual(liveMarkers, [buildMarker(sha, 'fleet')]);
    assert.equal(counts.groupsCorrelated, 1);
    assert.equal(counts.groupsFiled, 1);
    assert.equal(state.activeFailures['fleet / abc123d'].attempts, 1);
  });

  it('keeps two same-SHA failures on the per-job path', () => {
    const sha = 'abc123def456abc123def456abc123def456ab1';
    const jobs = [
      'required-fast / Vitest Workspace',
      'quality / Dependency Cruise',
    ];
    const state = stateWithFailures(jobs.map((jobName) => makeFailure({ jobName, firstBadSha: sha })));
    const filed = [];

    const counts = processFailureFilingSweep(state, {
      jobDefinitions: jobDefinitionsFor(jobs),
      liveQuery: () => false,
      fileFailure: (failure) => filed.push(failure.jobName),
    });

    assert.deepEqual(filed.sort(), [...jobs].sort());
    assert.equal(counts.groupsCorrelated, 0);
    assert.equal(counts.groupsFiled, 2);
    assert.equal(state.activeFailures[jobs[0]].memberOfFleetEvent, undefined);
  });

  it('applies marker dedup and attempt cap to the fleet key', () => {
    const sha = 'abc123def456abc123def456abc123def456ab1';
    const jobs = [
      'required-fast / Vitest Workspace',
      'quality / Dependency Cruise',
      'docker / comprehensive',
    ];
    const state = stateWithFailures(jobs.map((jobName) => makeFailure({ jobName, firstBadSha: sha })));
    const jobDefinitions = jobDefinitionsFor(jobs);
    let filed = 0;

    const dedupCounts = processFailureFilingSweep(state, {
      jobDefinitions,
      liveQuery: (failure) => buildMarker(failure.firstBadSha, failure.markerJobName ?? failure.jobName) === buildMarker(sha, 'fleet'),
      fileFailure: () => {
        filed += 1;
      },
    });

    assert.equal(filed, 0);
    assert.equal(dedupCounts.groupsSkippedAlreadyAddressed, 1);
    assert.equal(state.activeFailures[jobs[0]].memberOfFleetEvent, sha);

    const filedCounts = processFailureFilingSweep(state, {
      now: new Date('2026-08-12T01:00:00Z'),
      maxAttempts: 1,
      jobDefinitions,
      liveQuery: () => false,
      fileFailure: () => {
        filed += 1;
      },
    });
    assert.equal(filedCounts.groupsFiled, 1);
    assert.equal(state.activeFailures['fleet / abc123d'].attempts, 1);

    let liveQueryCalled = false;
    const liveQueried = [];
    const cappedCounts = processFailureFilingSweep(state, {
      now: new Date('2026-08-12T03:00:00Z'),
      maxAttempts: 1,
      jobDefinitions,
      liveQuery: (failure) => {
        liveQueryCalled = true;
        liveQueried.push(failure.jobName);
        return false;
      },
      fileFailure: () => {
        filed += 1;
      },
    });

    // Fleet key is exhausted in prepare (before liveQuery); members fall back
    // to the per-job path and are claimed/filed individually.
    assert.equal(liveQueried.includes('fleet / abc123d'), false);
    assert.equal(liveQueryCalled, true);
    assert.equal(cappedCounts.groupsNeedingHuman, 1);
    assert.equal(cappedCounts.groupsFiled, 3);
    assert.equal(filed, 4);
    assert.equal(state.activeFailures['fleet / abc123d'].needsHuman, true);
    for (const jobName of jobs) {
      assert.equal(state.activeFailures[jobName].memberOfFleetEvent, undefined);
      assert.equal(state.activeFailures[jobName].attempts, 1);
    }
  });

  it('files member jobs individually once a fleet key is already needsHuman', () => {
    const sha = 'abc123def456abc123def456abc123def456ab1';
    const jobs = [
      'required-fast / Vitest Workspace',
      'quality / Dependency Cruise',
      'docker / comprehensive',
    ];
    const state = stateWithFailures(jobs.map((jobName) => makeFailure({
      jobName,
      firstBadSha: sha,
      memberOfFleetEvent: sha,
    })));
    state.activeFailures['fleet / abc123d'] = makeFailure({
      jobName: 'fleet / abc123d',
      markerJobName: 'fleet',
      isFleetEvent: true,
      firstBadSha: sha,
      attempts: 3,
      needsHuman: true,
      lastFiledAt: '2026-08-12T00:00:00.000Z',
      memberJobNames: jobs,
    });
    const filed = [];

    const counts = processFailureFilingSweep(state, {
      now: new Date('2026-08-12T04:00:00Z'),
      maxAttempts: 3,
      jobDefinitions: jobDefinitionsFor(jobs),
      liveQuery: () => false,
      fileFailure: (failure) => filed.push(failure.jobName),
    });

    assert.equal(counts.groupsCorrelated, 0);
    assert.equal(counts.groupsNeedingHuman, 1);
    assert.deepEqual(filed.sort(), [...jobs].sort());
    assert.equal(counts.groupsFiled, 3);
    assert.equal(state.activeFailures['fleet / abc123d'].needsHuman, true);
  });

  it('buildFleetJobName-derived key is stable when fleet membership grows between sweeps', () => {
    // Regression test: the fleet key used to embed the member-job COUNT
    // ("fleet / abc123d (3 jobs)"), so a 4th co-failing job joining on the
    // same sha rotated the key mid-flight. The old entry's attempt/backoff
    // history was carried over by SHA lookup, but a caller keying its own
    // dedup off the *jobName string itself must see one stable identity
    // across the membership change, not a churn of keys.
    const sha = 'abc123def456abc123def456abc123def456ab1';
    const threeJobs = [
      'required-fast / Vitest Workspace',
      'quality / Dependency Cruise',
      'docker / comprehensive',
    ];
    const fourthJob = 'ssh / shard-30';
    const state = stateWithFailures(threeJobs.map((jobName) => makeFailure({ jobName, firstBadSha: sha })));

    const firstSweep = processFailureFilingSweep(state, {
      now: new Date('2026-08-12T01:00:00Z'),
      jobDefinitions: jobDefinitionsFor(threeJobs),
      liveQuery: () => false,
      fileFailure: () => {},
      isPaused: () => false,
    });
    assert.equal(firstSweep.groupsFiled, 1);
    const fleetKeysAfterFirst = Object.keys(state.activeFailures).filter((key) => key.startsWith('fleet /'));
    assert.deepEqual(fleetKeysAfterFirst, ['fleet / abc123d']);
    assert.equal(state.activeFailures['fleet / abc123d'].attempts, 1);
    assert.equal(state.activeFailures['fleet / abc123d'].memberJobNames.length, 3);

    // A 4th job on the same sha joins the fleet on the next sweep.
    state.activeFailures[fourthJob] = makeFailure({ jobName: fourthJob, firstBadSha: sha });

    const secondSweep = processFailureFilingSweep(state, {
      now: new Date('2026-08-12T01:05:00Z'), // well inside backoff -- must not re-file
      jobDefinitions: jobDefinitionsFor([...threeJobs, fourthJob]),
      liveQuery: () => false,
      fileFailure: () => {
        throw new Error('must not file again: still the same fleet key, still in backoff');
      },
      isPaused: () => false,
    });

    // Still exactly one fleet key -- membership growth did not fork a new
    // "fleet / abc123d (4 jobs)" entry that would have reset attempts to 0
    // and let a brand-new filing sneak past the attempt cap/backoff.
    const fleetKeysAfterSecond = Object.keys(state.activeFailures).filter((key) => key.startsWith('fleet /'));
    assert.deepEqual(fleetKeysAfterSecond, ['fleet / abc123d']);
    assert.equal(state.activeFailures['fleet / abc123d'].attempts, 1, 'attempts must carry over, not reset on membership growth');
    assert.equal(state.activeFailures['fleet / abc123d'].memberJobNames.length, 4);
    assert.equal(secondSweep.groupsInBackoff, 1);
  });

  it('keeps remaining members under an existing fleet key after the active count drops below threshold', () => {
    const sha = 'abc123def456abc123def456abc123def456ab1';
    const jobs = [
      'required-fast / Vitest Workspace',
      'quality / Dependency Cruise',
      'docker / comprehensive',
    ];
    const state = stateWithFailures(jobs.map((jobName) => makeFailure({ jobName, firstBadSha: sha })));
    const jobDefinitions = jobDefinitionsFor(jobs);

    processFailureFilingSweep(state, {
      now: new Date('2026-08-12T01:00:00Z'),
      jobDefinitions,
      liveQuery: () => false,
      fileFailure: () => {},
    });
    delete state.activeFailures['docker / comprehensive'];

    const filed = [];
    const liveMarkers = [];
    const counts = processFailureFilingSweep(state, {
      now: new Date('2026-08-12T02:00:00Z'),
      jobDefinitions,
      liveQuery: (failure) => {
        liveMarkers.push(buildMarker(failure.firstBadSha, failure.markerJobName ?? failure.jobName));
        return true;
      },
      fileFailure: (failure) => filed.push(failure.jobName),
    });

    assert.deepEqual(filed, []);
    assert.deepEqual(liveMarkers, [buildMarker(sha, 'fleet')]);
    assert.equal(counts.groupsCorrelated, 1);
    assert.equal(state.activeFailures['required-fast / Vitest Workspace'].memberOfFleetEvent, sha);
    assert.equal(state.activeFailures['quality / Dependency Cruise'].memberOfFleetEvent, sha);
  });

  it('backtests the 631a0d0 fleet wave to one consolidated filing instead of eleven', () => {
    const sha = '631a0d08c7072e9544813fc1b93fb616586ce441';
    const jobs = [
      'build-artifacts',
      'quality / Dependency Cruise',
      'quality / TypeScript Types',
      'quality / Required Package Builds',
      'required-fast / Vitest Workspace',
      'required-fast / Guardrails',
      'required-fast / PR Babysit Harness',
      'ssh / shard-30',
      'ssh / shard-31',
      'docker / comprehensive',
      'e2e-proof / shard 0',
    ];
    const failures = jobs.map((jobName, index) => makeFailure({
      jobName,
      firstBadSha: sha,
      firstBadRunId: 6310,
      firstJobDatabaseId: 63100 + index,
      firstJobUrl: `https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/6310/job/${63100 + index}`,
    }));
    const jobDefinitions = buildCiJobDefinitions();
    const historicalState = stateWithFailures(failures);
    const correlatedState = stateWithFailures(failures.map((failure) => ({ ...failure })));
    const historicalFilings = [];
    const fleetFilings = [];

    processFailureFilingSweep(historicalState, {
      fleetEventThreshold: 99,
      jobDefinitions,
      liveQuery: () => false,
      fileFailure: (failure) => historicalFilings.push(failure.jobName),
    });
    const counts = processFailureFilingSweep(correlatedState, {
      jobDefinitions,
      liveQuery: () => false,
      fileFailure: (failure) => fleetFilings.push(failure),
    });

    assert.equal(historicalFilings.length, 11);
    assert.equal(fleetFilings.length, 1);
    assert.equal(fleetFilings[0].jobName, 'fleet / 631a0d0');
    for (const jobName of jobs) assert.match(fleetFilings[0].description, new RegExp(jobName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(counts.groupsCorrelated, 1);
    assert.equal(counts.groupsFiled, 1);
  });

  it('reproduces the bug: an orphaned fleet key is left un-retired forever when its last unmapped member goes silent', () => {
    const sha1 = 'e73ee551a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7';
    const sha2 = 'f00df00d1122334455667788990011223344f00d';
    const jobA = 'quality / Dependency Cruise';
    const jobB = 'required-fast / Vitest Workspace';

    const state = stateWithFailures([
      makeFailure({
        jobName: jobA, firstBadSha: sha1, firstBadRunId: 100,
        firstJobDatabaseId: 200, firstJobUrl: 'https://example.test/job/200',
      }),
      makeFailure({
        jobName: jobB, firstBadSha: sha1, firstBadRunId: 101,
        firstJobDatabaseId: 201, firstJobUrl: 'https://example.test/job/201',
      }),
    ]);

    // Sweep 1: correlates jobA + jobB into one fleet entry under sha1. This
    // is the pre-existing fleet-level entry the bug later orphans.
    processFailureFilingSweep(state, {
      jobDefinitions: jobDefinitionsFor([jobA, jobB]),
      fleetEventThreshold: 2,
      now: new Date('2026-08-12T00:00:00Z'),
      liveQuery: () => false,
      fileFailure: () => {},
    });
    const fleetKey = Object.keys(state.activeFailures).find((key) => key.startsWith('fleet /'));
    assert.ok(fleetKey, 'expected a fleet entry to be synthesized');

    // jobB recovers. Its own individual activeFailures entry never had its
    // own lastFiledAt stamped (only the fleet-level object did, via
    // recordFailureFiled), so withinRecoveryCooldown reads false
    // immediately -- no artificial 24h time jump is needed to make
    // reconcileCiRun delete it outright.
    reconcileCiRun(state, makeRun({
      headSha: sha1, jobName: jobB, conclusion: 'success',
      databaseId: 102, jobDatabaseId: 202, createdAt: '2026-08-12T01:00:00Z',
    }));
    assert.equal(state.activeFailures[jobB], undefined);

    // jobB re-fails on a brand-new commit. This creates a fresh, standalone
    // activeFailures entry for jobB keyed to sha2 -- unrelated to the old
    // fleet entry still sitting under sha1.
    reconcileCiRun(state, makeRun({
      headSha: sha2, jobName: jobB, conclusion: 'failure',
      databaseId: 103, jobDatabaseId: 203, createdAt: '2026-08-12T02:00:00Z',
    }));

    // Sweep 2: jobA is now unmapped (simulating a rename/removal from CI).
    // The old fleet entry's group now contains only jobA, which can't
    // synthesize a valid fleet failure (no verify command) -- this is the
    // sweep where the bug fires.
    const filed = [];
    processFailureFilingSweep(state, {
      jobDefinitions: jobDefinitionsFor([jobB]),
      fleetEventThreshold: 2,
      now: new Date('2026-08-12T03:00:00Z'),
      liveQuery: () => false,
      fileFailure: (failure) => filed.push(failure),
    });

    assert.equal(state.activeFailures[fleetKey].retired, true);
    assert.equal(state.activeFailures[jobA].retired, true);
    assert.deepEqual(filed.map((failure) => failure.jobName), [jobB]);
    assert.equal(filed[0].firstBadSha, sha2);
  });
});

describe('attempt ledger filing gate', () => {
  it('does not file and marks needsHuman when the per-key attempt cap is reached', () => {
    const state = stateWithFailure(makeFailure({ attempts: 3 }));
    let filed = 0;
    let liveQueryCalled = false;

    const counts = processFailureFilingSweep(state, {
      now: new Date('2026-08-12T01:00:00Z'),
      maxAttempts: 3,
      liveQuery: () => {
        liveQueryCalled = true;
        return false;
      },
      fileFailure: () => {
        filed += 1;
      },
    });

    assert.equal(filed, 0);
    assert.equal(liveQueryCalled, false, 'cap should skip before live workflow dedup');
    assert.equal(counts.groupsNeedingHuman, 1);
    assert.equal(state.activeFailures['playwright / launch-dispatch-stuck-lease'].needsHuman, true);
  });

  it('does not file while the failure key is inside exponential backoff', () => {
    const state = stateWithFailure(makeFailure({
      attempts: 1,
      lastFiledAt: '2026-08-12T00:00:00.000Z',
    }));
    let filed = 0;

    const counts = processFailureFilingSweep(state, {
      now: new Date('2026-08-12T00:59:59Z'),
      maxAttempts: 3,
      liveQuery: () => false,
      fileFailure: () => {
        filed += 1;
      },
    });

    assert.equal(filed, 0);
    assert.equal(counts.groupsInBackoff, 1);
    assert.equal(state.activeFailures['playwright / launch-dispatch-stuck-lease'].attempts, 1);
  });

  it('files after backoff expires under the cap and increments attempts', () => {
    const state = stateWithFailure(makeFailure({
      attempts: 1,
      lastFiledAt: '2026-08-12T00:00:00.000Z',
    }));
    const filed = [];
    const now = new Date('2026-08-12T01:00:00Z');

    const counts = processFailureFilingSweep(state, {
      now,
      maxAttempts: 3,
      liveQuery: () => false,
      fileFailure: (failure) => {
        filed.push(failure.jobName);
      },
    });

    const failure = state.activeFailures['playwright / launch-dispatch-stuck-lease'];
    assert.deepEqual(filed, ['playwright / launch-dispatch-stuck-lease']);
    assert.equal(counts.groupsFiled, 1);
    assert.equal(failure.attempts, 2);
    assert.equal(failure.lastFiledAt, now.toISOString());
    assert.equal(failure.needsHuman, false);
  });

  it('migrates legacy active failures with default attempt-ledger fields', () => {
    const migrated = normalizeState({
      schemaVersion: 2,
      lastProcessedRunId: 123,
      heads: {},
      activeFailures: {
        build: {
          jobName: 'build',
          firstBadSha: 'abc1234',
          firstBadRunId: 456,
        },
      },
    });

    assert.equal(migrated.schemaVersion, 5);
    assert.equal(migrated.lastProcessedRunId, 123);
    assert.equal(migrated.activeFailures.build.attempts, 0);
    assert.equal(migrated.activeFailures.build.lastFiledAt, null);
    assert.equal(migrated.activeFailures.build.needsHuman, false);
    assert.equal(migrated.activeFailures.build.retired, false);
  });

  it('backtests the 2026-08-12 terminal-workflow loop to at most three filings', () => {
    const key = 'playwright / launch-dispatch-stuck-lease';
    const state = stateWithFailure(makeFailure({
      jobName: key,
      firstBadSha: 'a5d6b3e626ace9e963e924c0de9410dc0302de9a',
    }));
    const startMs = Date.parse('2026-08-12T00:00:00Z');
    let filed = 0;
    let humanSweeps = 0;
    const historicalFilingsWithoutLedger = 64;

    for (let sweep = 0; sweep < 64; sweep += 1) {
      const counts = processFailureFilingSweep(state, {
        now: new Date(startMs + (sweep * 15 * 60 * 1000)),
        maxAttempts: 3,
        liveQuery: () => false,
        fileFailure: () => {
          filed += 1;
        },
      });
      humanSweeps += counts.groupsNeedingHuman;
    }

    assert.equal(historicalFilingsWithoutLedger, 64);
    assert.equal(filed, 3);
    assert.equal(state.activeFailures[key].attempts, 3);
    assert.equal(state.activeFailures[key].needsHuman, true);
    assert.ok(humanSweeps > 0);
  });
});

describe('retired CI job filing gate', () => {
  it('skips an unmapped job, marks it retired, counts it, and never files', () => {
    const key = 'playwright / retired-example';
    const state = stateWithFailure(makeFailure({ jobName: key }));
    const jobDefinitions = new Map([
      ['playwright / 9-of-9', { verifyCommand: 'bash scripts/test-suites/optional/40-playwright-app.sh' }],
    ]);
    let filed = 0;
    let liveQueryCalled = false;
    const retired = [];

    const counts = processFailureFilingSweep(state, {
      jobDefinitions,
      liveQuery: () => {
        liveQueryCalled = true;
        return false;
      },
      fileFailure: () => {
        filed += 1;
      },
      onRetired: (failure) => {
        retired.push(failure.jobName);
      },
    });

    assert.equal(jobNameIsMapped(key, jobDefinitions), false);
    assert.equal(filed, 0);
    assert.equal(liveQueryCalled, false, 'retired gate should skip before live workflow dedup');
    assert.deepEqual(retired, [key]);
    assert.equal(counts.groupsRetired, 1);
    assert.equal(counts.groupsFiled, 0);
    assert.equal(state.activeFailures[key].retired, true);
    assert.equal(state.activeFailures[key].attempts, 0);
  });

  it('treats a live job without a verify command as unmapped', () => {
    const jobDefinitions = new Map([
      ['required-fast / Missing Command', { verifyCommand: '' }],
    ]);

    assert.equal(jobNameIsMapped('required-fast / Missing Command', jobDefinitions), false);
  });

  it('fileBugfixPlan throws before rendering for an unmapped job', () => {
    const failure = makeFailure({ jobName: 'playwright / retired-example' });
    const calls = [];

    assert.throws(
      () => fileBugfixPlan(failure, {
        repoUrl: 'git@github.com:Neko-Catpital-Labs/Invoker.git',
        jobDefinitions: new Map(),
        runCommand: (cmd, args) => calls.push([cmd, args]),
      }),
      /unmapped CI job/,
    );
    assert.deepEqual(calls, []);
  });

  it('isCiRegressionReflectEnabled is off unless INVOKER_CI_REGRESSION_REFLECT=1', () => {
    assert.equal(isCiRegressionReflectEnabled({}), false);
    assert.equal(isCiRegressionReflectEnabled({ INVOKER_CI_REGRESSION_REFLECT: '0' }), false);
    assert.equal(isCiRegressionReflectEnabled({ INVOKER_CI_REGRESSION_REFLECT: '1' }), true);
  });

  it('fileBugfixPlan default render has no reflect task', () => {
    const failure = makeFailure({ jobName: 'required-fast / Vitest Workspace' });
    const jobDefinitions = new Map([
      [failure.jobName, { verifyCommand: 'bash scripts/test-suites/required/10-vitest-workspace.sh' }],
    ]);
    const outRoot = mkdtempSync(join(tmpdir(), 'invoker-ci-watch-no-reflect-'));
    try {
      const rendered = fileBugfixPlan(failure, {
        repoUrl: 'git@github.com:Neko-Catpital-Labs/Invoker.git',
        jobDefinitions,
        outRoot,
        dryRun: true,
        enableReflect: false,
      });
      const planText = readFileSync(rendered.planPath, 'utf8');
      assert.equal(rendered.reflectEnabled, false);
      assert.equal(planText.includes('reflect-ci-'), false);
      assert.equal(planText.includes('skills/reflect'), false);
    } finally {
      rmSync(outRoot, { recursive: true, force: true });
    }
  });

  it('fileBugfixPlan opt-in reflect writes only to catstack', () => {
    const failure = makeFailure({ jobName: 'required-fast / Vitest Workspace' });
    const jobDefinitions = new Map([
      [failure.jobName, { verifyCommand: 'bash scripts/test-suites/required/10-vitest-workspace.sh' }],
    ]);
    const outRoot = mkdtempSync(join(tmpdir(), 'invoker-ci-watch-reflect-'));
    try {
      const rendered = fileBugfixPlan(failure, {
        repoUrl: 'git@github.com:Neko-Catpital-Labs/Invoker.git',
        jobDefinitions,
        outRoot,
        dryRun: true,
        enableReflect: true,
      });
      const planText = readFileSync(rendered.planPath, 'utf8');
      assert.equal(rendered.reflectEnabled, true);
      assert.equal(planText.includes('id: reflect-ci-'), true);
      assert.equal(planText.includes(CATSTACK_REPO_URL), true);
      assert.equal(planText.includes('Never edit Invoker files'), true);
      assert.equal(planText.includes("this repo's `skills/reflect/SKILL.md`"), false);
    } finally {
      rmSync(outRoot, { recursive: true, force: true });
    }
  });

  it('mapped live job files exactly as before', () => {
    const key = 'required-fast / Vitest Workspace';
    const state = stateWithFailure(makeFailure({ jobName: key }));
    const jobDefinitions = new Map([
      [key, { verifyCommand: 'bash scripts/test-suites/required/10-vitest-workspace.sh' }],
    ]);
    const filed = [];
    const now = new Date('2026-08-12T01:00:00Z');

    const counts = processFailureFilingSweep(state, {
      now,
      jobDefinitions,
      liveQuery: () => false,
      fileFailure: (failure) => {
        filed.push(failure.jobName);
      },
    });

    assert.deepEqual(filed, [key]);
    assert.equal(counts.groupsRetired, 0);
    assert.equal(counts.groupsFiled, 1);
    assert.equal(state.activeFailures[key].attempts, 1);
    assert.equal(state.activeFailures[key].lastFiledAt, now.toISOString());
    assert.equal(state.activeFailures[key].retired, false);
  });

  it('backtests the legacy 2026-08-12 stuck-lease playwright key against current ci.yml', () => {
    const key = 'playwright / launch-dispatch-stuck-lease';
    const state = stateWithFailure(makeFailure({
      jobName: key,
      attempts: 64,
      lastFiledAt: '2026-08-12T23:45:00.000Z',
    }));
    const jobDefinitions = buildCiJobDefinitions();
    let filed = 0;

    const counts = processFailureFilingSweep(state, {
      now: new Date('2026-08-13T00:00:00Z'),
      jobDefinitions,
      liveQuery: () => false,
      fileFailure: () => {
        filed += 1;
      },
    });

    assert.equal(jobNameIsMapped(key, jobDefinitions), true);
    assert.equal(filed, 0);
    assert.equal(counts.groupsRetired, 0);
    assert.equal(counts.groupsFiled, 0);
    assert.equal(counts.groupsNeedingHuman, 1);
    assert.equal(state.activeFailures[key].retired, false);
    assert.equal(state.activeFailures[key].needsHuman, true);
  });
});

function makeRun({ headSha, jobName, conclusion, databaseId, jobDatabaseId, createdAt }) {
  return {
    headSha,
    headBranch: 'master',
    databaseId,
    createdAt,
    jobs: [
      {
        name: jobName,
        status: 'completed',
        conclusion,
        databaseId: jobDatabaseId,
        url: `https://example.test/job/${jobDatabaseId}`,
        completedAt: createdAt,
      },
    ],
  };
}

describe('reconcileCiRun flaky-job flap handling', () => {
  const jobName = 'playwright / launch-dispatch-stuck-lease';
  const sha = 'a5d6b3e626ace9e963e924c0de9410dc0302de9e';

  it('reproduces the bug: a single green run used to wipe attempts/occurrences before a flap back to red', () => {
    // This is the historical (pre-fix) behavior this test guards against: a
    // job filed twice (attempts: 2) goes green once -- CI flakiness, not a
    // real fix -- then red again 10 minutes later. The watcher must not
    // hand it a brand-new 3-attempt budget for what is still the same
    // unresolved regression.
    const state = stateWithFailure(makeFailure({
      jobName,
      firstBadSha: sha,
      lastBadSha: sha,
      occurrences: 40,
      attempts: 2,
      lastFiledAt: '2026-08-13T20:00:00.000Z',
    }));

    reconcileCiRun(state, makeRun({
      headSha: sha, jobName, conclusion: 'success',
      databaseId: 101, jobDatabaseId: 201, createdAt: '2026-08-13T20:05:00.000Z',
    }));
    reconcileCiRun(state, makeRun({
      headSha: sha, jobName, conclusion: 'failure',
      databaseId: 102, jobDatabaseId: 202, createdAt: '2026-08-13T20:15:00.000Z',
    }));

    const failure = state.activeFailures[jobName];
    assert.ok(failure, 'failure record must survive the flap, not disappear');
    assert.equal(failure.attempts, 2, 'attempts must be preserved across a same-defect flap');
    assert.equal(failure.occurrences, 41, 'occurrences should accumulate, not reset to 1');
  });

  it('does not re-file work for a job currently reporting green during its recovery cooldown', () => {
    const state = stateWithFailure(makeFailure({
      jobName,
      firstBadSha: sha,
      lastBadSha: sha,
      attempts: 1,
      lastFiledAt: '2026-08-13T20:00:00.000Z',
    }));

    reconcileCiRun(state, makeRun({
      headSha: sha, jobName, conclusion: 'success',
      databaseId: 101, jobDatabaseId: 201, createdAt: '2026-08-13T20:05:00.000Z',
    }));

    assert.ok(state.activeFailures[jobName], 'record kept for cooldown bookkeeping');
    assert.deepEqual(
      getActionableFailures(state).map((f) => f.jobName),
      [],
      'a job CI currently reports green must not be filed again while its record is retained',
    );
  });

  it('still clears attempts/occurrences once the job has stayed green past the recovery cooldown', () => {
    const state = stateWithFailure(makeFailure({
      jobName,
      firstBadSha: sha,
      lastBadSha: sha,
      occurrences: 40,
      attempts: 2,
      lastFiledAt: '2026-08-13T20:00:00.000Z',
    }));

    reconcileCiRun(state, makeRun({
      headSha: sha, jobName, conclusion: 'success',
      databaseId: 101, jobDatabaseId: 201,
      createdAt: new Date(new Date('2026-08-13T20:00:00.000Z').getTime() + RECOVERY_COOLDOWN_MS + 1000).toISOString(),
    }));

    assert.equal(state.activeFailures[jobName], undefined, 'a durably green job should still clear its history');

    reconcileCiRun(state, makeRun({
      headSha: 'f'.repeat(40), jobName, conclusion: 'failure',
      databaseId: 103, jobDatabaseId: 203, createdAt: '2026-08-20T00:00:00.000Z',
    }));

    assert.equal(state.activeFailures[jobName].attempts, 0, 'a genuinely new regression starts with a fresh budget');
    assert.equal(state.activeFailures[jobName].occurrences, 1);
  });
});

describe('stale-observation retirement', () => {
  const jobName = 'playwright / launch-dispatch-stuck-lease';

  it('isObservationStale is false just inside the window and true just past it', () => {
    const lastObservedAt = '2026-08-06T01:21:00.000Z';
    const lastObservedMs = new Date(lastObservedAt).getTime();
    assert.equal(
      isObservationStale({ lastObservedAt }, lastObservedMs + STALE_OBSERVATION_MS - 1),
      false,
    );
    assert.equal(
      isObservationStale({ lastObservedAt }, lastObservedMs + STALE_OBSERVATION_MS + 1),
      true,
    );
  });

  it('reproduces the bug: a job kept "mapped" by a legacy alias, but never re-observed by CI, gets filed forever', () => {
    // Models LEGACY_PLAYWRIGHT_JOB_ALIASES: jobDefinitions has a real,
    // permanent entry for a job CI stopped producing after a shard rename
    // (the incident: no run reported this job, green or red, for 8+ days,
    // yet the watcher kept dispatching real "diagnose and fix" agents).
    const jobDefinitions = jobDefinitionsFor([jobName]);
    const state = stateWithFailure(makeFailure({
      jobName,
      occurrences: 66,
      attempts: 2,
      lastFiledAt: '2026-08-14T00:20:38.634Z',
      lastObservedAt: '2026-08-06T01:21:00.000Z',
    }));
    const filed = [];

    const counts = processFailureFilingSweep(state, {
      now: new Date('2026-08-14T01:00:00.000Z'),
      jobDefinitions,
      liveQuery: () => false,
      fileFailure: (failure) => filed.push(failure.jobName),
    });

    assert.deepEqual(filed, [], 'a job CI has not reported on in either direction must not be re-filed');
    assert.equal(counts.groupsRetiredStale, 1);
    assert.equal(counts.groupsFiled, 0);
    assert.equal(state.activeFailures[jobName].retired, true);
  });

  it('still files normally for a mapped job CI observed recently', () => {
    const jobDefinitions = jobDefinitionsFor([jobName]);
    const state = stateWithFailure(makeFailure({
      jobName,
      attempts: 0,
      lastFiledAt: null,
      lastObservedAt: '2026-08-13T23:00:00.000Z',
    }));
    const filed = [];

    const counts = processFailureFilingSweep(state, {
      now: new Date('2026-08-14T01:00:00.000Z'),
      jobDefinitions,
      liveQuery: () => false,
      fileFailure: (failure) => filed.push(failure.jobName),
    });

    assert.deepEqual(filed, [jobName]);
    assert.equal(counts.groupsRetiredStale, 0);
    assert.equal(state.activeFailures[jobName].retired, false);
  });
});

describe('auto-fix circuit breaker (shared with execution-engine)', () => {
  let dir;
  let breakerPath;

  function withDir(fn) {
    dir = mkdtempSync(join(tmpdir(), 'invoker-watch-breaker-'));
    breakerPath = join(dir, 'auto-fix-pause.json');
    try {
      return fn();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('isAutoFixCircuitBreakerPaused reads the same pause-file format execution-engine writes', () => withDir(() => {
    writeFileSync(breakerPath, JSON.stringify({
      pausedUntil: '2026-08-14T12:00:00.000Z',
      reason: 'usage-limit',
      triggeredAt: '2026-08-14T06:00:00.000Z',
    }));
    assert.equal(isAutoFixCircuitBreakerPaused(new Date('2026-08-14T08:00:00.000Z').getTime(), breakerPath), true);
    assert.equal(isAutoFixCircuitBreakerPaused(new Date('2026-08-15T00:00:00.000Z').getTime(), breakerPath), false);
  }));

  it('reproduces the bug: without a pause check, the sweep files new repair work while the fleet is out of quota', () => withDir(() => {
    const jobName = 'required-fast / Vitest Workspace';
    const state = stateWithFailure(makeFailure({ jobName }));
    const filed = [];

    const counts = processFailureFilingSweep(state, {
      now: new Date('2026-08-14T08:00:00.000Z'),
      jobDefinitions: jobDefinitionsFor([jobName]),
      liveQuery: () => false,
      fileFailure: (failure) => filed.push(failure.jobName),
      isPaused: () => true,
    });

    assert.deepEqual(filed, [], 'must not file while the shared circuit breaker is paused');
    assert.equal(counts.pausedByCircuitBreaker, true);
  }));

  it('resumes filing once the breaker is no longer paused', () => withDir(() => {
    const jobName = 'required-fast / Vitest Workspace';
    const state = stateWithFailure(makeFailure({ jobName }));
    const filed = [];

    const counts = processFailureFilingSweep(state, {
      now: new Date('2026-08-14T08:00:00.000Z'),
      jobDefinitions: jobDefinitionsFor([jobName]),
      liveQuery: () => false,
      fileFailure: (failure) => filed.push(failure.jobName),
      isPaused: () => false,
    });

    assert.deepEqual(filed, [jobName]);
    assert.equal(counts.pausedByCircuitBreaker, undefined);
  }));
});

describe('a poison-pill failure must not abort the whole sweep', () => {
  it('reproduces the bug: one fileFailure throwing used to stop every later candidate in the same sweep', () => {
    // Real incident: e2e-regression-watch filed 4 repair plans successfully,
    // then hit a CI job named "optional / Visual Proof Validate" -- its
    // interpolated job name tripped skill-doctor.sh's review-unit lint, and
    // that thrown error propagated all the way out of processFailureFilingSweep,
    // so the 5th+ actionable failures in that sweep got zero filing attempts.
    const jobs = [
      'required-fast / Vitest Workspace',
      'optional / Visual Proof Validate',
      'docker / comprehensive',
    ];
    const state = stateWithFailures(jobs.map((jobName, index) => makeFailure({
      jobName,
      firstBadSha: `a5d6b3e626ace9e963e924c0de9410dc0302de9${index}`,
    })));
    const jobDefinitions = jobDefinitionsFor(jobs);
    const filed = [];

    const counts = processFailureFilingSweep(state, {
      now: new Date('2026-08-12T00:00:00Z'),
      jobDefinitions,
      isPaused: () => false,
      liveQuery: () => false,
      fileFailure: (failure) => {
        if (failure.jobName === 'optional / Visual Proof Validate') {
          throw new Error('skill-doctor.sh lint-review-units failed: mixes docs language with product-unit language');
        }
        filed.push(failure.jobName);
      },
    });

    assert.deepEqual(
      filed.sort(),
      ['docker / comprehensive', 'required-fast / Vitest Workspace'],
      'the two healthy candidates must still get filed even though the middle one threw',
    );
    assert.equal(counts.groupsFiled, 2);
    assert.equal(counts.groupsFailedToFile, 1);
  });

  it('logs the failure via onFileError and still advances the attempt count so it eventually escalates to needs-human', () => {
    const jobName = 'optional / Visual Proof Validate';
    const state = stateWithFailure(makeFailure({ jobName }));
    const errors = [];

    processFailureFilingSweep(state, {
      now: new Date('2026-08-12T00:00:00Z'),
      jobDefinitions: jobDefinitionsFor([jobName]),
      isPaused: () => false,
      liveQuery: () => false,
      fileFailure: () => {
        throw new Error('lint-review-units failed');
      },
      onFileError: (failure, error) => {
        errors.push({ jobName: failure.jobName, message: error.message });
      },
    });

    assert.deepEqual(errors, [{ jobName, message: 'lint-review-units failed' }]);
    assert.equal(
      state.activeFailures[jobName].attempts,
      1,
      'a failed filing attempt must still count toward the cap, or this job would crash-loop every sweep forever',
    );
  });
});

describe('per-test failure identity under one CI job', () => {
  const jobName = 'required-fast / Mergify Admin Requeue';

  it('extracts distinct repro identities from the production Mergify Admin Requeue log shape', () => {
    const log = [
      "Cloning into '/tmp/repro-babysit-pr-body-human-split.ERdycn/seed'...",
      "To /tmp/repro-babysit-pr-body-human-split.ERdycn/origin.git",
      "rm: cannot remove '/tmp/repro-babysit-pr-body-human-split.ERdycn/seed/.git/objects': Directory not empty",
      '##[error]Process completed with exit code 1.',
    ].join('\n');
    const identities = extractFailureIdentitiesFromLog(log);
    assert.equal(identities.some((entry) => entry.failureId.includes('repro-babysit-pr-body-human-split')), true);
  });

  it('ignores git ref-sync listings while preserving genuine failure identities', () => {
    const log = [
      '* [new branch]  experiment/wf-98378590220/repro-event-loop-block/390bb7f -> origin/experiment/wf-98378590220/repro-event-loop-block/390bb7f',
      '* [new tag]  repro-asar-enotdir-snapshot -> repro-asar-enotdir-snapshot',
      'FAIL packages/some-package/src/__tests__/real-distinct-failure.test.ts',
    ].join('\n');
    const identities = extractFailureIdentitiesFromLog(log);

    assert.equal(identities.some((entry) => entry.failureId.includes('repro-event-loop-block')), false);
    assert.equal(identities.some((entry) => entry.failureId.includes('repro-asar-enotdir')), false);
    assert.equal(identities.some((entry) => entry.failureId.includes('real-distinct-failure')), true);
  });

  it('reproduces the bug: two distinct repros under one job must each get their own repair lifecycle', () => {
    // Observed (pre-fix): after filing a repair for the first Mergify Admin
    // Requeue failure, a later red observation that failed in a different
    // repro collapsed into the same activeFailures[jobName] key and the
    // permanent (job, firstBadSha) ledger claim blocked a second filing.
    // Expected: each test/repro identity files independently.
    const sha = '22891618af26fc7e3e19227ccc56ed183c0e7e26';
    const state = loadEmptyState();
    reconcileCiRun(state, {
      databaseId: 32534741079,
      headSha: sha,
      headBranch: 'master',
      createdAt: '2026-08-21T23:12:00Z',
      jobs: [{
        name: jobName,
        status: 'completed',
        conclusion: 'failure',
        databaseId: 96936670245,
        url: 'https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/32534741079/job/96936670245',
        completedAt: '2026-08-21T23:12:45Z',
        failureIdentities: [
          'repro-mergify-admin-requeue',
          'repro-babysit-pr-body-human-split',
        ],
      }],
    });

    const actionable = getActionableFailures(state);
    assert.deepEqual(
      actionable.map((failure) => failure.failureId).sort(),
      ['repro-babysit-pr-body-human-split', 'repro-mergify-admin-requeue'],
    );
    assert.equal(actionable.length, 2);

    const filed = [];
    const ledger = new Map();
    processFailureFilingSweep(state, {
      now: new Date('2026-08-21T23:30:00Z'),
      jobDefinitions: jobDefinitionsFor([jobName]),
      liveQuery: (failure) => claimRepairFiling(failure, ({ kind, subject, stateSha, metadata }) => {
        const key = `${kind} ${subject} ${stateSha}`;
        if (ledger.has(key)) return { inserted: false, row: ledger.get(key) };
        const row = { kind, subject, stateSha, metadata };
        ledger.set(key, row);
        return { inserted: true, row };
      }),
      fileFailure: (failure) => {
        filed.push(failure.failureId);
      },
    });

    assert.deepEqual(filed.sort(), [
      'repro-babysit-pr-body-human-split',
      'repro-mergify-admin-requeue',
    ]);
    assert.equal(ledger.size, 2, 'each identity must claim a distinct ledger key');
  });

  it('does not re-file the same test identity while matching non-terminal work is live', () => {
    const failure = makeFailure({
      jobName,
      failureId: 'repro-babysit-pr-body-human-split',
    });
    const queryFn = () => JSON.stringify([{
      status: 'running',
      description: `<!-- ${buildMarker(failure.firstBadSha, jobName, failure.failureId)} -->`,
    }]);
    assert.equal(liveQueryHasNonTerminalWork(failure, undefined, queryFn), true);
    assert.equal(
      shouldSkipFilingAlreadyAddressed(failure, {
        hasLiveWork: (candidate) => liveQueryHasNonTerminalWork(candidate, undefined, queryFn),
        claim: () => false,
      }),
      true,
    );
  });

  it('retries the same identity on a later attempt after backoff once prior repair work is terminal', () => {
    const failure = makeFailure({
      jobName,
      failureId: 'repro-babysit-pr-body-human-split',
      attempts: 1,
      lastFiledAt: '2026-08-21T22:00:00.000Z',
    });
    const state = stateWithFailure(failure);
    const ledger = new Map();
    const insert = ({ kind, subject, stateSha, metadata }) => {
      const key = `${kind} ${subject} ${stateSha}`;
      if (ledger.has(key)) return { inserted: false, row: ledger.get(key) };
      const row = { kind, subject, stateSha, metadata };
      ledger.set(key, row);
      return { inserted: true, row };
    };
    // Prior attempt-1 claim remains in the ledger, but attempt-2 uses a new kind.
    ledger.set(
      `${repairFilingKind({ ...failure, attempts: 0 })} master ${failure.firstBadSha}`,
      { kept: true },
    );

    const filed = [];
    // attempts=1 => backoff = 30m * 2^1 = 60m; file only after that window.
    processFailureFilingSweep(state, {
      now: new Date('2026-08-21T23:00:01Z'),
      jobDefinitions: jobDefinitionsFor([jobName]),
      liveQuery: (candidate) => shouldSkipFilingAlreadyAddressed(candidate, {
        hasLiveWork: () => false,
        claim: (inner) => claimRepairFiling(inner, insert),
      }),
      fileFailure: (candidate) => filed.push(repairFilingKind(candidate)),
    });

    assert.equal(filed.length, 1);
    assert.equal(filed[0], 'ci-regression:required-fast-mergify-admin-requeue:repro-babysit-pr-body-human-split:a2');
    assert.equal(state.activeFailures[failureStorageKey(failure)].attempts, 2);
  });

  it('treats review_ready work whose repair PR is no longer open as finished', () => {
    const failure = makeFailure({
      jobName,
      failureId: 'repro-babysit-pr-body-human-split',
    });
    const queryFn = () => JSON.stringify([{
      status: 'review_ready',
      description: `<!-- ${buildMarker(failure.firstBadSha, jobName, failure.failureId)} -->`,
      reviewUrl: 'https://github.com/Neko-Catpital-Labs/Invoker/pull/9923',
    }]);
    assert.equal(
      liveQueryHasNonTerminalWork(failure, undefined, queryFn, { isRepairPrOpen: () => false }),
      false,
      'merged/closed repair PR must not block the next attempt',
    );
    assert.equal(
      liveQueryHasNonTerminalWork(failure, undefined, queryFn, { isRepairPrOpen: () => true }),
      true,
      'open repair PR must still count as in-flight work',
    );
  });

  it('clears every identity for a job once CI reports the job green past recovery cooldown', () => {
    const state = stateWithFailures([
      makeFailure({
        jobName,
        failureId: 'repro-a',
        attempts: 1,
        lastFiledAt: '2026-08-01T00:00:00.000Z',
      }),
      makeFailure({
        jobName,
        failureId: 'repro-b',
        attempts: 2,
        lastFiledAt: '2026-08-01T00:00:00.000Z',
      }),
    ]);
    reconcileCiRun(state, {
      databaseId: 99,
      headSha: 'f'.repeat(40),
      headBranch: 'master',
      createdAt: '2026-08-20T00:00:00.000Z',
      jobs: [{
        name: jobName,
        status: 'completed',
        conclusion: 'success',
        databaseId: 100,
        url: 'https://example.test/job/100',
        completedAt: '2026-08-20T00:00:00.000Z',
      }],
    });
    assert.deepEqual(Object.keys(state.activeFailures), []);
  });

  it('migrates legacy job-only activeFailures into schema v5 with failureId=job', () => {
    const migrated = normalizeState({
      schemaVersion: 4,
      lastProcessedRunId: 1,
      heads: {},
      activeFailures: {
        [jobName]: {
          jobName,
          firstBadSha: 'abc1234',
          attempts: 2,
        },
      },
    });
    assert.equal(migrated.schemaVersion, 5);
    assert.equal(migrated.activeFailures[jobName].failureId, JOB_LEVEL_FAILURE_ID);
    assert.equal(migrated.activeFailures[jobName].failureKey, jobName);
    assert.equal(migrated.activeFailures[jobName].attempts, 2);
  });
});

describe('watch-target-repo config resolution', () => {
  const CATSTACK_TARGET_REPO = 'EdbertChan/catstack';

  it('resolves the Invoker default when no CLI flag, env var, or config file is set', () => {
    assert.equal(resolveTargetRepo({ argv: [], env: {} }), DEFAULT_TARGET_REPO);
  });

  it('parseTargetRepoFlag reads both "--target-repo value" and "--target-repo=value" forms', () => {
    assert.equal(parseTargetRepoFlag(['--target-repo', CATSTACK_TARGET_REPO]), CATSTACK_TARGET_REPO);
    assert.equal(parseTargetRepoFlag([`--target-repo=${CATSTACK_TARGET_REPO}`]), CATSTACK_TARGET_REPO);
    assert.equal(parseTargetRepoFlag([]), undefined);
  });

  it('parseWatchConfigFlag reads both "--config value" and "--config=value" forms', () => {
    assert.equal(parseWatchConfigFlag(['--config', '/tmp/watch.json']), '/tmp/watch.json');
    assert.equal(parseWatchConfigFlag(['--config=/tmp/watch.json']), '/tmp/watch.json');
    assert.equal(parseWatchConfigFlag([]), undefined);
  });

  it('CLI flag wins over env var and config file', () => {
    const repo = resolveTargetRepo({
      argv: ['--target-repo', CATSTACK_TARGET_REPO],
      env: { INVOKER_GITHUB_TARGET_REPO: 'someone/else', INVOKER_CI_WATCH_CONFIG_FILE: '/tmp/unused.json' },
      exists: () => { throw new Error('config file must not be read when a CLI flag is present'); },
    });
    assert.equal(repo, CATSTACK_TARGET_REPO);
  });

  it('env var wins over config file when no CLI flag is present', () => {
    const repo = resolveTargetRepo({
      argv: [],
      env: { INVOKER_GITHUB_TARGET_REPO: CATSTACK_TARGET_REPO, INVOKER_CI_WATCH_CONFIG_FILE: '/tmp/unused.json' },
      exists: () => { throw new Error('config file must not be read when an env var is present'); },
    });
    assert.equal(repo, CATSTACK_TARGET_REPO);
  });

  it('falls back to a JSON config file\'s targetRepo when no CLI flag or env var is set', () => {
    const repo = resolveTargetRepo({
      argv: ['--config', '/tmp/watch.json'],
      env: {},
      exists: (path) => path === '/tmp/watch.json',
      readFile: () => JSON.stringify({ targetRepo: CATSTACK_TARGET_REPO }),
    });
    assert.equal(repo, CATSTACK_TARGET_REPO);
  });

  it('loadWatchConfigFile returns {} when no config path is given, and throws on a missing file or non-object JSON', () => {
    assert.deepEqual(loadWatchConfigFile(undefined), {});
    assert.throws(() => loadWatchConfigFile('/tmp/missing.json', { exists: () => false }));
    assert.throws(() => loadWatchConfigFile('/tmp/array.json', {
      exists: () => true,
      readFile: () => '[1,2,3]',
    }));
  });

  it('resolveStateDir keeps the default Invoker state path unchanged for the default target repo', () => {
    const dir = resolveStateDir(DEFAULT_TARGET_REPO, { env: {}, homeDir: '/home/tester' });
    assert.equal(dir, join('/home/tester', '.invoker', 'e2e-regression-watch'));
  });

  it('resolveStateDir isolates a non-default target repo under its own slugged subdirectory', () => {
    const dir = resolveStateDir(CATSTACK_TARGET_REPO, { env: {}, homeDir: '/home/tester' });
    assert.equal(dir, join('/home/tester', '.invoker', 'e2e-regression-watch-targets', 'edbertchan-catstack'));
    assert.notEqual(dir, resolveStateDir(DEFAULT_TARGET_REPO, { env: {}, homeDir: '/home/tester' }));
  });

  it('resolveStateDir lets an explicit state-dir env var override isolation for any target repo', () => {
    const explicit = '/custom/state/dir';
    assert.equal(resolveStateDir(DEFAULT_TARGET_REPO, { env: { INVOKER_CI_WATCH_STATE_DIR: explicit } }), explicit);
    assert.equal(resolveStateDir(CATSTACK_TARGET_REPO, { env: { INVOKER_CI_WATCH_STATE_DIR: explicit } }), explicit);
  });

  it('resolveRepairFilingSubject keeps the default repo\'s existing "master" subject unchanged', () => {
    assert.equal(resolveRepairFilingSubject(DEFAULT_TARGET_REPO), 'master');
  });

  it('resolveRepairFilingSubject namespaces a non-default target repo so its ledger rows can never collapse onto Invoker\'s own', () => {
    const catstackSubject = resolveRepairFilingSubject(CATSTACK_TARGET_REPO);
    assert.notEqual(catstackSubject, 'master');
    assert.equal(catstackSubject, `${CATSTACK_TARGET_REPO}:master`);
  });

  it('claimRepairFiling on the default-target process claims the unmodified "master" subject', () => {
    // TARGET_REPO is resolved once at module load from this test process's
    // own argv/env (neither is set to a non-default repo here), so this
    // exercises the real exported claimRepairFiling end-to-end rather than
    // resolveRepairFilingSubject in isolation.
    const rows = new Map();
    const insert = ({ kind, subject, stateSha, metadata }) => {
      const key = `${kind} ${subject} ${stateSha}`;
      if (rows.has(key)) return { inserted: false, row: rows.get(key) };
      const row = { kind, subject, stateSha, metadata };
      rows.set(key, row);
      return { inserted: true, row };
    };
    const failure = makeFailure({ firstBadSha: 'shaSharedAcrossRepos' });

    assert.equal(claimRepairFiling(failure, insert), false, 'claim must succeed');
    assert.equal(rows.size, 1);
    const [[, row]] = rows;
    assert.equal(row.subject, 'master', 'default repo keeps the unmodified "master" subject');
  });

  it('a catstack-scoped subject and the default-repo subject can never collapse onto the same ledger row for an identical (kind, sha)', () => {
    // claimRepairFiling itself can't be re-targeted per-call (TARGET_REPO is
    // resolved once at module load), so this simulates two isolated watcher
    // processes -- one on the Invoker default, one on catstack -- racing the
    // same underlying (kind, sha) against one shared ledger, using the same
    // composite-key shape claimRepairFiling builds internally.
    const rows = new Map();
    const insertUnderSubject = (subject, failure) => {
      const key = `${repairFilingKind(failure)} ${subject} ${failure.firstBadSha}`;
      if (rows.has(key)) return { inserted: false };
      rows.set(key, { subject });
      return { inserted: true };
    };
    const failure = makeFailure({ firstBadSha: 'shaSharedAcrossRepos' });

    const defaultResult = insertUnderSubject(resolveRepairFilingSubject(DEFAULT_TARGET_REPO), failure);
    const catstackResult = insertUnderSubject(resolveRepairFilingSubject(CATSTACK_TARGET_REPO), failure);

    assert.equal(defaultResult.inserted, true);
    assert.equal(catstackResult.inserted, true, 'catstack must claim its own row, not collide with the default repo\'s');
    assert.equal(rows.size, 2);
  });
});
