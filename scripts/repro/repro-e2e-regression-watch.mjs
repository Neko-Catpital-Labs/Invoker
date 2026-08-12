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
  fallbackVerifyCommand,
  fileBugfixPlan,
  getActionableFailures,
  getCiRun,
  listUnprocessedDefaultBranchRuns,
  liveQueryHasNonTerminalWork,
  loadEmptyState,
  reconcileCiRun,
  resolveVerifyCommand,
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
  const legacyStuckLeaseCommand = defs.get('playwright / launch-dispatch-stuck-lease').verifyCommand;
  if (!legacyStuckLeaseCommand.includes('e2e/launch-dispatch-stuck-lease-cap.spec.ts')) {
    fail('legacy stuck-lease shard command must include the cap spec');
  }
  if (!legacyStuckLeaseCommand.includes('e2e/launch-dispatch-stuck-lease-storm.spec.ts')) {
    fail('legacy stuck-lease shard command must include the storm spec');
  }
  if (legacyStuckLeaseCommand.includes('No local verify command is mapped')) {
    fail('legacy stuck-lease shard command must not use the fallback verify command');
  }
  if (defs.get('required-fast / Vitest Workspace').verifyCommand !== 'pnpm --filter @invoker/ui build && pnpm --filter @invoker/surfaces build && pnpm --filter @invoker/app build && bash scripts/test-suites/required/10-vitest-workspace.sh') {
    fail('required-fast / Vitest Workspace command changed unexpectedly');
  }
  console.log('[repro-e2e-regression-watch] workflow command mapping: PASS');
}

function testFallbackVerifyCommandDefersResolution() {
  const state = loadEmptyState();
  reconcileCiRun(state, fakeRun(375, 'abc789def456abc123def456abc123def456ab3', [
    fakeJob('playwright / launch-dispatch-stuck-lease', 'failure', 37),
  ]));
  const [failure] = getActionableFailures(state);
  const vars = buildPlanVars(failure, 'git@github.com:Neko-Catpital-Labs/Invoker.git', new Map());
  const expectedFallback = fallbackVerifyCommand('playwright / launch-dispatch-stuck-lease');

  assertEqual(vars.verify_command, expectedFallback, 'unmapped jobs use the deferred fallback command');
  if (vars.verify_command.includes('No local verify command is mapped')) {
    fail('fallback verify command must not be a permanent sentinel');
  }
  if (!vars.verify_command.includes('--exec-verify-command')) {
    fail('fallback verify command must resolve through the current watcher at execution time');
  }
  if (!resolveVerifyCommand('playwright / launch-dispatch-stuck-lease').includes('launch-dispatch-stuck-lease-cap.spec.ts')) {
    fail('current watcher mapping must resolve legacy stuck-lease command');
  }
  console.log('[repro-e2e-regression-watch] fallback verify command defers resolution: PASS');
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
    if (!planText.includes('executionAgent: codex')) fail('fix task must request codex (default claude agent hits the broken SSH pool)');
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
  testFallbackVerifyCommandDefersResolution();
  testPlanVarsAndDryRunRendering();
  testLiveSubmissionUsesNoTrack();
  testLiveGithubSmokeIfRequested();
  console.log('[repro-e2e-regression-watch] all checks passed');
}

main();
