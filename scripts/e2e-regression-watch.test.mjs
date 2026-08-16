import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildCiJobDefinitions,
  buildMarker,
  fileBugfixPlan,
  getActionableFailures,
  groupFailuresBySha,
  isAutoFixCircuitBreakerPaused,
  isObservationStale,
  jobNameIsMapped,
  loadEmptyState,
  liveQueryHasNonTerminalWork,
  normalizeState,
  processFailureFilingSweep,
  reconcileCiRun,
  RECOVERY_COOLDOWN_MS,
  STALE_OBSERVATION_MS,
} from './e2e-regression-watch.mjs';

function makeFailure(overrides = {}) {
  return {
    jobName: 'playwright / launch-dispatch-stuck-lease',
    firstBadSha: 'a5d6b3e626ace9e963e924c0de9410dc0302de9a',
    firstBadRunId: 100,
    firstBadRunCreatedAt: '2026-08-12T00:00:00Z',
    firstJobDatabaseId: 200,
    firstJobUrl: 'https://example.test/job/200',
    lastBadSha: 'a5d6b3e626ace9e963e924c0de9410dc0302de9a',
    lastBadRunId: 100,
    lastJobDatabaseId: 200,
    lastJobUrl: 'https://example.test/job/200',
    lastObservedAt: '2026-08-12T00:00:00Z',
    occurrences: 1,
    attempts: 0,
    lastFiledAt: null,
    needsHuman: false,
    ...overrides,
  };
}

function stateWithFailure(failure = makeFailure()) {
  const state = loadEmptyState();
  state.activeFailures[failure.jobName] = failure;
  return state;
}

function stateWithFailures(failures) {
  const state = loadEmptyState();
  for (const failure of failures) state.activeFailures[failure.jobName] = failure;
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
    assert.equal(filed[0].jobName, 'fleet / abc123d (3 jobs)');
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
    assert.equal(state.activeFailures['fleet / abc123d (3 jobs)'].attempts, 1);
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
    assert.equal(state.activeFailures['fleet / abc123d (3 jobs)'].attempts, 1);

    let liveQueryCalled = false;
    const cappedCounts = processFailureFilingSweep(state, {
      now: new Date('2026-08-12T03:00:00Z'),
      maxAttempts: 1,
      jobDefinitions,
      liveQuery: () => {
        liveQueryCalled = true;
        return false;
      },
      fileFailure: () => {
        filed += 1;
      },
    });

    assert.equal(liveQueryCalled, false, 'attempt cap should skip before live workflow dedup');
    assert.equal(cappedCounts.groupsNeedingHuman, 1);
    assert.equal(filed, 1);
    assert.equal(state.activeFailures['fleet / abc123d (3 jobs)'].needsHuman, true);
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
    assert.equal(fleetFilings[0].jobName, 'fleet / 631a0d0 (11 jobs)');
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

    assert.equal(migrated.schemaVersion, 4);
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
