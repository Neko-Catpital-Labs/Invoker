#!/usr/bin/env node
// Watches default-branch `ci.yml` push runs and files one Invoker repair plan
// per active (first-bad SHA, CI job) failure. Local state records observed HEAD
// SHAs and job outcomes; live Invoker workflow state remains the dedup source
// for repairs in flight.
import { execFileSync, execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(__filename));

function resolveYamlModulePath() {
  const localYamlPath = resolve(REPO_ROOT, 'packages/app/node_modules/yaml/dist/index.js');
  if (existsSync(localYamlPath)) return localYamlPath;
  return 'yaml';
}
const { parse: parseYaml } = await import(resolveYamlModulePath());

export const TARGET_REPO = process.env.INVOKER_GITHUB_TARGET_REPO ?? 'Neko-Catpital-Labs/Invoker';
export const WORKFLOW_FILE = process.env.INVOKER_CI_WATCH_WORKFLOW_FILE
  ?? process.env.INVOKER_E2E_WATCH_WORKFLOW_FILE
  ?? 'ci.yml';
export const WATCH_BRANCHES = (process.env.INVOKER_CI_WATCH_BRANCHES ?? 'master,main')
  .split(',')
  .map((branch) => branch.trim())
  .filter(Boolean);
export const RUN_LIST_LIMIT = Number(process.env.INVOKER_CI_WATCH_RUN_LIMIT ?? '50');
export const CAP_PER_SWEEP = Number(process.env.INVOKER_CI_WATCH_CAP
  ?? process.env.INVOKER_E2E_WATCH_CAP
  ?? '0');
export const TERMINAL_WORKFLOW_STATUSES = new Set(['completed', 'failed', 'closed', 'cancelled', 'stale']);
export const BROKEN_JOB_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required']);
export const IGNORED_JOB_CONCLUSIONS = new Set(['cancelled', 'skipped', 'neutral']);
export const MARKER_PREFIX = 'invoker-ci-regression-watch: first-bad-sha=';
export const STATE_SCHEMA_VERSION = 2;

const STATE_DIR = process.env.INVOKER_CI_WATCH_STATE_DIR
  ?? process.env.INVOKER_E2E_WATCH_STATE_DIR
  ?? join(homedir(), '.invoker', 'e2e-regression-watch');
const STATE_FILE = join(STATE_DIR, 'state.json');
const SWEEP_LOG_FILE = join(STATE_DIR, 'sweep-log.jsonl');
const WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', WORKFLOW_FILE);
const BUILD_APP_COMMAND = [
  'pnpm --filter @invoker/ui build',
  'pnpm --filter @invoker/surfaces build',
  'pnpm --filter @invoker/app build',
].join(' && ');

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

export function shortSha(sha) {
  return String(sha).slice(0, 7);
}

export function slugify(value, maxLength = 72) {
  const slug = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return (slug || 'ci-job').slice(0, maxLength).replace(/-+$/g, '') || 'ci-job';
}

export function buildMarker(sha, jobName) {
  return `${MARKER_PREFIX}${sha}; job=${jobName}`;
}

export function buildMarkerComment(sha, jobName) {
  return `<!-- ${buildMarker(sha, jobName)} -->`;
}

export function loadEmptyState() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    lastProcessedRunId: 0,
    heads: {},
    activeFailures: {},
  };
}

export function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || raw.schemaVersion !== STATE_SCHEMA_VERSION) {
    return loadEmptyState();
  }
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    lastProcessedRunId: Number(raw.lastProcessedRunId ?? 0),
    heads: raw.heads && typeof raw.heads === 'object' ? raw.heads : {},
    activeFailures: raw.activeFailures && typeof raw.activeFailures === 'object' ? raw.activeFailures : {},
  };
}

export function classifyJobConclusion(job) {
  if (!job || job.status !== 'completed') return 'pending';
  const conclusion = String(job.conclusion ?? '');
  if (conclusion === 'success') return 'ok';
  if (BROKEN_JOB_CONCLUSIONS.has(conclusion)) return 'broken';
  if (IGNORED_JOB_CONCLUSIONS.has(conclusion)) return 'ignored';
  return 'ignored';
}

export function reconcileCiRun(state, run) {
  const normalized = normalizeState(state);
  const sha = String(run.headSha ?? '').trim();
  if (!sha) return { state: normalized, processedJobs: 0, brokenJobs: 0, okJobs: 0, ignoredJobs: 0 };

  const headRecord = normalized.heads[sha] ?? {
    sha,
    branch: run.headBranch ?? '',
    firstRunId: run.databaseId,
    lastRunId: run.databaseId,
    createdAt: run.createdAt ?? '',
    jobs: {},
  };
  headRecord.branch = run.headBranch ?? headRecord.branch;
  headRecord.lastRunId = run.databaseId ?? headRecord.lastRunId;
  headRecord.updatedAt = new Date().toISOString();
  normalized.heads[sha] = headRecord;

  let processedJobs = 0;
  let brokenJobs = 0;
  let okJobs = 0;
  let ignoredJobs = 0;

  for (const job of run.jobs ?? []) {
    const jobName = typeof job.name === 'string' ? job.name.trim() : '';
    if (!jobName) continue;
    const classification = classifyJobConclusion(job);
    if (classification === 'pending') continue;
    processedJobs += 1;

    const baseObservation = {
      jobName,
      conclusion: job.conclusion ?? '',
      runId: run.databaseId,
      jobDatabaseId: job.databaseId,
      url: job.url ?? '',
      observedAt: job.completedAt ?? job.startedAt ?? run.createdAt ?? '',
    };

    if (classification === 'ok') {
      okJobs += 1;
      headRecord.jobs[jobName] = { ...baseObservation, state: 'ok' };
      delete normalized.activeFailures[jobName];
      continue;
    }

    if (classification === 'broken') {
      brokenJobs += 1;
      headRecord.jobs[jobName] = { ...baseObservation, state: 'broken' };
      const existing = normalized.activeFailures[jobName];
      if (existing) {
        normalized.activeFailures[jobName] = {
          ...existing,
          lastBadSha: sha,
          lastBadRunId: run.databaseId,
          lastJobDatabaseId: job.databaseId,
          lastJobUrl: job.url ?? '',
          lastObservedAt: baseObservation.observedAt,
          occurrences: Number(existing.occurrences ?? 1) + 1,
        };
      } else {
        normalized.activeFailures[jobName] = {
          jobName,
          firstBadSha: sha,
          firstBadRunId: run.databaseId,
          firstBadRunCreatedAt: run.createdAt ?? '',
          firstJobDatabaseId: job.databaseId,
          firstJobUrl: job.url ?? '',
          lastBadSha: sha,
          lastBadRunId: run.databaseId,
          lastJobDatabaseId: job.databaseId,
          lastJobUrl: job.url ?? '',
          lastObservedAt: baseObservation.observedAt,
          occurrences: 1,
        };
      }
      continue;
    }

    ignoredJobs += 1;
    if (!headRecord.jobs[jobName]) {
      headRecord.jobs[jobName] = { ...baseObservation, state: 'ignored' };
    }
  }

  return { state: normalized, processedJobs, brokenJobs, okJobs, ignoredJobs };
}

export function getActionableFailures(state) {
  const normalized = normalizeState(state);
  return Object.values(normalized.activeFailures)
    .filter((failure) => failure && typeof failure.jobName === 'string' && typeof failure.firstBadSha === 'string')
    .sort((a, b) => {
      const runDelta = Number(a.firstBadRunId ?? 0) - Number(b.firstBadRunId ?? 0);
      if (runDelta !== 0) return runDelta;
      return a.jobName.localeCompare(b.jobName);
    });
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function collapseShellLines(value) {
  return String(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' && ');
}

function renderGithubTemplate(value, matrix = {}) {
  return String(value).replace(/\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}/g, (_match, key) => {
    const rendered = matrix[key];
    return rendered == null ? '' : String(rendered);
  });
}

function cartesianProduct(entries) {
  return entries.reduce((acc, [key, values]) => {
    const out = [];
    for (const item of acc) {
      for (const value of values) out.push({ ...item, [key]: value });
    }
    return out;
  }, [{}]);
}

export function expandMatrix(matrix) {
  if (!matrix || typeof matrix !== 'object') return [{}];
  if (Array.isArray(matrix.include) && matrix.include.length > 0) {
    return matrix.include.map((entry) => ({ ...entry }));
  }
  const axes = Object.entries(matrix)
    .filter(([key, value]) => key !== 'include' && Array.isArray(value))
    .map(([key, value]) => [key, value]);
  if (axes.length === 0) return [{}];
  return cartesianProduct(axes);
}

function jobDownloadsBuildArtifacts(job) {
  return (job.steps ?? []).some((step) => {
    const uses = typeof step.uses === 'string' ? step.uses : '';
    return uses.includes('actions/download-artifact');
  });
}

function withBuildPrefix(command, needsBuild) {
  return needsBuild ? `${BUILD_APP_COMMAND} && ${command}` : command;
}

function commandForJob(jobId, job, matrix) {
  const needsBuild = jobDownloadsBuildArtifacts(job);
  if (jobId === 'build-artifacts') return BUILD_APP_COMMAND;
  if (jobId === 'ui-vitest') return 'pnpm --filter @invoker/ui test';
  if (jobId === 'playwright' || jobId === 'playwright-nightly-perf') {
    const labelPrefix = jobId === 'playwright' ? 'ci-playwright' : 'ci-playwright-nightly-perf';
    const command = [
      'env',
      `INVOKER_PLAYWRIGHT_RUN_LABEL=${shellSingleQuote(`${labelPrefix}-${matrix.name}`)}`,
      'INVOKER_PLAYWRIGHT_WORKERS=1',
      `INVOKER_PLAYWRIGHT_FILES=${shellSingleQuote(String(matrix.files ?? '').trim().replace(/\s+/g, ' '))}`,
      `INVOKER_PLAYWRIGHT_ARGS=${shellSingleQuote('--reporter=line')}`,
      'bash scripts/test-suites/optional/40-playwright-app.sh',
    ].join(' ');
    return withBuildPrefix(command, true);
  }
  if (jobId === 'e2e-proof') {
    const command = [
      'env',
      'INVOKER_TEST_ALL_PROOF=1',
      `INVOKER_TEST_ALL_SHARD_INDEX=${shellSingleQuote(String(matrix.shard))}`,
      'INVOKER_TEST_ALL_SHARD_TOTAL=4',
      'INVOKER_TEST_ALL_STATE_FILE=/tmp/invoker-ci-watch-proof-state.tsv',
      'TMPDIR=/tmp/invoker-tmp',
      'bash scripts/run-all-tests.sh',
    ].join(' ');
    return withBuildPrefix(command, true);
  }
  if (jobId === 'e2e-proof-aggregate') {
    return withBuildPrefix(
      'env INVOKER_TEST_ALL_PROOF=1 INVOKER_TEST_ALL_AGGREGATE=1 '
        + 'INVOKER_TEST_ALL_STATE_FILE=/tmp/invoker-ci-watch-merged-proof-state.tsv bash scripts/run-all-tests.sh',
      true,
    );
  }
  if (jobId === 'ssh') return withBuildPrefix(`bash ${shellSingleQuote(matrix.suite)}`, true);
  if (jobId === 'reset-rulebook-repro') {
    return withBuildPrefix('bash scripts/test-suites/required/26-reset-rulebook-proof.sh', true);
  }
  if (jobId === 'scheduled-repros') {
    return withBuildPrefix(
      'bash scripts/test-suites/required/23-fix-intent-repros.sh '
        + '&& pnpm --filter @invoker/app test --run src/__tests__/dispatch-capacity-invariants.test.ts',
      true,
    );
  }
  if (jobId === 'docker') {
    return withBuildPrefix(
      'bash scripts/build-agent-base-image.sh '
        + '&& docker build -t invoker-agent:latest scripts/fixtures/hello-world-agent '
        + '&& bash scripts/test-suites/dangerous/10-docker-comprehensive.sh',
      true,
    );
  }
  if (typeof matrix.command === 'string') return withBuildPrefix(collapseShellLines(matrix.command), needsBuild);

  const runSteps = (job.steps ?? [])
    .map((step) => (typeof step.run === 'string' ? renderGithubTemplate(step.run, matrix) : ''))
    .map(collapseShellLines)
    .filter(Boolean);
  const lastRun = runSteps.at(-1);
  if (lastRun) return withBuildPrefix(lastRun, needsBuild);
  return '';
}

export function buildCiJobDefinitions(workflow = parseYaml(readFileSync(WORKFLOW_PATH, 'utf8'))) {
  const definitions = new Map();
  for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
    for (const matrix of expandMatrix(job.strategy?.matrix)) {
      const jobName = renderGithubTemplate(job.name ?? jobId, matrix).trim();
      if (!jobName) continue;
      definitions.set(jobName, {
        jobId,
        jobName,
        matrix,
        verifyCommand: commandForJob(jobId, job, matrix),
      });
    }
  }
  return definitions;
}

export function fallbackVerifyCommand(jobName) {
  return `bash -lc ${shellSingleQuote(`echo "No local verify command is mapped for CI job: ${jobName}" >&2; exit 1`)}`;
}

export function buildPlanVars(failure, repoUrl, jobDefinitions = buildCiJobDefinitions()) {
  const definition = jobDefinitions.get(failure.jobName);
  const short = shortSha(failure.firstBadSha);
  const jobSlug = `${short}-${slugify(failure.jobName)}`;
  const verifyCommand = definition?.verifyCommand?.trim() || fallbackVerifyCommand(failure.jobName);
  return {
    repo_url: repoUrl,
    base_branch: 'master',
    sha: failure.firstBadSha,
    short_sha: short,
    job_name: failure.jobName,
    job_slug: jobSlug,
    run_id: String(failure.firstBadRunId ?? ''),
    job_database_id: String(failure.firstJobDatabaseId ?? ''),
    job_url: failure.firstJobUrl ?? '',
    last_bad_sha: failure.lastBadSha ?? failure.firstBadSha,
    last_bad_run_id: String(failure.lastBadRunId ?? failure.firstBadRunId ?? ''),
    verify_command: verifyCommand,
    marker: buildMarkerComment(failure.firstBadSha, failure.jobName),
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

export function listUnprocessedDefaultBranchRuns(
  lastProcessedRunId,
  { branches = WATCH_BRANCHES, limit = RUN_LIST_LIMIT } = {},
) {
  const byId = new Map();
  for (const branch of branches) {
    const runs = ghJson([
      'run', 'list', '--repo', TARGET_REPO, '--workflow', WORKFLOW_FILE,
      '--branch', branch, '--event', 'push', '--status', 'completed',
      '--json', 'databaseId,headSha,headBranch,event,status,conclusion,createdAt,updatedAt',
      '--limit', String(limit),
    ]);
    for (const run of runs) {
      if (Number(run.databaseId) > Number(lastProcessedRunId)) byId.set(run.databaseId, run);
    }
  }
  return Array.from(byId.values()).sort((a, b) => Number(a.databaseId) - Number(b.databaseId));
}

export function getCiRun(runId) {
  return ghJson([
    'run', 'view', String(runId), '--repo', TARGET_REPO,
    '--json', 'databaseId,headSha,headBranch,event,status,conclusion,createdAt,jobs',
  ]);
}

function headlessQueryWorkflowsJson() {
  return execSync(
    `source "${join(REPO_ROOT, 'scripts', 'headless-lib.sh')}" && headless_query query workflows --output json`,
    {
      shell: '/bin/bash',
      encoding: 'utf8',
      cwd: REPO_ROOT,
      timeout: 90_000,
      killSignal: 'SIGKILL',
    },
  );
}

export function liveQueryHasNonTerminalWork(failureOrSha, jobName, queryFn = headlessQueryWorkflowsJson) {
  const sha = typeof failureOrSha === 'object' ? failureOrSha.firstBadSha : failureOrSha;
  const job = typeof failureOrSha === 'object' ? failureOrSha.jobName : jobName;
  const marker = buildMarker(sha, job);
  let workflows;
  try {
    workflows = JSON.parse(queryFn());
  } catch (err) {
    // A bad query response (truncated output, transient CLI failure, ...)
    // must not crash the whole sweep and must not risk filing a duplicate
    // fix for work that may already be running -- fail closed by assuming
    // non-terminal work exists, so this one failure is skipped this round
    // and picked back up on the next sweep once the query is healthy again.
    console.error(`ci-regression-watch: liveQueryHasNonTerminalWork query failed for marker "${marker}", assuming non-terminal work exists: ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
  const items = Array.isArray(workflows)
    ? workflows
    : Array.isArray(workflows?.items)
      ? workflows.items
      : null;
  if (items === null) {
    // Valid JSON that isn't the expected shape (e.g. `null`, a bare object
    // without an `items` array) -- fail closed the same way a parse error
    // does, instead of throwing past this function's own try/catch.
    console.error(`ci-regression-watch: liveQueryHasNonTerminalWork received an invalid response shape for marker "${marker}", assuming non-terminal work exists`);
    return true;
  }
  return items.some(
    (w) => !TERMINAL_WORKFLOW_STATUSES.has(w.status)
      && typeof w.description === 'string'
      && w.description.includes(marker),
  );
}

export function fileBugfixPlan(failure, opts = {}) {
  const repoUrl = opts.repoUrl ?? getRepoUrl();
  const vars = buildPlanVars(failure, repoUrl, opts.jobDefinitions);
  const outDir = join(opts.outRoot ?? join(REPO_ROOT, 'plans', 'rendered'), vars.job_slug);
  const varArgs = Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}=${v}`]);
  const run = opts.runCommand ?? runCommand;
  run('bash', [join(REPO_ROOT, 'skills/plan-to-invoker/scripts/render-formula.sh'), 'ci-regression-watch', ...varArgs, '--out', outDir]);
  const planPath = join(outDir, 'ci-regression-watch.yaml');
  run('bash', [join(REPO_ROOT, 'skills/plan-to-invoker/scripts/skill-doctor.sh'), planPath]);
  if (!opts.dryRun) run('bash', [join(REPO_ROOT, 'submit-plan.sh'), planPath, '--no-track']);
  return { planPath, vars, submitted: !opts.dryRun };
}

export function loadState() {
  if (!existsSync(STATE_FILE)) return loadEmptyState();
  return normalizeState(JSON.parse(readFileSync(STATE_FILE, 'utf8')));
}

export function saveState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(normalizeState(state), null, 2));
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
  const jobDefinitions = buildCiJobDefinitions();
  const dryRun = process.env.INVOKER_CI_WATCH_DRY_RUN === '1'
    || process.env.INVOKER_E2E_WATCH_DRY_RUN === '1';

  const runs = listUnprocessedDefaultBranchRuns(state.lastProcessedRunId);
  let runsProcessed = 0;
  let jobsProcessed = 0;
  let jobsBroken = 0;
  let jobsOk = 0;
  let jobsIgnored = 0;
  for (const runSummary of runs) {
    const run = getCiRun(runSummary.databaseId);
    const result = reconcileCiRun(state, run);
    runsProcessed += 1;
    jobsProcessed += result.processedJobs;
    jobsBroken += result.brokenJobs;
    jobsOk += result.okJobs;
    jobsIgnored += result.ignoredJobs;
    state.lastProcessedRunId = Math.max(Number(state.lastProcessedRunId), Number(run.databaseId));
    saveState(state);
  }

  const failures = getActionableFailures(state);
  const toFile = [];
  let groupsSkippedAlreadyAddressed = 0;
  let groupsDeferredByCap = 0;
  for (const failure of failures) {
    if (liveQueryHasNonTerminalWork(failure)) {
      groupsSkippedAlreadyAddressed += 1;
      continue;
    }
    if (CAP_PER_SWEEP <= 0 || toFile.length < CAP_PER_SWEEP) {
      toFile.push(failure);
    } else {
      groupsDeferredByCap += 1;
    }
  }

  for (const failure of toFile) {
    fileBugfixPlan(failure, { repoUrl, jobDefinitions, dryRun });
  }

  appendSweepLog({
    runsProcessed,
    jobsProcessed,
    jobsBroken,
    jobsOk,
    jobsIgnored,
    groupsFound: failures.length,
    groupsFiled: toFile.length,
    groupsSkippedAlreadyAddressed,
    groupsDeferredByCap,
    dryRun,
  });
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error('ci-regression-watch: fatal error', err);
    process.exitCode = 1;
  });
}
