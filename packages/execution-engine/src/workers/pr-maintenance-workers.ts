import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveInvokerHomeRoot, resolveRepoRoot, type Logger } from '@invoker/contracts';
import type { PersistenceAdapter, ReviewGateLookup } from '@invoker/data-store';

import { retryTransientGitHubCli } from '../git-utils.js';
import { killProcessGroup, SIGKILL_TIMEOUT_MS } from '../process-utils.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import type { WorkerMutationSubmitter } from '../worker-types.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const CODERABBIT_ADDRESS_WORKER_KIND = 'coderabbit-address';
export const PR_CONFLICT_REBASE_WORKER_KIND = 'pr-conflict-rebase';
export const DEFAULT_PR_MAINTENANCE_WORKER_INTERVAL_MS = 5 * 60_000;

const DEFAULT_GITHUB_TARGET_REPO = 'Neko-Catpital-Labs/Invoker';
const DEFAULT_PR_AUTHOR = 'EdbertChan';
const DEFAULT_CODERABBIT_LOGIN = 'coderabbitai[bot]';
const DEFAULT_CODERABBIT_MAX_ATTEMPTS = 3;
const DEFAULT_REBASE_MAX_ATTEMPTS = 3;
const DEFAULT_REBASE_CONFIRM_TIMEOUT_SECONDS = 120;
const DEFAULT_OMP_TIMEOUT = '45m';
const DEFAULT_LOCK_STALE_SECONDS = 3600;
const HEADLESS_EXEC_CHANNEL = 'headless.exec';
const WORKER_MODULE = 'pr-maintenance-worker';

type EnvOverrides = Record<string, string | undefined>;

type CoderabbitComment = {
  body: string;
  updated_at: string;
  path?: string | null;
  html_url?: string | null;
};

type PullRequestListItem = {
  number: number;
  headRefName?: string;
  baseRefName?: string;
  title?: string;
  mergeable?: string;
  mergeStateStatus?: string;
};

type PullRequestView = {
  title?: string;
  body?: string;
  headRefName?: string;
  baseRefName?: string;
};

type ReviewGateRecord = ReviewGateLookup;

type HeadlessExecMutationPayload = {
  args: string[];
  noTrack?: boolean;
};

interface LedgerEntry {
  kind: string;
  key: string;
  marker: string;
}

interface PrMaintenanceResolvedOptions extends PrMaintenanceTickOptions {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  lockPath: string;
  lockStaleSeconds?: number;
  commandRunner: PrMaintenanceCommandRunner;
  sleep: PrMaintenanceSleep;
}

interface PrMaintenanceLockHandle {
  release(): void;
}

export type PrMaintenanceWorkerKind =
  | typeof CODERABBIT_ADDRESS_WORKER_KIND
  | typeof PR_CONFLICT_REBASE_WORKER_KIND;

export interface PrMaintenanceEntrypoint {
  kind: PrMaintenanceWorkerKind;
  legacyScriptRelativePath: string;
  note: string;
}

const CODERABBIT_ADDRESS_ENTRYPOINT: PrMaintenanceEntrypoint = {
  kind: CODERABBIT_ADDRESS_WORKER_KIND,
  legacyScriptRelativePath: 'scripts/cron-coderabbit-address.sh',
  note: 'Runs the CodeRabbit review-address cron entrypoint under worker scheduling.',
};

const PR_CONFLICT_REBASE_ENTRYPOINT: PrMaintenanceEntrypoint = {
  kind: PR_CONFLICT_REBASE_WORKER_KIND,
  legacyScriptRelativePath: 'scripts/cron-pr-conflict-rebase.sh',
  note: 'Runs the PR conflict rebase-recreate cron entrypoint under worker scheduling.',
};

export interface PrMaintenanceWorkerConfig {
  /** Repository root that owns the existing Invoker code. Defaults to the current Invoker repo root. */
  repoRoot?: string;
  /** Environment overrides passed to the direct backend. `undefined` removes a variable. */
  env?: EnvOverrides;
  /** Poll cadence for both PR-maintenance workers. Defaults to five minutes. */
  intervalMs?: number;
  /** Shared cron lock path. Defaults to the legacy shell script lock path. */
  lockPath?: string;
  /** Legacy shell override retained for config compatibility; direct backends ignore it. */
  shell?: string;
}

export interface PrMaintenanceLockProbeOptions {
  lockPath: string;
  env: NodeJS.ProcessEnv;
  staleLockSeconds?: number;
}

export interface PrMaintenanceLockProbeResult {
  held: boolean;
  reason?: string;
}

export type PrMaintenanceLockProbe = (
  options: PrMaintenanceLockProbeOptions,
) => PrMaintenanceLockProbeResult | Promise<PrMaintenanceLockProbeResult>;

export interface PrMaintenanceCommandRun {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  allowNonZeroExit?: boolean;
}

export interface PrMaintenanceCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface PrMaintenanceCommandRunner {
  run(request: PrMaintenanceCommandRun): Promise<PrMaintenanceCommandResult>;
}

export type PrMaintenanceSleep = (ms: number) => Promise<void>;

export interface PrMaintenanceWorkerStore extends Pick<PersistenceAdapter, 'findReviewGateByPr' | 'loadTasks' | 'loadWorkflow'> {}

export interface PrMaintenanceWorkerSubmitter extends WorkerMutationSubmitter {}

export interface PrMaintenanceWorkerOptions extends PrMaintenanceWorkerConfig {
  logger: Logger;
  instanceId?: string;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  onTick?: WorkerTick;
  spawnProcess?: typeof spawn;
  lockProbe?: PrMaintenanceLockProbe;
  commandRunner?: PrMaintenanceCommandRunner;
  sleep?: PrMaintenanceSleep;
  store?: PrMaintenanceWorkerStore;
  submitter?: PrMaintenanceWorkerSubmitter;
}

export interface PrMaintenanceTickOptions extends PrMaintenanceWorkerConfig {
  entrypoint: PrMaintenanceEntrypoint;
  logger: Logger;
  spawnProcess?: typeof spawn;
  lockProbe?: PrMaintenanceLockProbe;
  commandRunner?: PrMaintenanceCommandRunner;
  sleep?: PrMaintenanceSleep;
  store?: PrMaintenanceWorkerStore;
  submitter?: PrMaintenanceWorkerSubmitter;
}

/** Register both built-in PR-maintenance workers in cron job order. */
export function registerPrMaintenanceWorkers(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registerCoderabbitAddressWorker(registry);
  registerPrConflictRebaseWorker(registry);
  return registry;
}

export function registerCoderabbitAddressWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: CODERABBIT_ADDRESS_WORKER_KIND,
    note: CODERABBIT_ADDRESS_ENTRYPOINT.note,
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createCoderabbitAddressWorker({
        logger: deps.logger,
        store: deps.store as PrMaintenanceWorkerStore,
        submitter: deps.submitter as PrMaintenanceWorkerSubmitter,
        ...deps.prMaintenance,
      }),
  });
  return registry;
}

export function registerPrConflictRebaseWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: PR_CONFLICT_REBASE_WORKER_KIND,
    note: PR_CONFLICT_REBASE_ENTRYPOINT.note,
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createPrConflictRebaseWorker({
        logger: deps.logger,
        store: deps.store as PrMaintenanceWorkerStore,
        submitter: deps.submitter as PrMaintenanceWorkerSubmitter,
        ...deps.prMaintenance,
      }),
  });
  return registry;
}

export function createCoderabbitAddressWorker(options: PrMaintenanceWorkerOptions): WorkerRuntime {
  return createPrMaintenanceWorker(CODERABBIT_ADDRESS_ENTRYPOINT, options);
}

export function createPrConflictRebaseWorker(options: PrMaintenanceWorkerOptions): WorkerRuntime {
  return createPrMaintenanceWorker(PR_CONFLICT_REBASE_ENTRYPOINT, options);
}

export function createPrMaintenanceTick(options: PrMaintenanceTickOptions): WorkerTick {
  return async () => {
    await runPrMaintenanceEntrypoint(options);
  };
}

export function probePrMaintenanceLock(options: PrMaintenanceLockProbeOptions): PrMaintenanceLockProbeResult {
  const flockProbe = spawnSync('flock', ['-n', options.lockPath, '-c', 'true'], {
    env: options.env,
    stdio: 'ignore',
  });
  if (!flockProbe.error || (flockProbe.error as NodeJS.ErrnoException).code !== 'ENOENT') {
    return flockProbe.status === 0
      ? { held: false }
      : { held: true, reason: 'flock-held' };
  }

  const lockDir = `${options.lockPath}.d`;
  if (!existsSync(lockDir)) return { held: false };

  const holderPid = readMkdirLockHolder(lockDir);
  if (holderPid !== undefined) {
    return isProcessAlive(holderPid)
      ? { held: true, reason: 'mkdir-lock-held' }
      : { held: false, reason: 'mkdir-lock-stale-dead-holder' };
  }

  const staleLockSeconds = options.staleLockSeconds ?? DEFAULT_LOCK_STALE_SECONDS;
  const ageSeconds = Math.max(0, Math.floor((Date.now() - statSync(lockDir).mtimeMs) / 1000));
  return ageSeconds < staleLockSeconds
    ? { held: true, reason: 'mkdir-lock-held-without-pid' }
    : { held: false, reason: 'mkdir-lock-stale-without-pid' };
}

function createPrMaintenanceWorker(
  entrypoint: PrMaintenanceEntrypoint,
  options: PrMaintenanceWorkerOptions,
): WorkerRuntime {
  return createWorkerRuntime({
    kind: entrypoint.kind,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_PR_MAINTENANCE_WORKER_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick: options.onTick ?? createPrMaintenanceTick({
      entrypoint,
      logger: options.logger,
      repoRoot: options.repoRoot,
      env: options.env,
      intervalMs: options.intervalMs,
      lockPath: options.lockPath,
      shell: options.shell,
      spawnProcess: options.spawnProcess,
      lockProbe: options.lockProbe,
      commandRunner: options.commandRunner,
      sleep: options.sleep,
      store: options.store,
      submitter: options.submitter,
    }),
  });
}

async function runPrMaintenanceEntrypoint(options: PrMaintenanceTickOptions): Promise<void> {
  const repoRoot = resolvePrMaintenanceRepoRoot(options.repoRoot);
  const env = buildPrMaintenanceEnv(repoRoot, options.env);
  const lockPath = options.lockPath ?? env.INVOKER_PR_CRON_LOCK ?? defaultPrCronLockPath(env);
  env.INVOKER_PR_CRON_LOCK = lockPath;
  const lockStaleSeconds = parsePositiveInteger(env.INVOKER_PR_CRON_LOCK_STALE_SECS);
  const lockProbe = options.lockProbe ?? probePrMaintenanceLock;
  const lock = await lockProbe({
    lockPath,
    env,
    staleLockSeconds: lockStaleSeconds,
  });

  if (lock.held) {
    options.logger.info(`[worker:${options.entrypoint.kind}] shared PR maintenance lock held; skipping tick`, {
      module: WORKER_MODULE,
      worker: options.entrypoint.kind,
      lockPath,
      reason: lock.reason ?? 'lock-held',
    });
    return;
  }

  const acquiredLock = tryAcquirePrMaintenanceLock(lockPath, lockStaleSeconds ?? DEFAULT_LOCK_STALE_SECONDS);
  if (!acquiredLock) {
    options.logger.info(`[worker:${options.entrypoint.kind}] shared PR maintenance lock held; skipping tick`, {
      module: WORKER_MODULE,
      worker: options.entrypoint.kind,
      lockPath,
      reason: 'mkdir-lock-race-held',
    });
    return;
  }

  const resolved: PrMaintenanceResolvedOptions = {
    ...options,
    repoRoot,
    env,
    lockPath,
    lockStaleSeconds,
    commandRunner: options.commandRunner ?? createDefaultPrMaintenanceCommandRunner(options.spawnProcess),
    sleep: options.sleep ?? delay,
  };

  try {
    switch (options.entrypoint.kind) {
      case CODERABBIT_ADDRESS_WORKER_KIND:
        await runCoderabbitAddressWorkerTick(resolved);
        return;
      case PR_CONFLICT_REBASE_WORKER_KIND:
        await runPrConflictRebaseWorkerTick(resolved);
        return;
      default:
        throw new Error(`Unsupported PR maintenance worker kind: ${String(options.entrypoint.kind)}`);
    }
  } finally {
    acquiredLock.release();
  }
}

async function runCoderabbitAddressWorkerTick(options: PrMaintenanceResolvedOptions): Promise<void> {
  const stateFile = options.env.INVOKER_PR_CODERABBIT_STATE_FILE
    ?? join(resolveInvokerHomeRoot(options.env), 'coderabbit-address-submissions.tsv');
  const workdir = options.env.INVOKER_PR_CRON_WORKDIR
    ?? join(resolveInvokerHomeRoot(options.env), 'pr-cron-work');
  const targetRepo = options.env.INVOKER_GITHUB_TARGET_REPO ?? DEFAULT_GITHUB_TARGET_REPO;
  const prAuthor = options.env.INVOKER_PR_CRON_AUTHOR ?? DEFAULT_PR_AUTHOR;
  const coderabbitLogin = options.env.INVOKER_CODERABBIT_LOGIN ?? DEFAULT_CODERABBIT_LOGIN;
  const maxAttempts = parsePositiveInteger(options.env.INVOKER_PR_CODERABBIT_MAX_ATTEMPTS)
    ?? DEFAULT_CODERABBIT_MAX_ATTEMPTS;
  const dryRun = options.env.INVOKER_PR_CRON_DRY_RUN === '1';

  ensureLedger(stateFile);

  let prs: PullRequestListItem[];
  try {
    prs = await listOpenPullRequests(options, targetRepo, prAuthor, ['number', 'url', 'headRefName', 'baseRefName', 'title']);
  } catch (err) {
    options.logger.warn(`[worker:${options.entrypoint.kind}] could not list PRs; exiting`, {
      module: WORKER_MODULE,
      worker: options.entrypoint.kind,
      err,
    });
    return;
  }

  for (const pr of prs) {
    const num = pr.number;
    const comments = await collectCoderabbitComments(options, targetRepo, num, coderabbitLogin);
    const latestMarker = latestCoderabbitMarker(comments);
    if (!latestMarker) continue;

    const seenMax = ledgerMaxMarker(stateFile, 'coderabbit', String(num));
    if (seenMax && latestMarker.localeCompare(seenMax) <= 0) {
      options.logger.info(`[worker:${options.entrypoint.kind}] PR #${num}: no new CodeRabbit comments since ${seenMax}; skip`, {
        module: WORKER_MODULE,
        worker: options.entrypoint.kind,
        pr: num,
        marker: latestMarker,
      });
      continue;
    }

    if (ledgerCount(stateFile, 'coderabbit-attempt', String(num), latestMarker) >= maxAttempts) {
      options.logger.warn(`[worker:${options.entrypoint.kind}] PR #${num}: CodeRabbit address hit cap of ${maxAttempts}; skip`, {
        module: WORKER_MODULE,
        worker: options.entrypoint.kind,
        pr: num,
        marker: latestMarker,
      });
      continue;
    }

    if (dryRun) {
      options.logger.info(`[worker:${options.entrypoint.kind}] PR #${num}: would launch omp for new CodeRabbit activity at ${latestMarker}`, {
        module: WORKER_MODULE,
        worker: options.entrypoint.kind,
        pr: num,
        marker: latestMarker,
      });
      return;
    }

    await launchCoderabbitAddress(options, {
      num,
      prTitle: pr.title ?? '',
      headBranch: pr.headRefName ?? '',
      baseBranch: pr.baseRefName ?? '',
      latestMarker,
      comments,
      stateFile,
      workdir,
      targetRepo,
    });
    return;
  }
}

async function runPrConflictRebaseWorkerTick(options: PrMaintenanceResolvedOptions): Promise<void> {
  const stateFile = options.env.INVOKER_PR_CONFLICT_STATE_FILE
    ?? join(resolveInvokerHomeRoot(options.env), 'pr-conflict-rebase-submissions.tsv');
  const targetRepo = options.env.INVOKER_GITHUB_TARGET_REPO ?? DEFAULT_GITHUB_TARGET_REPO;
  const prAuthor = options.env.INVOKER_PR_CRON_AUTHOR ?? DEFAULT_PR_AUTHOR;
  const maxAttempts = parsePositiveInteger(options.env.INVOKER_PR_REBASE_MAX_ATTEMPTS)
    ?? DEFAULT_REBASE_MAX_ATTEMPTS;
  const confirmTimeoutSeconds = parsePositiveInteger(options.env.INVOKER_PR_REBASE_CONFIRM_TIMEOUT)
    ?? DEFAULT_REBASE_CONFIRM_TIMEOUT_SECONDS;
  const dryRun = options.env.INVOKER_PR_CRON_DRY_RUN === '1';

  ensureLedger(stateFile);

  let prs: PullRequestListItem[];
  try {
    prs = await listOpenPullRequests(options, targetRepo, prAuthor, ['number', 'headRefName', 'mergeable', 'mergeStateStatus']);
  } catch (err) {
    options.logger.warn(`[worker:${options.entrypoint.kind}] could not list PRs; exiting`, {
      module: WORKER_MODULE,
      worker: options.entrypoint.kind,
      err,
    });
    return;
  }

  for (const pr of prs) {
    if (pr.mergeStateStatus !== 'DIRTY' && pr.mergeable !== 'CONFLICTING') continue;
    const num = pr.number;
    const record = resolveReviewGateRecord(options, num);
    if (!record) {
      options.logger.info(`[worker:${options.entrypoint.kind}] PR #${num}: no local workflow; skip`, {
        module: WORKER_MODULE,
        worker: options.entrypoint.kind,
        pr: num,
      });
      continue;
    }

    const workflowId = record.workflowId;
    const generation = record.workflowGeneration ?? 0;
    const generationMarker = String(generation);

    if (ledgerMarkerSeen(stateFile, 'rebase-recreate', workflowId, generationMarker)) {
      options.logger.info(`[worker:${options.entrypoint.kind}] PR #${num}: rebase-recreate already fired for generation ${generation}; skip`, {
        module: WORKER_MODULE,
        worker: options.entrypoint.kind,
        pr: num,
        workflowId,
        generation,
      });
      continue;
    }

    if (ledgerCount(stateFile, 'rebase-recreate-attempt', workflowId, generationMarker) >= maxAttempts) {
      options.logger.warn(`[worker:${options.entrypoint.kind}] PR #${num}: giving up — rebase-recreate hit cap of ${maxAttempts} for workflow ${workflowId}`, {
        module: WORKER_MODULE,
        worker: options.entrypoint.kind,
        pr: num,
        workflowId,
        generation,
      });
      await flagConflictExhausted(options, stateFile, targetRepo, num, workflowId, maxAttempts, dryRun);
      continue;
    }

    if (dryRun) {
      options.logger.info(`[worker:${options.entrypoint.kind}] PR #${num}: would rebase-recreate ${workflowId} (generation ${generation})`, {
        module: WORKER_MODULE,
        worker: options.entrypoint.kind,
        pr: num,
        workflowId,
        generation,
      });
      return;
    }

    await dispatchPrConflictRebase(options, stateFile, {
      num,
      workflowId,
      generation,
      confirmTimeoutSeconds,
    });
    return;
  }

  options.logger.info(`[worker:${options.entrypoint.kind}] no actionable conflicting PRs this tick`, {
    module: WORKER_MODULE,
    worker: options.entrypoint.kind,
  });
}

async function launchCoderabbitAddress(
  options: PrMaintenanceResolvedOptions,
  args: {
    num: number;
    prTitle: string;
    headBranch: string;
    baseBranch: string;
    latestMarker: string;
    comments: CoderabbitComment[];
    stateFile: string;
    workdir: string;
    targetRepo: string;
  },
): Promise<void> {
  ledgerRecord(args.stateFile, 'coderabbit-attempt', String(args.num), args.latestMarker);

  const workflowRecord = resolveReviewGateRecord(options, args.num);
  const workflowId = workflowRecord?.workflowId;
  let tasks: unknown = null;
  if (workflowId) {
    tasks = options.store?.loadTasks(workflowId) ?? null;
  } else {
    options.logger.info(`[worker:${options.entrypoint.kind}] PR #${args.num}: no local Invoker workflow; proceeding without task context`, {
      module: WORKER_MODULE,
      worker: options.entrypoint.kind,
      pr: args.num,
    });
  }

  const prView = await readPullRequestView(options, args.targetRepo, args.num);
  const contextDir = mkdtempSync(join(tmpdir(), 'invoker-cr-ctx-'));
  const contextPath = join(contextDir, 'context.json');
  writeFileSync(contextPath, JSON.stringify({
    pr: args.num,
    prTitle: args.prTitle,
    prBody: prView.body ?? '',
    headBranch: args.headBranch,
    baseBranch: args.baseBranch,
    coderabbitComments: args.comments,
    invokerTasks: tasks,
  }, null, 2));

  try {
    const checkoutDir = await prepareCoderabbitCheckout(options, args.targetRepo, args.num, args.workdir);
    const prompt = buildCoderabbitPrompt(args.num, args.baseBranch, args.headBranch, contextPath, args.targetRepo);
    const ompCommand = options.env.INVOKER_OMP_COMMAND ?? 'omp';
    const ompArgs = ['--no-title', '--auto-approve'];
    if (options.env.INVOKER_PR_CRON_OMP_MODEL) {
      ompArgs.push('--model', options.env.INVOKER_PR_CRON_OMP_MODEL);
    }
    ompArgs.push('-p', prompt);

    options.logger.info(`[worker:${options.entrypoint.kind}] PR #${args.num}: launching omp on ${checkoutDir}`, {
      module: WORKER_MODULE,
      worker: options.entrypoint.kind,
      pr: args.num,
      checkoutDir,
    });

    const ompResult = await options.commandRunner.run({
      command: ompCommand,
      args: ompArgs,
      cwd: checkoutDir,
      env: options.env,
      timeoutMs: parseDurationMs(options.env.INVOKER_PR_CRON_OMP_TIMEOUT ?? DEFAULT_OMP_TIMEOUT),
    });
    logCommandOutput(options, 'stdout', ompResult.stdout);
    logCommandOutput(options, 'stderr', ompResult.stderr);

    ledgerRecord(args.stateFile, 'coderabbit', String(args.num), args.latestMarker);
    options.logger.info(`[worker:${options.entrypoint.kind}] PR #${args.num}: omp addressed CodeRabbit feedback; recorded marker ${args.latestMarker}`, {
      module: WORKER_MODULE,
      worker: options.entrypoint.kind,
      pr: args.num,
      marker: args.latestMarker,
    });
  } catch (err) {
    options.logger.error(`[worker:${options.entrypoint.kind}] PR #${args.num}: omp exited non-zero; not recording (retry next tick)`, {
      module: WORKER_MODULE,
      worker: options.entrypoint.kind,
      pr: args.num,
      err,
    });
    throw err;
  } finally {
    rmSync(contextDir, { recursive: true, force: true });
  }
}

async function dispatchPrConflictRebase(
  options: PrMaintenanceResolvedOptions,
  stateFile: string,
  args: {
    num: number;
    workflowId: string;
    generation: number;
    confirmTimeoutSeconds: number;
  },
): Promise<void> {
  if (!options.submitter) {
    throw new Error('PR conflict rebase worker requires a workflow mutation submitter.');
  }
  if (!options.store?.loadWorkflow) {
    throw new Error('PR conflict rebase worker requires workflow reads for confirmation.');
  }

  options.logger.info(`[worker:${options.entrypoint.kind}] PR #${args.num}: rebase-recreate ${args.workflowId} (generation ${args.generation})`, {
    module: WORKER_MODULE,
    worker: options.entrypoint.kind,
    pr: args.num,
    workflowId: args.workflowId,
    generation: args.generation,
  });

  const payload: HeadlessExecMutationPayload = {
    args: ['rebase-recreate', args.workflowId],
    noTrack: true,
  };
  options.submitter.submit(args.workflowId, 'high', HEADLESS_EXEC_CHANNEL, [payload]);
  ledgerRecord(stateFile, 'rebase-recreate-attempt', args.workflowId, String(args.generation));

  const deadline = Date.now() + (args.confirmTimeoutSeconds * 1000);
  while (Date.now() < deadline) {
    const newGeneration = options.store.loadWorkflow(args.workflowId)?.generation;
    if (typeof newGeneration === 'number' && newGeneration > args.generation) {
      ledgerRecord(stateFile, 'rebase-recreate', args.workflowId, String(args.generation));
      options.logger.info(
        `[worker:${options.entrypoint.kind}] PR #${args.num}: rebase-recreate confirmed (generation ${args.generation} -> ${newGeneration})`,
        {
          module: WORKER_MODULE,
          worker: options.entrypoint.kind,
          pr: args.num,
          workflowId: args.workflowId,
          previousGeneration: args.generation,
          newGeneration,
        },
      );
      return;
    }
    await options.sleep(5_000);
  }

  throw new Error(
    `PR #${args.num}: rebase-recreate not confirmed within ${args.confirmTimeoutSeconds}s; not recording (retry next tick)`,
  );
}

async function flagConflictExhausted(
  options: PrMaintenanceResolvedOptions,
  stateFile: string,
  targetRepo: string,
  prNumber: number,
  workflowId: string,
  maxAttempts: number,
  dryRun: boolean,
): Promise<void> {
  if (ledgerMarkerSeen(stateFile, 'rebase-recreate-flagged', workflowId, 'exhausted')) return;
  if (dryRun) {
    options.logger.info(`[worker:${options.entrypoint.kind}] PR #${prNumber}: would post 'exhausted' comment and flag workflow ${workflowId}`, {
      module: WORKER_MODULE,
      worker: options.entrypoint.kind,
      pr: prNumber,
      workflowId,
    });
    return;
  }

  const body = `Invoker conflict-rebase cron gave up after ${maxAttempts} rebase-recreate attempts; this PR still conflicts and needs manual attention.`;
  try {
    await retryTransientGitHubCli(() => options.commandRunner.run({
      command: 'gh',
      args: ['pr', 'comment', String(prNumber), '--repo', targetRepo, '--body', body],
      cwd: options.repoRoot,
      env: options.env,
    }));
    ledgerRecord(stateFile, 'rebase-recreate-flagged', workflowId, 'exhausted');
  } catch (err) {
    options.logger.warn(`[worker:${options.entrypoint.kind}] PR #${prNumber}: exhausted-comment post failed (non-fatal); will retry the flag next tick`, {
      module: WORKER_MODULE,
      worker: options.entrypoint.kind,
      pr: prNumber,
      workflowId,
      err,
    });
  }
}

async function listOpenPullRequests(
  options: PrMaintenanceResolvedOptions,
  targetRepo: string,
  prAuthor: string,
  fields: string[],
): Promise<PullRequestListItem[]> {
  const result = await retryTransientGitHubCli(() => options.commandRunner.run({
    command: 'gh',
    args: ['pr', 'list', '--repo', targetRepo, '--author', prAuthor, '--state', 'open', '--json', fields.join(','), '--limit', '100'],
    cwd: options.repoRoot,
    env: options.env,
  }));
  return parseJsonValue<PullRequestListItem[]>(result.stdout, []);
}

async function readPullRequestView(
  options: PrMaintenanceResolvedOptions,
  targetRepo: string,
  prNumber: number,
): Promise<PullRequestView> {
  try {
    const result = await retryTransientGitHubCli(() => options.commandRunner.run({
      command: 'gh',
      args: ['pr', 'view', String(prNumber), '--repo', targetRepo, '--json', 'title,body,headRefName,baseRefName'],
      cwd: options.repoRoot,
      env: options.env,
    }));
    return parseJsonValue<PullRequestView>(result.stdout, {});
  } catch (err) {
    options.logger.warn(`[worker:${options.entrypoint.kind}] PR #${prNumber}: failed to read PR body; continuing with empty body`, {
      module: WORKER_MODULE,
      worker: options.entrypoint.kind,
      pr: prNumber,
      err,
    });
    return {};
  }
}

async function collectCoderabbitComments(
  options: PrMaintenanceResolvedOptions,
  targetRepo: string,
  prNumber: number,
  coderabbitLogin: string,
): Promise<CoderabbitComment[]> {
  const [inline, summary] = await Promise.all([
    readGitHubArray<Record<string, unknown>>(options, ['api', `repos/${targetRepo}/pulls/${prNumber}/comments?per_page=100`]),
    readGitHubArray<Record<string, unknown>>(options, ['api', `repos/${targetRepo}/issues/${prNumber}/comments?per_page=100`]),
  ]);
  return [...inline, ...summary]
    .filter((comment) => stringProp(comment.user as Record<string, unknown> | undefined, 'login') === coderabbitLogin)
    .map((comment) => ({
      body: stringProp(comment, 'body') ?? '',
      updated_at: stringProp(comment, 'updated_at') ?? '',
      path: stringProp(comment, 'path') ?? null,
      html_url: stringProp(comment, 'html_url') ?? null,
    }))
    .filter((comment) => comment.updated_at.length > 0);
}

async function readGitHubArray<T extends Record<string, unknown>>(
  options: PrMaintenanceResolvedOptions,
  args: string[],
): Promise<T[]> {
  try {
    const result = await retryTransientGitHubCli(() => options.commandRunner.run({
      command: 'gh',
      args,
      cwd: options.repoRoot,
      env: options.env,
    }));
    return parseJsonValue<T[]>(result.stdout, []);
  } catch (err) {
    options.logger.warn(`[worker:${options.entrypoint.kind}] gh failed (${args.join(' ')}); treating as empty`, {
      module: WORKER_MODULE,
      worker: options.entrypoint.kind,
      err,
    });
    return [];
  }
}

async function prepareCoderabbitCheckout(
  options: PrMaintenanceResolvedOptions,
  targetRepo: string,
  prNumber: number,
  workdir: string,
): Promise<string> {
  const checkoutDir = join(workdir, String(prNumber));
  mkdirSync(workdir, { recursive: true });

  if (!existsSync(join(checkoutDir, '.git'))) {
    rmSync(checkoutDir, { recursive: true, force: true });
    try {
      await options.commandRunner.run({
        command: 'gh',
        args: ['repo', 'clone', targetRepo, checkoutDir, '--', '--quiet'],
        cwd: options.repoRoot,
        env: options.env,
      });
    } catch (err) {
      throw new Error(`PR #${prNumber}: clone failed: ${errorMessage(err)}`);
    }
  } else {
    try {
      await options.commandRunner.run({
        command: 'git',
        args: ['reset', '--hard'],
        cwd: checkoutDir,
        env: options.env,
      });
      await options.commandRunner.run({
        command: 'git',
        args: ['clean', '-fd'],
        cwd: checkoutDir,
        env: options.env,
      });
    } catch (err) {
      throw new Error(`PR #${prNumber}: failed to clean reused checkout: ${errorMessage(err)}`);
    }
  }

  try {
    await options.commandRunner.run({
      command: 'git',
      args: ['fetch', '--quiet', '--all'],
      cwd: checkoutDir,
      env: options.env,
    });
    await options.commandRunner.run({
      command: 'gh',
      args: ['pr', 'checkout', String(prNumber), '--repo', targetRepo],
      cwd: checkoutDir,
      env: options.env,
    });
    await options.commandRunner.run({
      command: 'git',
      args: ['reset', '--hard'],
      cwd: checkoutDir,
      env: options.env,
    });
    await options.commandRunner.run({
      command: 'git',
      args: ['clean', '-fd'],
      cwd: checkoutDir,
      env: options.env,
    });
  } catch (err) {
    throw new Error(`PR #${prNumber}: gh pr checkout failed: ${errorMessage(err)}`);
  }

  return checkoutDir;
}

function buildCoderabbitPrompt(
  prNumber: number,
  baseBranch: string,
  headBranch: string,
  contextPath: string,
  targetRepo: string,
): string {
  return [
    `You are addressing CodeRabbit review feedback on GitHub PR #${prNumber} in repository ${targetRepo}.`,
    `You are running inside a fresh checkout of the PR head branch (${headBranch}); HEAD is already on that`,
    `branch and 'git push' updates the PR.`,
    '',
    `Context for this PR is in the JSON file: ${contextPath}`,
    'Fields: .pr, .prTitle, .prBody, .headBranch, .baseBranch,',
    '        .coderabbitComments (array of {body, updated_at, path, html_url}),',
    '        .invokerTasks (the Invoker tasks that produced this PR, or null if none).',
    '',
    'Do this:',
    `1. Read the CodeRabbit comments in ${contextPath}. Also read the actual change under review:`,
    `   'git log origin/${baseBranch}..HEAD' and 'git diff origin/${baseBranch}...HEAD', plus the Invoker task list.`,
    '2. For EACH distinct CodeRabbit concern, decide whether it is genuinely valid (a real bug,',
    '   correctness, or safety issue) — not style noise or a false positive.',
    '3. For each concern you judge VALID:',
    '   a. Add a bash repro at scripts/repro/repro-coderabbit-pr<num>-<slug>.sh that reproduces the',
    '      finding and exits NON-ZERO on the buggy behavior (follow scripts/repro/ convention:',
    `      'set -euo pipefail', derive the repo root, print a clear PASS/FAIL).`,
    '   b. Implement the minimal fix so the repro passes.',
    '4. For concerns you judge NOT valid, take no code action.',
    "5. Commit the repro(s) + fix(es) with a clear message and 'git push' to the PR head branch.",
    '',
    'Constraints: change ONLY what the valid concerns require. Do NOT reformat unrelated code, bump',
    'versions, or touch files outside a concern\'s scope. If NO concern is valid, make no commit and',
    'exit without pushing.',
  ].join('\n');
}

function resolveReviewGateRecord(
  options: Pick<PrMaintenanceResolvedOptions, 'store'>,
  prNumber: number,
): ReviewGateRecord | undefined {
  return options.store?.findReviewGateByPr(String(prNumber));
}

function latestCoderabbitMarker(comments: CoderabbitComment[]): string | undefined {
  let latest: string | undefined;
  for (const comment of comments) {
    if (!latest || comment.updated_at.localeCompare(latest) > 0) {
      latest = comment.updated_at;
    }
  }
  return latest;
}

function parseJsonValue<T>(raw: string, fallback: T): T {
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  return JSON.parse(trimmed) as T;
}

function stringProp(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

function ensureLedger(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, '');
  }
}

function ledgerRecord(path: string, kind: string, key: string, marker: string): void {
  ensureLedger(path);
  appendFileSync(path, `${kind}\t${key}\t${marker}\t${Math.floor(Date.now() / 1000)}\n`);
}

function ledgerCount(path: string, kind: string, key: string, marker?: string): number {
  return readLedger(path).filter((entry) => (
    entry.kind === kind
    && entry.key === key
    && (marker === undefined || entry.marker === marker)
  )).length;
}

function ledgerMarkerSeen(path: string, kind: string, key: string, marker: string): boolean {
  return readLedger(path).some((entry) => entry.kind === kind && entry.key === key && entry.marker === marker);
}

function ledgerMaxMarker(path: string, kind: string, key: string): string | undefined {
  let maxMarker: string | undefined;
  for (const entry of readLedger(path)) {
    if (entry.kind !== kind || entry.key !== key) continue;
    if (!maxMarker || entry.marker.localeCompare(maxMarker) > 0) {
      maxMarker = entry.marker;
    }
  }
  return maxMarker;
}

function readLedger(path: string): LedgerEntry[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  return raw
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => {
      const [kind = '', key = '', marker = ''] = line.split('\t');
      return { kind, key, marker };
    });
}

function tryAcquirePrMaintenanceLock(
  lockPath: string,
  staleLockSeconds: number,
): PrMaintenanceLockHandle | undefined {
  const lockDir = `${lockPath}.d`;
  mkdirSync(dirname(lockDir), { recursive: true });
  if (existsSync(lockDir)) {
    reapStalePrMaintenanceLock(lockDir, staleLockSeconds);
  }
  try {
    mkdirSync(lockDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
    throw err;
  }
  writeFileSync(join(lockDir, 'pid'), `${process.pid}\n`);
  return {
    release(): void {
      rmSync(lockDir, { recursive: true, force: true });
    },
  };
}

function reapStalePrMaintenanceLock(lockDir: string, staleLockSeconds: number): void {
  const holderPid = readMkdirLockHolder(lockDir);
  if (holderPid !== undefined) {
    if (!isProcessAlive(holderPid)) {
      rmSync(lockDir, { recursive: true, force: true });
    }
    return;
  }
  const ageSeconds = Math.max(0, Math.floor((Date.now() - statSync(lockDir).mtimeMs) / 1000));
  if (ageSeconds >= staleLockSeconds) {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

function createDefaultPrMaintenanceCommandRunner(spawnProcess: typeof spawn | undefined): PrMaintenanceCommandRunner {
  const runProcess = spawnProcess ?? spawn;
  return {
    run(request: PrMaintenanceCommandRun): Promise<PrMaintenanceCommandResult> {
      const { promise, resolve, reject } = Promise.withResolvers<PrMaintenanceCommandResult>();
      let child: ChildProcess;
      try {
        child = runProcess(request.command, request.args, {
          cwd: request.cwd,
          env: request.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        });
      } catch (err) {
        reject(err);
        return promise;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        fn();
      };

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string | Buffer) => {
        stdout += String(chunk);
      });
      child.stderr?.on('data', (chunk: string | Buffer) => {
        stderr += String(chunk);
      });

      if (request.timeoutMs && request.timeoutMs > 0) {
        timeout = setTimeout(() => {
          killProcessGroup(child, 'SIGTERM');
          const forceKill = setTimeout(() => {
            killProcessGroup(child, 'SIGKILL');
          }, SIGKILL_TIMEOUT_MS);
          forceKill.unref?.();
          finish(() => reject(new Error(
            `${request.command} ${request.args.join(' ')} exceeded timeout (${request.timeoutMs}ms) in ${request.cwd}`,
          )));
        }, request.timeoutMs);
        timeout.unref?.();
      }

      child.once('error', (err) => {
        finish(() => reject(err));
      });
      child.once('close', (code, signal) => {
        finish(() => {
          const result: PrMaintenanceCommandResult = {
            code: code ?? -1,
            stdout: stdout.trimEnd(),
            stderr: stderr.trimEnd(),
          };
          if (code === 0 || request.allowNonZeroExit) {
            resolve(result);
            return;
          }
          reject(new Error(
            `${request.command} ${request.args.join(' ')} failed (code ${code ?? 'null'}${signal ? ` signal ${signal}` : ''}): `
            + `${result.stderr}${result.stdout ? `\n${result.stdout}` : ''}`,
          ));
        });
      });

      return promise;
    },
  };
}

function logCommandOutput(
  options: Pick<PrMaintenanceResolvedOptions, 'entrypoint' | 'logger'>,
  streamName: 'stdout' | 'stderr',
  output: string,
): void {
  if (!output.trim()) return;
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const fields = {
      module: WORKER_MODULE,
      worker: options.entrypoint.kind,
      stream: streamName,
    };
    if (streamName === 'stderr') {
      options.logger.warn(`[worker:${options.entrypoint.kind}] ${line}`, fields);
    } else {
      options.logger.info(`[worker:${options.entrypoint.kind}] ${line}`, fields);
    }
  }
}

function resolvePrMaintenanceRepoRoot(repoRoot: string | undefined): string {
  return repoRoot ? resolve(repoRoot) : resolveRepoRoot(process.cwd());
}

function buildPrMaintenanceEnv(repoRoot: string, overrides: EnvOverrides | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  env.INVOKER_REPO_ROOT = repoRoot;
  return env;
}

function defaultPrCronLockPath(env: NodeJS.ProcessEnv): string {
  const tmpRoot = env.TMPDIR && env.TMPDIR.length > 0 ? env.TMPDIR : '/tmp';
  return resolve(tmpRoot, 'invoker-pr-crons.lock');
}

function parsePositiveInteger(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseDurationMs(raw: string): number | undefined {
  const trimmed = raw.trim();
  const match = /^(\d+)(ms|s|m|h)?$/i.exec(trimmed);
  if (!match) return undefined;
  const magnitude = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isFinite(magnitude) || magnitude <= 0) return undefined;
  switch ((match[2] ?? 's').toLowerCase()) {
    case 'ms':
      return magnitude;
    case 's':
      return magnitude * 1_000;
    case 'm':
      return magnitude * 60_000;
    case 'h':
      return magnitude * 3_600_000;
    default:
      return undefined;
  }
}

function readMkdirLockHolder(lockDir: string): number | undefined {
  const pidPath = join(lockDir, 'pid');
  if (!existsSync(pidPath)) return undefined;
  const raw = readFileSync(pidPath, 'utf8').trim();
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
  return promise;
}
