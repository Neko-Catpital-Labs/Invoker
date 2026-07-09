import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { resolveRepoRoot, type Logger } from '@invoker/contracts';

import { resolveExecutableOnCurrentPath } from '../process-utils.js';
import type { PrMaintenanceLedger } from './pr-maintenance-ledger.js';

export const CODERABBIT_ADDRESS_WORKER_KIND = 'coderabbit-address';
export const PR_CONFLICT_REBASE_WORKER_KIND = 'pr-conflict-rebase';

export type PrMaintenanceWorkerKind =
  | typeof CODERABBIT_ADDRESS_WORKER_KIND
  | typeof PR_CONFLICT_REBASE_WORKER_KIND;

const PR_CRON_WORKDIR_STAMP_NAME = '.invoker-pr-cron-last-used';
const LOG_MODULE = 'pr-maintenance-worker';

type EnvOverrides = Record<string, string | undefined>;

/** Launch configuration for the PR-maintenance workers (owner-side, from user config). */
export interface PrMaintenanceWorkerConfig {
  /** Repository root that owns the Invoker checkout. Defaults to the current Invoker repo root. */
  repoRoot?: string;
  /** Environment overrides applied over `process.env`. `undefined` removes a variable. */
  env?: EnvOverrides;
  /** Poll cadence for both PR-maintenance workers. Defaults to five minutes. */
  intervalMs?: number;
  /** Shared cron lock path. Defaults to `${TMPDIR:-/tmp}/invoker-pr-crons.lock`. */
  lockPath?: string;
  /**
   * Retained for configuration compatibility with the previous shell-launch
   * backend; the native backend no longer spawns a shell entrypoint.
   */
  shell?: string;
}

/** Fully-resolved tunables shared by both PR-maintenance jobs. */
export interface ResolvedPrMaintenanceConfig {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  targetRepo: string;
  prAuthor: string;
  coderabbitLogin: string;
  dryRun: boolean;
  lockPath: string;
  staleLockSeconds: number;
  coderabbitStateFile: string;
  conflictStateFile: string;
  maxCoderabbitAttempts: number;
  workdir: string;
  workdirMaxAgeDays: number;
  maxRebaseAttempts: number;
  confirmTimeoutSeconds: number;
  ompCommand: string;
  ompModel?: string;
  ompTimeout: string;
}

/** Review-gate record for a PR (subset the jobs consume). */
export interface ReviewGateRecord {
  workflowId?: string;
  workflowGeneration?: number;
  [key: string]: unknown;
}

/** One CodeRabbit comment normalized for the omp context file. */
export interface CoderabbitComment {
  body: string;
  updated_at: string;
  path: string | null;
  html_url: string | null;
}

/** Everything the omp launcher needs to address one PR's CodeRabbit feedback. */
export interface CoderabbitOmpRequest {
  prNumber: string;
  prTitle: string;
  prBody: string;
  headBranch: string;
  baseBranch: string;
  comments: CoderabbitComment[];
  tasks: unknown;
}

export interface PrMaintenanceGitHubClient {
  /** `gh pr list --author ... --state open --json <fields>`; null when the listing failed. */
  listOpenAuthoredPrs(fields: string[]): Promise<Array<Record<string, unknown>> | null>;
  /** CodeRabbit inline + summary comments for a PR, already filtered to the CodeRabbit login. */
  collectCoderabbitComments(prNumber: string): Promise<CoderabbitComment[]>;
  /** `.body` from `gh pr view`, or '' when unavailable. */
  getPrBody(prNumber: string): Promise<string>;
  /** `gh pr comment`; true when the comment posted. */
  postPrComment(prNumber: string, body: string): Promise<boolean>;
}

export interface PrMaintenanceOwnerClient {
  /** Review-gate lookup for a PR; null on lookup failure, a record (possibly `{}`) on success. */
  resolveWorkflowForPr(prNumber: string): Promise<ReviewGateRecord | null>;
  /** The Invoker tasks that produced the PR; null when unavailable or invalid. */
  queryWorkflowTasks(workflowId: string): Promise<unknown>;
  /** Current workflow generation; undefined when unavailable. */
  queryWorkflowGeneration(workflowId: string): Promise<number | undefined>;
  /** Dispatch `rebase-recreate` for a workflow; true when the owner accepted the dispatch. */
  dispatchRebaseRecreate(workflowId: string): Promise<boolean>;
}

export interface PrMaintenanceOmpClient {
  /**
   * Prepare a checkout of the PR head branch and run omp against the CodeRabbit
   * feedback. Returns true when omp addressed the feedback (exit 0). Throws when
   * the checkout could not be prepared.
   */
  addressCoderabbitFeedback(request: CoderabbitOmpRequest): Promise<boolean>;
}

export interface PrMaintenanceClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** Injectable seams for the native PR-maintenance backend. */
export interface PrMaintenanceBackendDeps {
  github: PrMaintenanceGitHubClient;
  owner: PrMaintenanceOwnerClient;
  omp: PrMaintenanceOmpClient;
  clock: PrMaintenanceClock;
  /** Prune stale PR checkout workdirs (CodeRabbit job only). */
  pruneStaleWorkdirs(root: string, maxAgeDays: number): void;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

// ── Config resolution ──────────────────────────────────────────────────────

function readIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** Build the child env and resolve every tunable, mirroring `cron-pr-lib.sh`. */
export function resolvePrMaintenanceRuntime(config: PrMaintenanceWorkerConfig): ResolvedPrMaintenanceConfig {
  const repoRoot = config.repoRoot ? resolve(config.repoRoot) : resolveRepoRoot(process.cwd());
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(config.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  env.INVOKER_REPO_ROOT = repoRoot;

  const tmpRoot = env.TMPDIR && env.TMPDIR.length > 0 ? env.TMPDIR : '/tmp';
  const lockPath = config.lockPath ?? env.INVOKER_PR_CRON_LOCK ?? resolve(tmpRoot, 'invoker-pr-crons.lock');
  env.INVOKER_PR_CRON_LOCK = lockPath;

  const home = env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
  return {
    repoRoot,
    env,
    targetRepo: env.INVOKER_GITHUB_TARGET_REPO || 'Neko-Catpital-Labs/Invoker',
    prAuthor: env.INVOKER_PR_CRON_AUTHOR || 'EdbertChan',
    coderabbitLogin: env.INVOKER_CODERABBIT_LOGIN || 'coderabbitai[bot]',
    dryRun: env.INVOKER_PR_CRON_DRY_RUN === '1',
    lockPath,
    staleLockSeconds: readIntEnv(env.INVOKER_PR_CRON_LOCK_STALE_SECS, 3600),
    coderabbitStateFile:
      env.INVOKER_PR_CODERABBIT_STATE_FILE || join(home, '.invoker', 'coderabbit-address-submissions.tsv'),
    conflictStateFile:
      env.INVOKER_PR_CONFLICT_STATE_FILE || join(home, '.invoker', 'pr-conflict-rebase-submissions.tsv'),
    maxCoderabbitAttempts: readIntEnv(env.INVOKER_PR_CODERABBIT_MAX_ATTEMPTS, 3),
    workdir: env.INVOKER_PR_CRON_WORKDIR || join(home, '.invoker', 'pr-cron-work'),
    workdirMaxAgeDays: readIntEnv(env.INVOKER_PR_CRON_WORKDIR_MAX_AGE_DAYS, 7),
    maxRebaseAttempts: readIntEnv(env.INVOKER_PR_REBASE_MAX_ATTEMPTS, 3),
    confirmTimeoutSeconds: readIntEnv(env.INVOKER_PR_REBASE_CONFIRM_TIMEOUT, 120),
    ompCommand: env.INVOKER_OMP_COMMAND || 'omp',
    ompModel: env.INVOKER_PR_CRON_OMP_MODEL && env.INVOKER_PR_CRON_OMP_MODEL.length > 0
      ? env.INVOKER_PR_CRON_OMP_MODEL
      : undefined,
    ompTimeout: env.INVOKER_PR_CRON_OMP_TIMEOUT || '45m',
  };
}

// ── Subprocess helpers (default seams) ──────────────────────────────────────

function execCapture(
  command: string,
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv },
): Promise<ExecResult> {
  const { promise, resolve: settle } = Promise.withResolvers<ExecResult>();
  let child: ChildProcess;
  try {
    child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    settle({ stdout: '', stderr: String(err), exitCode: null });
    return promise;
  }
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  child.once('error', (err) => settle({ stdout, stderr: `${stderr}${String(err)}`, exitCode: null }));
  child.once('close', (code) => settle({ stdout, stderr, exitCode: code }));
  return promise;
}

/** `gh` with one retry on transient failure — the native port of `gh_json`. */
async function ghWithRetry(
  args: string[],
  env: NodeJS.ProcessEnv,
  clock: PrMaintenanceClock,
): Promise<ExecResult> {
  let result = await execCapture('gh', args, { env });
  if (result.exitCode !== 0) {
    await clock.sleep(2000);
    result = await execCapture('gh', args, { env });
  }
  return result;
}

function parseJsonArray(raw: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
}

/**
 * `gh api --paginate` concatenates one JSON array per page. Merge them the way
 * `jq -s 'add // []'` does, tolerating a single combined array too.
 */
function mergePaginatedArrays(raw: string): Array<Record<string, unknown>> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  const direct = parseJsonArray(trimmed);
  if (direct.length > 0 || trimmed === '[]') return direct;
  const merged: Array<Record<string, unknown>> = [];
  for (const chunk of trimmed.split(/(?<=\])\s*(?=\[)/)) {
    merged.push(...parseJsonArray(chunk));
  }
  return merged;
}

// ── Default seam implementations ────────────────────────────────────────────

function createDefaultGitHubClient(
  config: ResolvedPrMaintenanceConfig,
  clock: PrMaintenanceClock,
): PrMaintenanceGitHubClient {
  const { env, targetRepo, prAuthor, coderabbitLogin } = config;
  return {
    async listOpenAuthoredPrs(fields) {
      const result = await ghWithRetry(
        ['pr', 'list', '--repo', targetRepo, '--author', prAuthor, '--state', 'open',
          '--json', fields.join(','), '--limit', '100'],
        env,
        clock,
      );
      if (result.exitCode !== 0) return null;
      return parseJsonArray(result.stdout);
    },
    async collectCoderabbitComments(prNumber) {
      const inline = await ghWithRetry(
        ['api', `repos/${targetRepo}/pulls/${prNumber}/comments`, '--paginate'], env, clock);
      const summary = await ghWithRetry(
        ['api', `repos/${targetRepo}/issues/${prNumber}/comments`, '--paginate'], env, clock);
      const all = [...mergePaginatedArrays(inline.stdout), ...mergePaginatedArrays(summary.stdout)];
      const comments: CoderabbitComment[] = [];
      for (const raw of all) {
        const user = raw.user as { login?: string } | undefined;
        if (user?.login !== coderabbitLogin) continue;
        comments.push({
          body: typeof raw.body === 'string' ? raw.body : '',
          updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : '',
          path: typeof raw.path === 'string' ? raw.path : null,
          html_url: typeof raw.html_url === 'string' ? raw.html_url : null,
        });
      }
      return comments;
    },
    async getPrBody(prNumber) {
      const result = await ghWithRetry(
        ['pr', 'view', prNumber, '--repo', targetRepo, '--json', 'title,body,headRefName,baseRefName'],
        env,
        clock,
      );
      if (result.exitCode !== 0) return '';
      try {
        const parsed = JSON.parse(result.stdout) as { body?: string };
        return typeof parsed.body === 'string' ? parsed.body : '';
      } catch {
        return '';
      }
    },
    async postPrComment(prNumber, body) {
      const result = await ghWithRetry(
        ['pr', 'comment', prNumber, '--repo', targetRepo, '--body', body], env, clock);
      return result.exitCode === 0;
    },
  };
}

function createDefaultOwnerClient(config: ResolvedPrMaintenanceConfig): PrMaintenanceOwnerClient {
  const { env, repoRoot } = config;
  const runnerQuery = async (args: string[]): Promise<ExecResult> =>
    execCapture(join(repoRoot, 'run.sh'), ['--headless', 'query', ...args], { env });

  return {
    async resolveWorkflowForPr(prNumber) {
      const override = env.INVOKER_PR_CRON_REVIEW_GATE_CMD;
      const result = override
        ? await execCapture(override, [prNumber], { env })
        : await runnerQuery(['review-gate', prNumber, '--output', 'json']);
      if (result.exitCode !== 0) return null;
      try {
        return JSON.parse(result.stdout) as ReviewGateRecord;
      } catch {
        return {};
      }
    },
    async queryWorkflowTasks(workflowId) {
      const result = await runnerQuery(['tasks', '--workflow', workflowId, '--output', 'json']);
      if (result.exitCode !== 0) return null;
      try {
        return JSON.parse(result.stdout);
      } catch {
        return null;
      }
    },
    async queryWorkflowGeneration(workflowId) {
      const result = await runnerQuery(['workflow', workflowId, '--output', 'json']);
      if (result.exitCode !== 0) return undefined;
      try {
        const parsed = JSON.parse(result.stdout) as { generation?: number };
        return typeof parsed.generation === 'number' ? parsed.generation : undefined;
      } catch {
        return undefined;
      }
    },
    async dispatchRebaseRecreate(workflowId) {
      const ipcHelper = env.INVOKER_HEADLESS_IPC_HELPER || join(repoRoot, 'scripts', 'headless-ipc.js');
      const result = await execCapture('node', [ipcHelper, 'exec', '--', 'rebase-recreate', workflowId], { env });
      return result.exitCode === 0;
    },
  };
}

/** The omp prompt for addressing CodeRabbit feedback (native port of `build_prompt`). */
function buildCoderabbitPrompt(
  prNumber: string,
  baseBranch: string,
  headBranch: string,
  ctxFile: string,
  targetRepo: string,
): string {
  return `You are addressing CodeRabbit review feedback on GitHub PR #${prNumber} in repository ${targetRepo}.
You are running inside a fresh checkout of the PR head branch (${headBranch}); HEAD is already on that
branch and 'git push' updates the PR.

Context for this PR is in the JSON file: ${ctxFile}
Fields: .pr, .prTitle, .prBody, .headBranch, .baseBranch,
        .coderabbitComments (array of {body, updated_at, path, html_url}),
        .invokerTasks (the Invoker tasks that produced this PR, or null if none).

Do this:
1. Read the CodeRabbit comments in ${ctxFile}. Also read the actual change under review:
   'git log origin/${baseBranch}..HEAD' and 'git diff origin/${baseBranch}...HEAD', plus the Invoker task list.
2. For EACH distinct CodeRabbit concern, decide whether it is genuinely valid (a real bug,
   correctness, or safety issue) — not style noise or a false positive.
3. For each concern you judge VALID:
   a. Add a bash repro at scripts/repro/repro-coderabbit-pr${prNumber}-<slug>.sh that reproduces the
      finding and exits NON-ZERO on the buggy behavior (follow scripts/repro/ convention:
      'set -euo pipefail', derive the repo root, print a clear PASS/FAIL).
   b. Implement the minimal fix so the repro passes.
4. For concerns you judge NOT valid, take no code action.
5. Commit the repro(s) + fix(es) with a clear message and 'git push' to the PR head branch.

Constraints: change ONLY what the valid concerns require. Do NOT reformat unrelated code, bump
versions, or touch files outside a concern's scope. If NO concern is valid, make no commit and
exit without pushing.
`;
}

function createDefaultOmpClient(
  config: ResolvedPrMaintenanceConfig,
  logger: Logger,
): PrMaintenanceOmpClient {
  const { env, repoRoot, targetRepo, workdir, ompCommand, ompModel, ompTimeout } = config;
  const fields = { module: LOG_MODULE, worker: CODERABBIT_ADDRESS_WORKER_KIND };

  const gitSequence = async (cwd: string, commands: string[][]): Promise<boolean> => {
    for (const args of commands) {
      const result = await execCapture('git', args, { cwd, env });
      if (result.exitCode !== 0) return false;
    }
    return true;
  };

  const prepareCheckout = async (prNumber: string): Promise<string> => {
    const dir = join(workdir, prNumber);
    mkdirSync(workdir, { recursive: true });
    if (!existsSync(join(dir, '.git'))) {
      rmSync(dir, { recursive: true, force: true });
      const clone = await execCapture('gh', ['repo', 'clone', targetRepo, dir, '--', '--quiet'], { env });
      if (clone.exitCode !== 0) {
        logger.error(`[worker:${CODERABBIT_ADDRESS_WORKER_KIND}] PR #${prNumber}: clone failed`, fields);
        throw new Error(`coderabbit-address checkout failed for PR #${prNumber}: clone failed`);
      }
    } else if (!(await gitSequence(dir, [['reset', '--hard'], ['clean', '-fd']]))) {
      logger.error(`[worker:${CODERABBIT_ADDRESS_WORKER_KIND}] PR #${prNumber}: failed to clean reused checkout`, fields);
      throw new Error(`coderabbit-address checkout failed for PR #${prNumber}: failed to clean reused checkout`);
    }
    const checkedOut = await gitSequence(dir, [['fetch', '--quiet', '--all']])
      && (await execCapture('gh', ['pr', 'checkout', prNumber, '--repo', targetRepo], { cwd: dir, env })).exitCode === 0
      && (await gitSequence(dir, [['reset', '--hard'], ['clean', '-fd']]));
    if (!checkedOut) {
      logger.error(`[worker:${CODERABBIT_ADDRESS_WORKER_KIND}] PR #${prNumber}: gh pr checkout failed`, fields);
      throw new Error(`coderabbit-address checkout failed for PR #${prNumber}: gh pr checkout failed`);
    }
    try {
      writeFileSync(join(dir, PR_CRON_WORKDIR_STAMP_NAME), '');
    } catch {
      // Best effort: the stamp only feeds workdir pruning.
    }
    return dir;
  };

  return {
    async addressCoderabbitFeedback(request) {
      const checkoutDir = await prepareCheckout(request.prNumber);
      const ctxFile = join(tmpdir(), `invoker-cr-ctx.${process.pid}.${Date.now()}.json`);
      writeFileSync(ctxFile, JSON.stringify({
        pr: Number(request.prNumber),
        prTitle: request.prTitle,
        prBody: request.prBody,
        headBranch: request.headBranch,
        baseBranch: request.baseBranch,
        coderabbitComments: request.comments,
        invokerTasks: request.tasks,
      }));

      const prompt = buildCoderabbitPrompt(
        request.prNumber, request.baseBranch, request.headBranch, ctxFile, targetRepo);
      const ompArgs = ['--no-title', '--auto-approve', ...(ompModel ? ['--model', ompModel] : []), '-p', prompt];
      const timeoutBin = resolveExecutableOnCurrentPath('timeout');
      const [command, args] = timeoutBin
        ? [timeoutBin, ['--kill-after=1m', ompTimeout, ompCommand, ...ompArgs]]
        : [ompCommand, ompArgs];

      logger.info(`[worker:${CODERABBIT_ADDRESS_WORKER_KIND}] PR #${request.prNumber}: launching omp on ${checkoutDir}`, fields);
      const result = await execCapture(command, args, { cwd: checkoutDir, env });
      try {
        rmSync(ctxFile, { force: true });
      } catch {
        // Best effort cleanup of the temp context file.
      }
      return result.exitCode === 0;
    },
  };
}

/**
 * Prune stale PR checkout workdirs — native port of `prune_stale_pr_workdirs`.
 * Refuses obviously-unsafe roots and never removes a fresh dir.
 */
function pruneStaleWorkdirs(
  config: ResolvedPrMaintenanceConfig,
  logger: Logger,
  clock: PrMaintenanceClock,
  root: string,
  maxAgeDays: number,
): void {
  const fields = { module: LOG_MODULE, worker: CODERABBIT_ADDRESS_WORKER_KIND };
  if (root.length === 0 || root === '/' || root === homedir()) {
    logger.warn(`[worker:${CODERABBIT_ADDRESS_WORKER_KIND}] prune: refusing to prune unsafe root "${root}"`, fields);
    return;
  }
  if (!Number.isInteger(maxAgeDays) || maxAgeDays < 0) {
    logger.warn(`[worker:${CODERABBIT_ADDRESS_WORKER_KIND}] prune: invalid max age days "${maxAgeDays}"`, fields);
    return;
  }
  if (!existsSync(root)) return;

  const cutoffSeconds = Math.floor(clock.now() / 1000) - maxAgeDays * 24 * 60 * 60;
  for (const name of readdirSync(root)) {
    if (!/^[0-9]+$/.test(name)) continue;
    const dir = join(root, name);
    let mtimeSeconds: number;
    try {
      if (!statSync(dir).isDirectory()) continue;
      const stamp = join(dir, PR_CRON_WORKDIR_STAMP_NAME);
      mtimeSeconds = Math.floor(statSync(existsSync(stamp) ? stamp : dir).mtimeMs / 1000);
    } catch {
      continue;
    }
    if (mtimeSeconds >= cutoffSeconds) continue;
    if (config.dryRun) {
      logger.info(`[worker:${CODERABBIT_ADDRESS_WORKER_KIND}] prune: would remove stale pr workdir "${dir}" (age_days=${maxAgeDays})`, fields);
      continue;
    }
    rmSync(dir, { recursive: true, force: true });
    logger.info(`[worker:${CODERABBIT_ADDRESS_WORKER_KIND}] prune: removed stale pr workdir "${dir}" (age_days=${maxAgeDays})`, fields);
  }
}

/** Build the production backend seams (real gh/git/omp/owner subprocess calls). */
export function createDefaultPrMaintenanceDeps(
  config: ResolvedPrMaintenanceConfig,
  logger: Logger,
): PrMaintenanceBackendDeps {
  const clock: PrMaintenanceClock = {
    now: Date.now,
    sleep(ms) {
      const { promise, resolve: settle } = Promise.withResolvers<void>();
      setTimeout(settle, ms).unref?.();
      return promise;
    },
  };
  return {
    github: createDefaultGitHubClient(config, clock),
    owner: createDefaultOwnerClient(config),
    omp: createDefaultOmpClient(config, logger),
    clock,
    pruneStaleWorkdirs: (root, maxAgeDays) => pruneStaleWorkdirs(config, logger, clock, root, maxAgeDays),
  };
}

// ── Job runners ─────────────────────────────────────────────────────────────

export interface PrMaintenanceRunArgs {
  config: ResolvedPrMaintenanceConfig;
  deps: PrMaintenanceBackendDeps;
  ledger: PrMaintenanceLedger;
  logger: Logger;
}

/**
 * CodeRabbit review-address tick — native port of `cron-coderabbit-address.sh`.
 * At most one omp operation runs per tick (bounds the shared lock hold). Dedup
 * keys off the ledger's max recorded comment marker; the per-batch attempt cap
 * counts attempts (including failed omp runs) for the current comment marker.
 */
export async function runCoderabbitAddressTick(args: PrMaintenanceRunArgs): Promise<void> {
  const { config, deps, ledger, logger } = args;
  const fields = { module: LOG_MODULE, worker: CODERABBIT_ADDRESS_WORKER_KIND };
  const log = (message: string): void => logger.info(`[worker:${CODERABBIT_ADDRESS_WORKER_KIND}] ${message}`, fields);

  deps.pruneStaleWorkdirs(config.workdir, config.workdirMaxAgeDays);

  const prs = await deps.github.listOpenAuthoredPrs(['number', 'url', 'headRefName', 'baseRefName', 'title']);
  if (prs === null) {
    log('could not list PRs; exiting');
    return;
  }

  for (const pr of prs) {
    const num = String(pr.number ?? '');
    if (num.length === 0) continue;
    const headBranch = String(pr.headRefName ?? '');
    const baseBranch = String(pr.baseRefName ?? '');
    const prTitle = String(pr.title ?? '');

    const comments = await deps.github.collectCoderabbitComments(num);
    const latestMarker = maxUpdatedAt(comments);
    if (latestMarker === undefined) continue;

    // New-since-last-run dedup (robust to deleted comments lowering the max).
    const seenMax = ledger.maxMarker('coderabbit', num);
    if (seenMax !== undefined && !(latestMarker > seenMax)) {
      log(`PR #${num}: no new CodeRabbit comments since ${seenMax}; skip`);
      continue;
    }

    // Per-feedback-batch attempt cap for THIS comment marker (incl. failed runs).
    if (ledger.count('coderabbit-attempt', num, latestMarker) >= config.maxCoderabbitAttempts) {
      log(`PR #${num}: CodeRabbit address hit cap of ${config.maxCoderabbitAttempts}; skip`);
      continue;
    }

    if (config.dryRun) {
      log(`PR #${num}: would launch omp for new CodeRabbit activity at ${latestMarker}`);
      return;
    }

    await launchCoderabbitOmp(args, { num, prTitle, headBranch, baseBranch, comments, latestMarker });
    return;
  }

  log('no PRs with new CodeRabbit feedback this tick');
}

async function launchCoderabbitOmp(
  args: PrMaintenanceRunArgs,
  batch: {
    num: string;
    prTitle: string;
    headBranch: string;
    baseBranch: string;
    comments: CoderabbitComment[];
    latestMarker: string;
  },
): Promise<void> {
  const { config, deps, ledger, logger } = args;
  const { num, latestMarker } = batch;
  const fields = { module: LOG_MODULE, worker: CODERABBIT_ADDRESS_WORKER_KIND };
  const log = (message: string): void => logger.info(`[worker:${CODERABBIT_ADDRESS_WORKER_KIND}] ${message}`, fields);

  // Count every real attempt (not just successes) so repeated failures hit the
  // cap; dedup still keys off the success marker recorded below.
  ledger.record('coderabbit-attempt', num, latestMarker);

  let tasks: unknown = null;
  const record = await deps.owner.resolveWorkflowForPr(num);
  if (record === null) {
    log(`PR #${num}: review-gate lookup failed; proceeding without task context`);
  } else if (record.workflowId) {
    tasks = await deps.owner.queryWorkflowTasks(record.workflowId);
  } else {
    log(`PR #${num}: no local Invoker workflow; proceeding without task context`);
  }

  const prBody = await deps.github.getPrBody(num);
  const addressed = await deps.omp.addressCoderabbitFeedback({
    prNumber: num,
    prTitle: batch.prTitle,
    prBody,
    headBranch: batch.headBranch,
    baseBranch: batch.baseBranch,
    comments: batch.comments,
    tasks,
  });

  if (addressed) {
    ledger.record('coderabbit', num, latestMarker);
    log(`PR #${num}: omp addressed CodeRabbit feedback; recorded marker ${latestMarker}`);
    return;
  }
  log(`PR #${num}: omp exited non-zero; not recording (retry next tick)`);
  throw new Error(`coderabbit-address omp failed for PR #${num}`);
}

function maxUpdatedAt(comments: CoderabbitComment[]): string | undefined {
  let max: string | undefined;
  for (const comment of comments) {
    if (comment.updated_at.length === 0) continue;
    if (max === undefined || comment.updated_at > max) max = comment.updated_at;
  }
  return max;
}

/**
 * PR merge-conflict rebase tick — native port of `cron-pr-conflict-rebase.sh`.
 * At most one rebase-recreate runs per tick. Dedup + attempt cap key off the
 * per-(workflow, generation) ledger; hitting the cap posts a one-time
 * manual-attention comment on the PR.
 */
export async function runPrConflictRebaseTick(args: PrMaintenanceRunArgs): Promise<void> {
  const { config, deps, ledger, logger } = args;
  const fields = { module: LOG_MODULE, worker: PR_CONFLICT_REBASE_WORKER_KIND };
  const log = (message: string): void => logger.info(`[worker:${PR_CONFLICT_REBASE_WORKER_KIND}] ${message}`, fields);

  const prs = await deps.github.listOpenAuthoredPrs(['number', 'headRefName', 'mergeable', 'mergeStateStatus']);
  if (prs === null) {
    log('could not list PRs; exiting');
    return;
  }

  for (const pr of prs) {
    if (pr.mergeStateStatus !== 'DIRTY' && pr.mergeable !== 'CONFLICTING') continue;
    const num = String(pr.number ?? '');
    if (num.length === 0) continue;

    const record = await deps.owner.resolveWorkflowForPr(num);
    if (record === null) {
      log(`PR #${num}: review-gate lookup failed; skip (retry next tick)`);
      continue;
    }
    const workflowId = record.workflowId;
    if (!workflowId) {
      log(`PR #${num}: no local workflow; skip`);
      continue;
    }
    const generation = String(record.workflowGeneration ?? 0);

    // Per-(workflow, generation) dedup.
    if (ledger.markerSeen('rebase-recreate', workflowId, generation)) {
      log(`PR #${num}: rebase-recreate already fired for generation ${generation}; skip`);
      continue;
    }

    // Per-generation attempt cap + one-time GitHub flag.
    if (ledger.count('rebase-recreate-attempt', workflowId, generation) >= config.maxRebaseAttempts) {
      log(`PR #${num}: giving up — rebase-recreate hit cap of ${config.maxRebaseAttempts} for workflow ${workflowId}`);
      await flagExhausted(args, num, workflowId);
      continue;
    }

    await dispatchRebaseRecreate(args, num, workflowId, generation);
    return;
  }

  log('no actionable conflicting PRs this tick');
}

async function flagExhausted(args: PrMaintenanceRunArgs, num: string, workflowId: string): Promise<void> {
  const { config, deps, ledger, logger } = args;
  const fields = { module: LOG_MODULE, worker: PR_CONFLICT_REBASE_WORKER_KIND };
  const log = (message: string): void => logger.info(`[worker:${PR_CONFLICT_REBASE_WORKER_KIND}] ${message}`, fields);

  if (ledger.markerSeen('rebase-recreate-flagged', workflowId, 'exhausted')) return;

  const body = `Invoker conflict-rebase cron gave up after ${config.maxRebaseAttempts} rebase-recreate attempts; `
    + 'this PR still conflicts and needs manual attention.';
  if (config.dryRun) {
    log(`PR #${num}: would post 'exhausted' comment and flag workflow ${workflowId}`);
    return;
  }
  // Only record the one-time flag if the comment actually posted; a transient
  // GitHub failure must not permanently suppress the manual-attention ping.
  if (await deps.github.postPrComment(num, body)) {
    ledger.record('rebase-recreate-flagged', workflowId, 'exhausted');
  } else {
    log(`PR #${num}: exhausted-comment post failed (non-fatal); will retry the flag next tick`);
  }
}

async function dispatchRebaseRecreate(
  args: PrMaintenanceRunArgs,
  num: string,
  workflowId: string,
  generation: string,
): Promise<void> {
  const { config, deps, ledger, logger } = args;
  const fields = { module: LOG_MODULE, worker: PR_CONFLICT_REBASE_WORKER_KIND };
  const log = (message: string): void => logger.info(`[worker:${PR_CONFLICT_REBASE_WORKER_KIND}] ${message}`, fields);

  if (config.dryRun) {
    log(`PR #${num}: would rebase-recreate ${workflowId} (generation ${generation})`);
    return;
  }

  log(`PR #${num}: rebase-recreate ${workflowId} (generation ${generation})`);
  if (!(await deps.owner.dispatchRebaseRecreate(workflowId))) {
    log(`PR #${num}: rebase-recreate dispatch failed; retry next tick`);
    throw new Error(`pr-conflict-rebase dispatch failed for workflow ${workflowId}`);
  }
  // Count the accepted dispatch so a non-idempotent rebase-recreate that never
  // advances generation still hits the cap instead of re-firing every tick.
  ledger.record('rebase-recreate-attempt', workflowId, generation);

  // Confirm the recreate actually landed: generation must advance past `gen`.
  const targetGeneration = Number.parseInt(generation, 10);
  const deadline = deps.clock.now() + config.confirmTimeoutSeconds * 1000;
  while (deps.clock.now() < deadline) {
    const newGeneration = await deps.owner.queryWorkflowGeneration(workflowId);
    if (newGeneration !== undefined && newGeneration > targetGeneration) {
      ledger.record('rebase-recreate', workflowId, generation);
      log(`PR #${num}: rebase-recreate confirmed (generation ${generation} -> ${newGeneration})`);
      return;
    }
    await deps.clock.sleep(5000);
  }
  log(`PR #${num}: rebase-recreate not confirmed within ${config.confirmTimeoutSeconds}s; not recording (retry next tick)`);
  throw new Error(`pr-conflict-rebase not confirmed for workflow ${workflowId}`);
}
