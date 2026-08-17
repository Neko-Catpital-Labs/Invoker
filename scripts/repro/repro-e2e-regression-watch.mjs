#!/usr/bin/env node
// Exercises scripts/e2e-regression-watch.mjs's pure logic and dry-run formula
// path. The optional live smoke uses real GitHub read APIs only when
// INVOKER_E2E_REGRESSION_WATCH_LIVE=1 is set.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildCiJobDefinitions,
  buildMarker,
  buildPlanVars,
  classifyJobConclusion,
  fileBugfixPlan,
  getActionableFailures,
  getCiRun,
  listUnprocessedDefaultBranchRuns,
  jobNameIsMapped,
  liveQueryHasNonTerminalWork,
  loadEmptyState,
  normalizeState,
  processFailureFilingSweep,
  reconcileCiRun,
} from '../e2e-regression-watch.mjs';

function fail(message) {
  throw new Error(`[repro-e2e-regression-watch] ${message}`);
}

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) fail(`${label}: expected ${e}, got ${a}`);
}

function fakeJob(name, conclusion, id = 1) {
  return {
    name,
    status: 'completed',
    conclusion,
    databaseId: id,
    url: `https://example.test/job/${id}`,
    completedAt: `2026-07-31T00:0${id}:00Z`,
  };
}

function fakeRun(id, sha, jobs) {
  return {
    databaseId: id,
    headSha: sha,
    headBranch: 'master',
    event: 'push',
    status: 'completed',
    conclusion: jobs.some((job) => job.conclusion === 'failure') ? 'failure' : 'success',
    createdAt: `2026-07-31T00:${id}:00Z`,
    jobs,
  };
}

function fakeFailure(overrides = {}) {
  return {
    jobName: 'playwright / launch-dispatch-stuck-lease',
    firstBadSha: 'a5d6b3e626ace9e963e924c0de9410dc0302de9a',
    firstBadRunId: 500,
    firstBadRunCreatedAt: '2026-08-12T00:00:00Z',
    firstJobDatabaseId: 501,
    firstJobUrl: 'https://example.test/job/501',
    lastBadSha: 'a5d6b3e626ace9e963e924c0de9410dc0302de9a',
    lastBadRunId: 500,
    lastJobDatabaseId: 501,
    lastJobUrl: 'https://example.test/job/501',
    lastObservedAt: '2026-08-12T00:00:00Z',
    occurrences: 1,
    attempts: 0,
    lastFiledAt: null,
    needsHuman: false,
    ...overrides,
  };
}

function stateWithFailure(failure) {
  const state = loadEmptyState();
  state.activeFailures[failure.jobName] = failure;
  return state;
}

function stateWithFailures(failures) {
  const state = loadEmptyState();
  for (const failure of failures) state.activeFailures[failure.jobName] = failure;
  return state;
}

function testJobClassification() {
  assertEqual(classifyJobConclusion(fakeJob('A', 'success')), 'ok', 'success is ok');
  assertEqual(classifyJobConclusion(fakeJob('A', 'failure')), 'broken', 'failure is broken');
  assertEqual(classifyJobConclusion(fakeJob('A', 'timed_out')), 'broken', 'timed_out is broken');
  assertEqual(classifyJobConclusion(fakeJob('A', 'cancelled')), 'ignored', 'cancelled is ignored');
  assertEqual(classifyJobConclusion(fakeJob('A', 'skipped')), 'ignored', 'skipped is ignored');
  console.log('[repro-e2e-regression-watch] job classification: PASS');
}

function testPerHeadFailureDedupAndRecovery() {
  const state = loadEmptyState();
  reconcileCiRun(state, fakeRun(100, 'sha-x', [fakeJob('playwright / 1-of-9', 'failure', 10)]));
  let failures = getActionableFailures(state);
  assertEqual(failures.length, 1, 'first failure creates one actionable failure');
  assertEqual(failures[0].firstBadSha, 'sha-x', 'first bad SHA is recorded');
  assertEqual(state.heads['sha-x'].jobs['playwright / 1-of-9'].state, 'broken', 'head records broken job');

  reconcileCiRun(state, fakeRun(101, 'sha-x-plus-1', [fakeJob('playwright / 1-of-9', 'failure', 11)]));
  failures = getActionableFailures(state);
  assertEqual(failures.length, 1, 'duplicate failing HEAD keeps one actionable failure');
  assertEqual(failures[0].firstBadSha, 'sha-x', 'first bad SHA is stable across duplicates');
  assertEqual(failures[0].lastBadSha, 'sha-x-plus-1', 'latest bad SHA advances');

  reconcileCiRun(state, fakeRun(102, 'sha-x-plus-2', [fakeJob('playwright / 1-of-9', 'success', 12)]));
  failures = getActionableFailures(state);
  assertEqual(failures.length, 0, 'later successful HEAD clears active failure');
  assertEqual(state.heads['sha-x-plus-2'].jobs['playwright / 1-of-9'].state, 'ok', 'success is recorded per head');
  console.log('[repro-e2e-regression-watch] per-HEAD dedup + recovery: PASS');
}

function testCancelledAndSkippedDoNotClear() {
  const state = loadEmptyState();
  reconcileCiRun(state, fakeRun(200, 'sha-a', [fakeJob('required-fast / Vitest Workspace', 'failure', 20)]));
  reconcileCiRun(state, fakeRun(201, 'sha-b', [fakeJob('required-fast / Vitest Workspace', 'cancelled', 21)]));
  reconcileCiRun(state, fakeRun(202, 'sha-c', [fakeJob('required-fast / Vitest Workspace', 'skipped', 22)]));
  const failures = getActionableFailures(state);
  assertEqual(failures.length, 1, 'cancelled/skipped do not clear active failure');
  assertEqual(failures[0].firstBadSha, 'sha-a', 'first bad SHA remains after ignored runs');
  assertEqual(state.heads['sha-b'].jobs['required-fast / Vitest Workspace'].state, 'ignored', 'cancelled head is recorded ignored');
  assertEqual(state.heads['sha-c'].jobs['required-fast / Vitest Workspace'].state, 'ignored', 'skipped head is recorded ignored');
  console.log('[repro-e2e-regression-watch] cancelled/skipped behavior: PASS');
}

function testEveryFailedJobQueuesSeparately() {
  const state = loadEmptyState();
  reconcileCiRun(state, fakeRun(300, 'sha-many', [
    fakeJob('playwright / 1-of-9', 'failure', 30),
    fakeJob('playwright / 2-of-9', 'failure', 31),
    fakeJob('build-artifacts', 'success', 32),
  ]));
  const failures = getActionableFailures(state);
  assertEqual(failures.map((f) => f.jobName), ['playwright / 1-of-9', 'playwright / 2-of-9'], 'each failed job is actionable');
  console.log('[repro-e2e-regression-watch] every failed job queues separately: PASS');
}

function testLiveDedupIsJobScoped() {
  const sha = 'sha-dedup-test';
  const job = 'playwright / 1-of-9';
  const marker = buildMarker(sha, job);
  const fakeNonTerminal = () => JSON.stringify([{ status: 'running', description: `<!-- ${marker} -->` }]);
  const fakeTerminal = () => JSON.stringify([{ status: 'failed', description: `<!-- ${marker} -->` }]);
  const fakeOtherJob = () => JSON.stringify([{ status: 'running', description: `<!-- ${buildMarker(sha, 'playwright / 2-of-9')} -->` }]);

  if (!liveQueryHasNonTerminalWork(sha, job, fakeNonTerminal)) fail('non-terminal matching marker must dedupe');
  if (liveQueryHasNonTerminalWork(sha, job, fakeTerminal)) fail('terminal matching marker must not dedupe');
  if (liveQueryHasNonTerminalWork(sha, job, fakeOtherJob)) fail('same SHA but different job must not dedupe');
  console.log('[repro-e2e-regression-watch] live dedup is job-scoped: PASS');
}

function testWorkflowCommandMapping() {
  const defs = buildCiJobDefinitions();
  const expected = [
    'playwright / 1-of-9',
    'playwright / 9-of-9',
    'playwright / launch-dispatch-stuck-lease',
    'required-fast / Vitest Workspace',
    'e2e-proof / shard 0',
    'docker / comprehensive',
  ];
  for (const name of expected) {
    const def = defs.get(name);
    if (!def) fail(`missing CI job definition for ${name}`);
    if (!def.verifyCommand) fail(`CI job definition lacks verify command for ${name}`);
  }
  if (!defs.get('playwright / 1-of-9').verifyCommand.includes('INVOKER_PLAYWRIGHT_FILES=')) {
    fail('playwright shard command must include shard file list');
  }
  const legacyStuckLeaseCommand = defs.get('playwright / launch-dispatch-stuck-lease')?.verifyCommand ?? '';
  if (legacyStuckLeaseCommand.includes('No local verify command is mapped')) {
    fail('legacy stuck-lease playwright job must not use fallback verify command');
  }
  if (
    !legacyStuckLeaseCommand.includes('ci-playwright-launch-dispatch-stuck-lease')
    || !legacyStuckLeaseCommand.includes('e2e/launch-dispatch-stuck-lease-cap.spec.ts')
    || !legacyStuckLeaseCommand.includes('e2e/launch-dispatch-stuck-lease-storm.spec.ts')
  ) {
    fail('legacy stuck-lease playwright job must map to its two spec files');
  }
  if (defs.get('required-fast / Vitest Workspace').verifyCommand !== 'pnpm --filter @invoker/ui build && pnpm --filter @invoker/surfaces build && pnpm --filter @invoker/app build && bash scripts/test-suites/required/10-vitest-workspace.sh') {
    fail('required-fast / Vitest Workspace command changed unexpectedly');
  }
  console.log('[repro-e2e-regression-watch] workflow command mapping: PASS');
}

function testPlanVarsAndDryRunRendering() {
  const state = loadEmptyState();
  reconcileCiRun(state, fakeRun(400, 'abc123def456abc123def456abc123def456ab1', [
    fakeJob('required-fast / Vitest Workspace', 'failure', 40),
  ]));
  const [failure] = getActionableFailures(state);
  const defs = buildCiJobDefinitions();
  const vars = buildPlanVars(failure, 'git@github.com:Neko-Catpital-Labs/Invoker.git', defs);
  if (!vars.marker.includes('job=required-fast / Vitest Workspace')) fail('marker must include job name');
  if (!vars.verify_command.includes('10-vitest-workspace.sh')) fail('verify command must be job-specific');

  const outRoot = mkdtempSync(join(tmpdir(), 'invoker-ci-watch-render-'));
  try {
    const rendered = fileBugfixPlan(failure, {
      repoUrl: 'git@github.com:Neko-Catpital-Labs/Invoker.git',
      jobDefinitions: defs,
      outRoot,
      dryRun: true,
    });
    if (!rendered.planPath.endsWith('ci-regression-watch.yaml')) fail('dry run did not render expected plan path');
    if (rendered.submitted) fail('dry run must not submit');
    const planText = readFileSync(rendered.planPath, 'utf8');
    // #7086's codex pin outlived the outage it was a stopgap for; see #9452.
    if (planText.includes('executionAgent: codex')) fail('fix task must not hardcode codex; let the configured default agent apply');
  } finally {
    rmSync(outRoot, { recursive: true, force: true });
  }
  console.log('[repro-e2e-regression-watch] plan vars + dry-run rendering: PASS');
}

function testLiveSubmissionUsesNoTrack() {
  const state = loadEmptyState();
  reconcileCiRun(state, fakeRun(450, 'abc456def456abc123def456abc123def456ab2', [
    fakeJob('playwright / 2-of-9', 'failure', 45),
  ]));
  const [failure] = getActionableFailures(state);
  const calls = [];
  const rendered = fileBugfixPlan(failure, {
    repoUrl: 'git@github.com:Neko-Catpital-Labs/Invoker.git',
    jobDefinitions: buildCiJobDefinitions(),
    outRoot: join(tmpdir(), 'invoker-ci-watch-no-track-test'),
    dryRun: false,
    runCommand: (cmd, args) => calls.push([cmd, args]),
  });

  assertEqual(rendered.submitted, true, 'live filing reports submitted');
  const submitCall = calls.find(([, args]) => args.some((arg) => String(arg).endsWith('/submit-plan.sh')));
  if (!submitCall) fail('live filing did not invoke submit-plan.sh');
  const [, submitArgs] = submitCall;
  assertEqual(submitArgs.at(-1), '--no-track', 'live filing must submit without tracking');
  assertEqual(submitArgs.at(-2), rendered.planPath, 'live filing passes rendered plan before --no-track');
  console.log('[repro-e2e-regression-watch] live submission uses --no-track: PASS');
}

function testAttemptLedgerScenario() {
  const cappedState = stateWithFailure(fakeFailure({ attempts: 3 }));
  let cappedFilings = 0;
  const cappedCounts = processFailureFilingSweep(cappedState, {
    now: new Date('2026-08-12T01:00:00Z'),
    maxAttempts: 3,
    liveQuery: () => false,
    fileFailure: () => {
      cappedFilings += 1;
    },
  });
  assertEqual(cappedFilings, 0, 'cap reached does not file');
  assertEqual(cappedCounts.groupsNeedingHuman, 1, 'cap reached is counted for human review');
  assertEqual(cappedState.activeFailures['playwright / launch-dispatch-stuck-lease'].needsHuman, true, 'cap reached marks needsHuman');

  const backoffState = stateWithFailure(fakeFailure({
    attempts: 1,
    lastFiledAt: '2026-08-12T00:00:00.000Z',
  }));
  let backoffFilings = 0;
  const backoffCounts = processFailureFilingSweep(backoffState, {
    now: new Date('2026-08-12T00:59:59Z'),
    maxAttempts: 3,
    liveQuery: () => false,
    fileFailure: () => {
      backoffFilings += 1;
    },
  });
  assertEqual(backoffFilings, 0, 'inside backoff does not file');
  assertEqual(backoffCounts.groupsInBackoff, 1, 'inside backoff is counted');

  const readyState = stateWithFailure(fakeFailure({
    attempts: 1,
    lastFiledAt: '2026-08-12T00:00:00.000Z',
  }));
  let readyFilings = 0;
  const readyNow = new Date('2026-08-12T01:00:00Z');
  processFailureFilingSweep(readyState, {
    now: readyNow,
    maxAttempts: 3,
    liveQuery: () => false,
    fileFailure: () => {
      readyFilings += 1;
    },
  });
  assertEqual(readyFilings, 1, 'past backoff files');
  assertEqual(readyState.activeFailures['playwright / launch-dispatch-stuck-lease'].attempts, 2, 'past backoff increments attempts');
  assertEqual(readyState.activeFailures['playwright / launch-dispatch-stuck-lease'].lastFiledAt, readyNow.toISOString(), 'past backoff records lastFiledAt');

  const migrated = normalizeState({
    schemaVersion: 2,
    activeFailures: {
      'required-fast / Vitest Workspace': {
        jobName: 'required-fast / Vitest Workspace',
        firstBadSha: 'legacy-sha',
      },
    },
  });
  assertEqual(migrated.activeFailures['required-fast / Vitest Workspace'].attempts, 0, 'legacy migration defaults attempts');
  assertEqual(migrated.activeFailures['required-fast / Vitest Workspace'].lastFiledAt, null, 'legacy migration defaults lastFiledAt');
  assertEqual(migrated.activeFailures['required-fast / Vitest Workspace'].needsHuman, false, 'legacy migration defaults needsHuman');
  assertEqual(migrated.activeFailures['required-fast / Vitest Workspace'].retired, false, 'legacy migration defaults retired');

  const backtestState = stateWithFailure(fakeFailure());
  const startMs = Date.parse('2026-08-12T00:00:00Z');
  let backtestFilings = 0;
  for (let sweep = 0; sweep < 64; sweep += 1) {
    processFailureFilingSweep(backtestState, {
      now: new Date(startMs + (sweep * 15 * 60 * 1000)),
      maxAttempts: 3,
      liveQuery: () => false,
      fileFailure: () => {
        backtestFilings += 1;
      },
    });
  }
  assertEqual(backtestFilings, 3, '64 terminal sweeps file at most three plans');
  assertEqual(backtestState.activeFailures['playwright / launch-dispatch-stuck-lease'].needsHuman, true, '64 terminal sweeps flag needsHuman');
  console.log('[repro-e2e-regression-watch] attempt-ledger scenario: PASS');
}

function testFleetCorrelationScenario() {
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
  const failures = jobs.map((jobName, index) => fakeFailure({
    jobName,
    firstBadSha: sha,
    firstBadRunId: 6310,
    firstJobDatabaseId: 63100 + index,
    firstJobUrl: `https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/6310/job/${63100 + index}`,
    lastBadSha: sha,
    lastBadRunId: 6310,
  }));
  const jobDefinitions = buildCiJobDefinitions();
  const historicalState = stateWithFailures(failures);
  const fleetState = stateWithFailures(failures.map((failure) => ({ ...failure })));
  const historicalFilings = [];
  const fleetFilings = [];

  processFailureFilingSweep(historicalState, {
    fleetEventThreshold: 99,
    jobDefinitions,
    liveQuery: () => false,
    fileFailure: (failure) => {
      historicalFilings.push(failure.jobName);
    },
  });
  const counts = processFailureFilingSweep(fleetState, {
    jobDefinitions,
    liveQuery: (failure) => {
      const marker = buildMarker(failure.firstBadSha, failure.markerJobName ?? failure.jobName);
      if (marker !== buildMarker(sha, 'fleet')) fail(`fleet sweep used wrong marker: ${marker}`);
      return false;
    },
    fileFailure: (failure) => {
      fleetFilings.push(failure);
    },
  });

  assertEqual(historicalFilings.length, 11, 'historical 631a0d0 wave would file eleven isolated jobs');
  assertEqual(fleetFilings.length, 1, '631a0d0 wave files one fleet plan');
  assertEqual(fleetFilings[0].jobName, 'fleet / 631a0d0 (11 jobs)', 'fleet filing has expected synthetic job name');
  assertEqual(counts.groupsCorrelated, 1, 'fleet sweep counts one correlated group');
  for (const jobName of jobs) {
    if (!fleetFilings[0].description.includes(jobName)) fail(`fleet description omitted ${jobName}`);
    assertEqual(fleetState.activeFailures[jobName].memberOfFleetEvent, sha, `${jobName} memberOfFleetEvent`);
  }
  if (!fleetFilings[0].verifyCommand || fleetFilings[0].verifyCommand.includes('No local verify command is mapped')) {
    fail('fleet verify_command must be a real mapped command');
  }

  const outRoot = mkdtempSync(join(tmpdir(), 'invoker-ci-watch-fleet-render-'));
  try {
    const rendered = fileBugfixPlan(fleetFilings[0], {
      repoUrl: 'git@github.com:Neko-Catpital-Labs/Invoker.git',
      jobDefinitions,
      outRoot,
      dryRun: true,
    });
    const planText = readFileSync(rendered.planPath, 'utf8');
    if (!planText.includes(buildMarker(sha, 'fleet'))) fail('rendered fleet plan omitted fleet marker');
    for (const jobName of jobs) {
      if (!planText.includes(jobName)) fail(`rendered fleet plan omitted ${jobName}`);
    }
  } finally {
    rmSync(outRoot, { recursive: true, force: true });
  }
  console.log('[repro-e2e-regression-watch] fleet-correlation scenario: PASS');
}

function testRetiredJobScenario() {
  const retiredKey = 'playwright / retired-example';
  const defs = buildCiJobDefinitions();
  if (jobNameIsMapped(retiredKey, defs)) {
    fail(`${retiredKey} should be absent from current ci.yml`);
  }
  const legacyStuckLeaseKey = 'playwright / launch-dispatch-stuck-lease';
  if (!jobNameIsMapped(legacyStuckLeaseKey, defs)) {
    fail(`${legacyStuckLeaseKey} should stay mapped to its focused local verifier`);
  }

  const state = stateWithFailure(fakeFailure({
    jobName: retiredKey,
    attempts: 64,
    lastFiledAt: '2026-08-12T23:45:00.000Z',
  }));
  let filed = 0;
  let liveQueryCalled = false;
  const retiredKeys = [];
  const counts = processFailureFilingSweep(state, {
    now: new Date('2026-08-13T00:00:00Z'),
    jobDefinitions: defs,
    liveQuery: () => {
      liveQueryCalled = true;
      return false;
    },
    fileFailure: () => {
      filed += 1;
    },
    onRetired: (failure) => {
      retiredKeys.push(failure.jobName);
    },
  });

  assertEqual(filed, 0, 'retired job does not file');
  assertEqual(liveQueryCalled, false, 'retired job skips before live dedup');
  assertEqual(retiredKeys, [retiredKey], 'retired callback names the skipped key');
  assertEqual(counts.groupsRetired, 1, 'retired job is counted');
  assertEqual(counts.groupsFiled, 0, 'retired job yields zero filings');
  assertEqual(state.activeFailures[retiredKey].retired, true, 'retired job is persisted with retired=true');

  assertEqual(
    jobNameIsMapped('required-fast / Vitest Workspace', defs),
    true,
    'mapped live job remains fileable',
  );

  const calls = [];
  try {
    fileBugfixPlan(state.activeFailures[retiredKey], {
      repoUrl: 'git@github.com:Neko-Catpital-Labs/Invoker.git',
      jobDefinitions: defs,
      runCommand: (cmd, args) => calls.push([cmd, args]),
    });
    fail('fileBugfixPlan should throw for retired job');
  } catch (err) {
    if (!String(err?.message ?? err).includes('unmapped CI job')) {
      throw err;
    }
  }
  assertEqual(calls, [], 'retired job throws before render/submit commands');
  console.log('[repro-e2e-regression-watch] retired-job scenario: PASS');
}

function testLiveGithubSmokeIfRequested() {
  if (process.env.INVOKER_E2E_REGRESSION_WATCH_LIVE !== '1') {
    console.log('[repro-e2e-regression-watch] live GitHub smoke: SKIP');
    return;
  }
  const runs = listUnprocessedDefaultBranchRuns(0, { branches: ['master'], limit: 1 });
  if (runs.length === 0) fail('live GitHub smoke found no completed master push runs');
  let run = null;
  for (const candidate of listUnprocessedDefaultBranchRuns(0, { branches: ['master'], limit: 10 })) {
    const detail = getCiRun(candidate.databaseId);
    if (detail.headSha && Array.isArray(detail.jobs) && detail.jobs.length > 0) {
      run = detail;
      break;
    }
  }
  if (!run) fail('live GitHub smoke found no completed master push run with jobs');
  const state = loadEmptyState();
  reconcileCiRun(state, run);
  if (!state.heads[run.headSha]) fail('live GitHub smoke did not record run HEAD');
  console.log('[repro-e2e-regression-watch] live GitHub smoke: PASS');
}

function main() {
  testJobClassification();
  testPerHeadFailureDedupAndRecovery();
  testCancelledAndSkippedDoNotClear();
  testEveryFailedJobQueuesSeparately();
  testLiveDedupIsJobScoped();
  testWorkflowCommandMapping();
  testPlanVarsAndDryRunRendering();
  testLiveSubmissionUsesNoTrack();
  testAttemptLedgerScenario();
  testFleetCorrelationScenario();
  testRetiredJobScenario();
  testLiveGithubSmokeIfRequested();
  console.log('[repro-e2e-regression-watch] all checks passed');
}

main();
