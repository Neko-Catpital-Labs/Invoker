#!/usr/bin/env node
// Watches the `playwright` job on master for new e2e regressions and files a
// bug-fix Invoker plan for each one.
//
// Local state (~/.invoker/e2e-regression-watch/state.json) is a mutable
// snapshot of "what's currently red and since when" — it is NOT a ledger of
// fixes-in-flight. Whether a regression already has an open fix is always
// answered by a live query against Invoker's workflow store
// (liveQueryHasNonTerminalWork), never by anything cached here. GitHub
// Actions has no "since when has this been red" API, so this state is the
// only way to compute "is this a new regression" and "which commit did it
// start at" — do not reach for cron-pr-lib.sh's ledger primitives here, they
// solve a different problem (fix-in-flight dedup, which must stay live).
import { execFileSync, execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(__filename));

export const TARGET_REPO = process.env.INVOKER_GITHUB_TARGET_REPO ?? 'Neko-Catpital-Labs/Invoker';
export const WORKFLOW_FILE = process.env.INVOKER_E2E_WATCH_WORKFLOW_FILE ?? 'ci.yml';
export const CAP_PER_SWEEP = Number(process.env.INVOKER_E2E_WATCH_CAP ?? '3');
export const FLAKY_DEBOUNCE_POLLS = 2;
export const FLAKY_FILE_PATTERNS = [/-responsiveness\.spec\.ts$/, /visual.*\.spec\.ts$/, /^storm-scale-.*\.spec\.ts$/];
export const TERMINAL_WORKFLOW_STATUSES = new Set(['completed', 'failed', 'closed']);
export const MARKER_PREFIX = 'invoker-e2e-regression-watch: first-bad-sha=';

const STATE_DIR = process.env.INVOKER_E2E_WATCH_STATE_DIR ?? join(homedir(), '.invoker', 'e2e-regression-watch');
const STATE_FILE = join(STATE_DIR, 'state.json');
const SWEEP_LOG_FILE = join(STATE_DIR, 'sweep-log.jsonl');

// ---------------------------------------------------------------------------
// Pure logic (no I/O) — exercised directly by scripts/repro/repro-e2e-regression-watch.mjs
// ---------------------------------------------------------------------------

export function isFlakyProneTest(file) {
  const base = file.split('/').pop() ?? file;
  return FLAKY_FILE_PATTERNS.some((re) => re.test(base));
}

export function buildTestId(file, titlePath) {
  return `${file}::${titlePath.join(' > ')}`;
}

export function buildMarker(sha) {
  return `${MARKER_PREFIX}${sha}`;
}

export function shortSha(sha) {
  return sha.slice(0, 7);
}

// Playwright JSON reporter shape (verified against a real run of
// packages/app's config): { config, suites[], errors[], stats }. Each
// suites[] entry is a per-file suite; specs live either directly under it or
// under nested suites[] (describe blocks). spec.tests[0].status is the
// POST-RETRY outcome — 'expected' | 'unexpected' | 'flaky' | 'skipped' — not
// the same as results[].status (per-attempt pass/fail/timedOut/...).
// 'unexpected' is the only status that means "red after exhausting retries".
export function parsePlaywrightJson(raw) {
  const data = JSON.parse(raw);
  const outcomes = new Map();
  const walk = (suite, ancestorTitles) => {
    for (const spec of suite.specs ?? []) {
      const test = spec.tests?.[0];
      if (!test) continue;
      const titlePath = [...ancestorTitles, spec.title];
      outcomes.set(buildTestId(spec.file, titlePath), {
        file: spec.file,
        line: spec.line,
        title: spec.title,
        status: test.status,
      });
    }
    for (const child of suite.suites ?? []) {
      walk(child, [...ancestorTitles, child.title]);
    }
  };
  for (const suite of data.suites ?? []) walk(suite, []);
  return outcomes;
}

export function loadEmptyState() {
  return { schemaVersion: 1, lastProcessedRunId: 0, dayZero: null, failingTests: {} };
}

// Mutates and returns state.failingTests. Only reconciles testIds actually
// present in `outcomes` this run — a test missing from outcomes (e.g. a
// partial artifact download) is left untouched rather than assumed recovered.
export function reconcileFailingSet(state, run, outcomes) {
  const bootstrap = !state.dayZero;
  if (bootstrap) {
    state.dayZero = { establishedAtRunId: run.databaseId, establishedAt: run.createdAt };
    state.failingTests = {};
  }
  for (const [testId, o] of outcomes) {
    const failed = o.status === 'unexpected';
    const existing = state.failingTests[testId];
    if (failed) {
      if (existing) {
        existing.consecutiveFailingPolls += 1;
      } else {
        state.failingTests[testId] = {
          file: o.file,
          line: o.line,
          firstBadSha: run.headSha,
          firstBadRunId: run.databaseId,
          consecutiveFailingPolls: 1,
          origin: bootstrap ? 'day0-baseline' : 'regression',
        };
      }
    } else if (existing) {
      delete state.failingTests[testId];
    }
  }
  return state.failingTests;
}

// Groups regression-origin failing tests by first-bad SHA (the root-cause
// identity), applying the flaky-pattern debounce, sorted by blast radius desc.
export function groupBySha(failingTests) {
  const groups = new Map();
  for (const [testId, info] of Object.entries(failingTests)) {
    if (info.origin !== 'regression') continue;
    if (isFlakyProneTest(info.file) && info.consecutiveFailingPolls < FLAKY_DEBOUNCE_POLLS) continue;
    if (!groups.has(info.firstBadSha)) groups.set(info.firstBadSha, []);
    groups.get(info.firstBadSha).push({ testId, ...info });
  }
  return Array.from(groups.entries())
    .map(([sha, tests]) => ({ sha, tests }))
    .sort((a, b) => b.tests.length - a.tests.length);
}

export function buildPlanVars(group, repoUrl) {
  const sorted = [...group.tests].sort((a, b) => a.testId.localeCompare(b.testId));
  const primary = sorted[0];
  const short = shortSha(group.sha);
  const primaryTitle = primary.testId.split('::')[1] ?? primary.testId;
  const summary = sorted
    .map((t) => `${t.file}:${t.line} - ${t.testId.split('::')[1] ?? t.testId}`)
    .join('\n');
  return {
    repo_url: repoUrl,
    base_branch: 'master',
    sha: group.sha,
    short_sha: short,
    bug_slug: `e2e-regression-${short}`,
    test_count: String(group.tests.length),
    primary_file: primary.file,
    primary_line: String(primary.line),
    primary_title: primaryTitle,
    verify_command: `pnpm --filter @invoker/app exec xvfb-run --auto-servernum playwright test ${primary.file}:${primary.line}`,
    affected_tests_summary: summary,
    marker: `<!-- ${buildMarker(group.sha)} -->`,
  };
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

function runCommand(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', cwd: REPO_ROOT, ...opts });
}

function ghJson(args) {
  const raw = execFileSync('gh', args, { encoding: 'utf8', cwd: REPO_ROOT });
  return JSON.parse(raw);
}

export function getRepoUrl() {
  return execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', cwd: REPO_ROOT }).trim();
}

export function listUnprocessedMasterRuns(lastProcessedRunId) {
  const runs = ghJson([
    'run', 'list', '--repo', TARGET_REPO, '--workflow', WORKFLOW_FILE,
    '--branch', 'master', '--event', 'push', '--status', 'completed',
    '--json', 'databaseId,headSha,createdAt', '--limit', '50',
  ]);
  return runs
    .filter((r) => r.databaseId > lastProcessedRunId)
    .sort((a, b) => a.databaseId - b.databaseId);
}

// Returns 'ran' (job completed, results expected), 'skipped' (upstream job
// failed so playwright never ran), or 'missing' (job not found on this run).
export function getPlaywrightJobConclusion(runId) {
  const view = ghJson(['run', 'view', String(runId), '--repo', TARGET_REPO, '--json', 'jobs']);
  const jobs = (view.jobs ?? []).filter((j) => typeof j.name === 'string' && j.name.startsWith('playwright /'));
  if (jobs.length === 0) return 'missing';
  if (jobs.some((j) => j.conclusion === 'skipped')) return 'skipped';
  return 'ran';
}

function findResultsJsonFiles(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name === 'results.json') found.push(p);
    }
  };
  walk(root);
  return found;
}

export function downloadAndParseShardResults(runId) {
  const dir = mkdtempSync(join(tmpdir(), `invoker-e2e-watch-run-${runId}-`));
  execFileSync('gh', ['run', 'download', String(runId), '--repo', TARGET_REPO, '--pattern', 'playwright-artifacts-*', '--dir', dir]);
  const merged = new Map();
  for (const file of findResultsJsonFiles(dir)) {
    for (const [testId, outcome] of parsePlaywrightJson(readFileSync(file, 'utf8'))) {
      merged.set(testId, outcome);
    }
  }
  return merged;
}

function headlessQueryWorkflowsJson() {
  return execSync(
    `source "${join(REPO_ROOT, 'scripts', 'headless-lib.sh')}" && headless_query query workflows --output json`,
    { shell: '/bin/bash', encoding: 'utf8', cwd: REPO_ROOT },
  );
}

export function liveQueryHasNonTerminalWork(sha, queryFn = headlessQueryWorkflowsJson) {
  const marker = buildMarker(sha);
  const workflows = JSON.parse(queryFn());
  return workflows.some(
    (w) => !TERMINAL_WORKFLOW_STATUSES.has(w.status) && typeof w.description === 'string' && w.description.includes(marker),
  );
}

export function fileBugfixPlan(group, opts = {}) {
  const repoUrl = opts.repoUrl ?? getRepoUrl();
  const vars = buildPlanVars(group, repoUrl);
  const outDir = join(opts.outRoot ?? join(REPO_ROOT, 'plans', 'rendered'), vars.short_sha);
  const varArgs = Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}=${v}`]);
  runCommand('bash', [join(REPO_ROOT, 'skills/plan-to-invoker/scripts/render-formula.sh'), 'e2e-master-regression', ...varArgs, '--out', outDir]);
  const planPath = join(outDir, 'e2e-master-regression.yaml');
  runCommand('bash', [join(REPO_ROOT, 'skills/plan-to-invoker/scripts/skill-doctor.sh'), planPath]);
  runCommand('bash', [join(REPO_ROOT, 'submit-plan.sh'), planPath]);
  return { planPath, vars };
}

export function loadState() {
  if (!existsSync(STATE_FILE)) return loadEmptyState();
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
}

export function saveState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function appendSweepLog(entry) {
  mkdirSync(STATE_DIR, { recursive: true });
  appendFileSync(SWEEP_LOG_FILE, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function main() {
  const state = loadState();
  const repoUrl = getRepoUrl();

  const runs = listUnprocessedMasterRuns(state.lastProcessedRunId);
  let runsProcessed = 0;
  for (const run of runs) {
    const conclusion = getPlaywrightJobConclusion(run.databaseId);
    if (conclusion === 'ran') {
      const outcomes = downloadAndParseShardResults(run.databaseId);
      reconcileFailingSet(state, run, outcomes);
      runsProcessed += 1;
    }
    state.lastProcessedRunId = run.databaseId;
    saveState(state);
  }

  const groups = groupBySha(state.failingTests);
  const toFile = [];
  let groupsSkippedAlreadyAddressed = 0;
  let groupsDeferredByCap = 0;
  for (const group of groups) {
    if (liveQueryHasNonTerminalWork(group.sha)) {
      groupsSkippedAlreadyAddressed += 1;
      continue;
    }
    if (toFile.length < CAP_PER_SWEEP) {
      toFile.push(group);
    } else {
      groupsDeferredByCap += 1;
    }
  }

  for (const group of toFile) {
    fileBugfixPlan(group, { repoUrl });
  }

  appendSweepLog({
    runsProcessed,
    groupsFound: groups.length,
    groupsFiled: toFile.length,
    groupsSkippedAlreadyAddressed,
    groupsDeferredByCap,
  });
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error('e2e-regression-watch: fatal error', err);
    process.exitCode = 1;
  });
}
