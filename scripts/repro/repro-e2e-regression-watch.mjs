#!/usr/bin/env node
// Exercises scripts/e2e-regression-watch.mjs's pure logic (Playwright JSON
// parsing, Day-0 baseline vs. new-regression reconciliation, SHA grouping
// with flaky-pattern debounce, and live-dedup) against fabricated inputs, so
// none of it needs a real CI run or a running Invoker instance to verify.
import {
  parsePlaywrightJson,
  reconcileFailingSet,
  groupBySha,
  buildPlanVars,
  liveQueryHasNonTerminalWork,
  buildMarker,
  loadEmptyState,
} from '../e2e-regression-watch.mjs';

function fail(message) {
  throw new Error(`[repro-e2e-regression-watch] ${message}`);
}

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) fail(`${label}: expected ${e}, got ${a}`);
}

// Mirrors the real shape verified by running packages/app's Playwright config
// with INVOKER_PLAYWRIGHT_JSON_OUTPUT set: suites[] per file, nested
// suites[] for describe blocks, specs[].tests[0].status is post-retry
// ('expected' | 'unexpected' | 'flaky' | 'skipped').
function fakeResultsJson(fileTitle, entries) {
  return JSON.stringify({
    config: {},
    errors: [],
    stats: {},
    suites: [
      {
        title: fileTitle,
        file: fileTitle,
        suites: [
          {
            title: 'suite',
            file: fileTitle,
            specs: entries.map((e) => ({
              title: e.title,
              file: fileTitle,
              line: e.line,
              tests: [{ status: e.status }],
            })),
          },
        ],
        specs: [],
      },
    ],
  });
}

function testParsePlaywrightJson() {
  const raw = fakeResultsJson('e2e/foo.spec.ts', [
    { title: 'does the thing', line: 10, status: 'unexpected' },
    { title: 'does another thing', line: 20, status: 'expected' },
  ]);
  const outcomes = parsePlaywrightJson(raw);
  assertEqual(outcomes.size, 2, 'parsePlaywrightJson: outcome count');
  const failing = outcomes.get('e2e/foo.spec.ts::suite > does the thing');
  if (!failing) fail('parsePlaywrightJson: missing expected testId (nested describe title not joined correctly)');
  assertEqual(failing.status, 'unexpected', 'parsePlaywrightJson: failing test status');
  const passing = outcomes.get('e2e/foo.spec.ts::suite > does another thing');
  assertEqual(passing.status, 'expected', 'parsePlaywrightJson: passing test status');
  console.log('[repro-e2e-regression-watch] parsePlaywrightJson: PASS');
}

function testDayZeroBootstrapNotActionable() {
  const state = loadEmptyState();
  const run = { databaseId: 100, headSha: 'sha-day0', createdAt: '2026-07-01T00:00:00Z' };
  const outcomes = parsePlaywrightJson(
    fakeResultsJson('e2e/known-red.spec.ts', [{ title: 'already broken', line: 5, status: 'unexpected' }]),
  );
  reconcileFailingSet(state, run, outcomes);
  if (!state.dayZero) fail('reconcileFailingSet: dayZero not established on first run');
  const entry = state.failingTests['e2e/known-red.spec.ts::suite > already broken'];
  assertEqual(entry.origin, 'day0-baseline', 'reconcileFailingSet: bootstrap origin');
  const groups = groupBySha(state.failingTests);
  assertEqual(groups.length, 0, 'groupBySha: day0-baseline tests must not be actionable');
  console.log('[repro-e2e-regression-watch] day0 bootstrap not actionable: PASS');
  return state;
}

function testNewRegressionDetectedAndGrouped(stateAfterDayZero) {
  const state = stateAfterDayZero;
  const run = { databaseId: 101, headSha: 'sha-regression-1', createdAt: '2026-07-02T00:00:00Z' };
  const outcomes = parsePlaywrightJson(
    JSON.stringify({
      suites: [
        {
          title: 'e2e/known-red.spec.ts',
          suites: [{ title: 'suite', specs: [{ title: 'already broken', file: 'e2e/known-red.spec.ts', line: 5, tests: [{ status: 'unexpected' }] }] }],
        },
        {
          title: 'e2e/a.spec.ts',
          suites: [{ title: 'suite', specs: [{ title: 'new failure a', file: 'e2e/a.spec.ts', line: 1, tests: [{ status: 'unexpected' }] }] }],
        },
        {
          title: 'e2e/b.spec.ts',
          suites: [{ title: 'suite', specs: [{ title: 'new failure b', file: 'e2e/b.spec.ts', line: 2, tests: [{ status: 'unexpected' }] }] }],
        },
      ],
    }),
  );
  reconcileFailingSet(state, run, outcomes);

  const a = state.failingTests['e2e/a.spec.ts::suite > new failure a'];
  const b = state.failingTests['e2e/b.spec.ts::suite > new failure b'];
  assertEqual(a.origin, 'regression', 'reconcileFailingSet: new test origin');
  assertEqual(a.firstBadSha, 'sha-regression-1', 'reconcileFailingSet: new test firstBadSha');
  assertEqual(b.firstBadSha, 'sha-regression-1', 'reconcileFailingSet: second new test shares firstBadSha');

  const groups = groupBySha(state.failingTests);
  assertEqual(groups.length, 1, 'groupBySha: two tests sharing a SHA must form exactly one group');
  assertEqual(groups[0].tests.length, 2, 'groupBySha: group blast radius');
  console.log('[repro-e2e-regression-watch] new regression detected + grouped by SHA: PASS');
  return state;
}

function testRecoverySkipsAndFlakyDebounce(stateAfterRegression) {
  const state = stateAfterRegression;
  const run = { databaseId: 102, headSha: 'sha-3', createdAt: '2026-07-03T00:00:00Z' };
  const outcomes = parsePlaywrightJson(
    JSON.stringify({
      suites: [
        {
          title: 'e2e/a.spec.ts',
          suites: [{ title: 'suite', specs: [{ title: 'new failure a', file: 'e2e/a.spec.ts', line: 1, tests: [{ status: 'expected' }] }] }],
        },
        {
          title: 'e2e/dag-click-hitch-responsiveness.spec.ts',
          suites: [{ title: 'suite', specs: [{ title: 'flaky-prone', file: 'e2e/dag-click-hitch-responsiveness.spec.ts', line: 1, tests: [{ status: 'unexpected' }] }] }],
        },
      ],
    }),
  );
  reconcileFailingSet(state, run, outcomes);

  if (state.failingTests['e2e/a.spec.ts::suite > new failure a']) {
    fail('reconcileFailingSet: recovered test must be removed from failingTests');
  }

  const flakyKey = 'e2e/dag-click-hitch-responsiveness.spec.ts::suite > flaky-prone';
  assertEqual(state.failingTests[flakyKey].consecutiveFailingPolls, 1, 'flaky test first poll count');
  let groups = groupBySha(state.failingTests);
  const flakyGroup = groups.find((g) => g.sha === 'sha-3');
  if (flakyGroup) fail('groupBySha: flaky-pattern test with 1 consecutive failing poll must be debounced (excluded)');

  const run2 = { databaseId: 103, headSha: 'sha-3', createdAt: '2026-07-04T00:00:00Z' };
  const outcomes2 = parsePlaywrightJson(
    JSON.stringify({
      suites: [
        {
          title: 'e2e/dag-click-hitch-responsiveness.spec.ts',
          suites: [{ title: 'suite', specs: [{ title: 'flaky-prone', file: 'e2e/dag-click-hitch-responsiveness.spec.ts', line: 1, tests: [{ status: 'unexpected' }] }] }],
        },
      ],
    }),
  );
  reconcileFailingSet(state, run2, outcomes2);
  assertEqual(state.failingTests[flakyKey].consecutiveFailingPolls, 2, 'flaky test second poll count');
  groups = groupBySha(state.failingTests);
  const flakyGroupAfterDebounce = groups.find((g) => g.sha === 'sha-3');
  if (!flakyGroupAfterDebounce) fail('groupBySha: flaky-pattern test must become actionable after 2 consecutive failing polls');
  console.log('[repro-e2e-regression-watch] recovery removal + flaky debounce: PASS');
}

function testLiveDedupIsAlwaysLive() {
  const sha = 'sha-dedup-test';
  const fakeNonTerminal = () => JSON.stringify([{ status: 'running', description: `<!-- ${buildMarker(sha)} -->\nsome plan body` }]);
  const fakeTerminal = () => JSON.stringify([{ status: 'completed', description: `<!-- ${buildMarker(sha)} -->\nsome plan body` }]);
  const fakeNoMatch = () => JSON.stringify([{ status: 'running', description: 'unrelated workflow' }]);

  if (!liveQueryHasNonTerminalWork(sha, fakeNonTerminal)) fail('liveQueryHasNonTerminalWork: must return true for a non-terminal match');
  if (liveQueryHasNonTerminalWork(sha, fakeTerminal)) fail('liveQueryHasNonTerminalWork: a completed workflow must not block re-filing');
  if (liveQueryHasNonTerminalWork(sha, fakeNoMatch)) fail('liveQueryHasNonTerminalWork: must return false when no workflow carries the marker');
  console.log('[repro-e2e-regression-watch] live dedup (non-cached) behavior: PASS');
}

function testBuildPlanVars() {
  const group = {
    sha: 'abc123def456abc123def456abc123def456ab1',
    tests: [
      { testId: 'e2e/b.spec.ts::suite > new failure b', file: 'e2e/b.spec.ts', line: 2 },
      { testId: 'e2e/a.spec.ts::suite > new failure a', file: 'e2e/a.spec.ts', line: 1 },
    ],
  };
  const vars = buildPlanVars(group, 'git@github.com:Neko-Catpital-Labs/Invoker.git');
  assertEqual(vars.short_sha, 'abc123d', 'buildPlanVars: short_sha');
  assertEqual(vars.bug_slug, 'e2e-regression-abc123d', 'buildPlanVars: bug_slug');
  assertEqual(vars.primary_file, 'e2e/a.spec.ts', 'buildPlanVars: primary is lowest sorted testId');
  assertEqual(vars.test_count, '2', 'buildPlanVars: test_count');
  if (!vars.marker.includes(group.sha)) fail('buildPlanVars: marker must embed the SHA');
  if (!vars.verify_command.includes('e2e/a.spec.ts:1')) fail('buildPlanVars: verify_command must target the primary test');
  console.log('[repro-e2e-regression-watch] buildPlanVars: PASS');
}

function main() {
  testParsePlaywrightJson();
  const s1 = testDayZeroBootstrapNotActionable();
  const s2 = testNewRegressionDetectedAndGrouped(s1);
  testRecoverySkipsAndFlakyDebounce(s2);
  testLiveDedupIsAlwaysLive();
  testBuildPlanVars();
  console.log('[repro-e2e-regression-watch] all checks passed');
}

main();
