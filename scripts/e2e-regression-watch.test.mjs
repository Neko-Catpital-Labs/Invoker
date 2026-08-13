import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCiJobDefinitions,
  buildMarker,
  fileBugfixPlan,
  jobNameIsMapped,
  loadEmptyState,
  liveQueryHasNonTerminalWork,
  normalizeState,
  processFailureFilingSweep,
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
    const key = 'playwright / launch-dispatch-stuck-lease';
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
    const failure = makeFailure({ jobName: 'playwright / launch-dispatch-stuck-lease' });
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

  it('backtests the real 2026-08-12 retired playwright key against current ci.yml', () => {
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

    assert.equal(jobNameIsMapped(key, jobDefinitions), false);
    assert.equal(filed, 0);
    assert.equal(counts.groupsRetired, 1);
    assert.equal(counts.groupsFiled, 0);
    assert.equal(state.activeFailures[key].retired, true);
  });
});
