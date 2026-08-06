import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Readable } from 'node:stream';

import { resolveRepoRoot, type Logger } from '@invoker/contracts';
import type { WorkerActionStatus } from '@invoker/data-store';

import { recordWorkerDecisionRow, type WorkerDecisionStore } from '../worker-decision-ledger.js';
import { terminateChildProcessGroup, SIGKILL_TIMEOUT_MS } from '../process-utils.js';

import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const PR_ADMIN_BYPASS_LAND_WORKER_KIND = 'pr-admin-bypass-land';
export const PR_ORPHAN_REPAIR_WORKER_KIND = 'pr-orphan-repair';
export const PR_DUPLICATE_CLOSE_WORKER_KIND = 'pr-duplicate-close';
export const DEFAULT_PR_MAINTENANCE_WORKER_INTERVAL_MS = 5 * 60_000;
/**
 * Even spacing between each PR-maintenance worker's first tick, so the 3
 * workers sharing the cron lock (scripts/cron-pr-lib.sh) don't all wake on
 * the same intervalMs boundary and race for it every cycle.
 */
export const PR_MAINTENANCE_WORKER_STAGGER_STEP_MS = DEFAULT_PR_MAINTENANCE_WORKER_INTERVAL_MS / 3;
/**
 * Wall-clock cap on a single tick's spawned child before it is killed and the
 * tick fails. Default four minutes: comfortably under the five-minute poll
 * interval (with margin for the SIGTERM->SIGKILL escalation below) so a hung
 * child never survives into -- or steals -- the next scheduled tick.
 * worker-runtime.ts's scheduler coalesces ticks (a tick that never settles
 * blocks every future tick of that worker kind forever), so this bound is
 * what keeps a wedged child from permanently killing the worker. `0` disables
 * it. Override via INVOKER_PR_MAINTENANCE_TICK_TIMEOUT_MS.
 */
export const DEFAULT_PR_MAINTENANCE_WORKER_TICK_TIMEOUT_MS = 4 * 60_000;

export type PrMaintenanceWorkerKind =
  | typeof PR_ADMIN_BYPASS_LAND_WORKER_KIND
  | typeof PR_ORPHAN_REPAIR_WORKER_KIND
  | typeof PR_DUPLICATE_CLOSE_WORKER_KIND;

type EnvOverrides = Record<string, string | undefined>;

export interface PrMaintenanceEntrypoint {
  kind: PrMaintenanceWorkerKind;
  scriptRelativePath: string;
  note: string;
}

const PR_ADMIN_BYPASS_LAND_ENTRYPOINT: PrMaintenanceEntrypoint = {
  kind: PR_ADMIN_BYPASS_LAND_WORKER_KIND,
  scriptRelativePath: 'scripts/cron-pr-admin-bypass-land.sh',
  note: 'Runs the admin-bypass requeue-only babysitting cron entrypoint under worker scheduling.',
};
const PR_ORPHAN_REPAIR_ENTRYPOINT: PrMaintenanceEntrypoint = {
  kind: PR_ORPHAN_REPAIR_WORKER_KIND,
  scriptRelativePath: 'scripts/cron-pr-orphan-repair.sh',
  note: 'Classifies unmapped broken PRs and submits one combined Invoker repair task per PR.',
};
const PR_DUPLICATE_CLOSE_ENTRYPOINT: PrMaintenanceEntrypoint = {
  kind: PR_DUPLICATE_CLOSE_WORKER_KIND,
  scriptRelativePath: 'scripts/cron-pr-duplicate-close.sh',
  note: 'Closes open PRs already landed on master or duplicating another open PR, via one Invoker close task per PR.',
};

export interface PrMaintenanceWorkerConfig {
  /** Repository root that owns the shell scripts. Defaults to the current Invoker repo root. */
  repoRoot?: string;
  /** Environment overrides passed to the shell entrypoint. `undefined` removes a variable. */
  env?: EnvOverrides;
  /** Poll cadence for PR-maintenance workers. Defaults to five minutes. */
  intervalMs?: number;
  /**
   * Delay before this worker's first tick/poll begins, in ms. Default 0.
   * Every PR-maintenance worker shares one intervalMs with zero stagger by
   * default, so without this they all wake on the same boundary every cycle
   * and race for the shared cron lock — the same worker (typically whichever
   * registers first) wins almost every time, starving the others. Each
   * registerXWorker call below assigns a distinct offset to fix this.
   */
  startDelayMs?: number;
  /** Shared cron lock path. Defaults to the shell script's `INVOKER_PR_CRON_LOCK` behavior. */
  lockPath?: string;
  /** Per-tick wall-clock cap for the spawned child. See DEFAULT_PR_MAINTENANCE_WORKER_TICK_TIMEOUT_MS. */
  tickTimeoutMs?: number;
  /** Shell executable used to run the existing entrypoint. Defaults to `bash`. */
  shell?: string;
  store?: WorkerDecisionStore;
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

export interface PrMaintenanceWorkerOptions extends PrMaintenanceWorkerConfig {
  logger: Logger;
  instanceId?: string;
  installSignalHandlers?: boolean;
  /** See WorkerRuntimeOptions.restartAfterSurvivedSignalMs. Default 30s for PR-maintenance workers. */
  restartAfterSurvivedSignalMs?: number;
  tickOnStart?: boolean;
  onTick?: WorkerTick;
  spawnProcess?: typeof spawn;
  lockProbe?: PrMaintenanceLockProbe;
}

export interface PrMaintenanceTickOptions extends PrMaintenanceWorkerConfig {
  entrypoint: PrMaintenanceEntrypoint;
  logger: Logger;
  spawnProcess?: typeof spawn;
  lockProbe?: PrMaintenanceLockProbe;
}

/** Register built-in PR-maintenance workers in cron job order. */
export function registerPrMaintenanceWorkers(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registerPrAdminBypassLandWorker(registry);
  registerPrOrphanRepairWorker(registry);
  registerPrDuplicateCloseWorker(registry);
  return registry;
}

export function registerPrAdminBypassLandWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: PR_ADMIN_BYPASS_LAND_WORKER_KIND,
    note: PR_ADMIN_BYPASS_LAND_ENTRYPOINT.note,
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createPrAdminBypassLandWorker({
        logger: deps.logger,
        ...deps.prMaintenance,
        store: deps.store,
        startDelayMs: 0 * PR_MAINTENANCE_WORKER_STAGGER_STEP_MS,
      }),
  });
  return registry;
}

export function registerPrOrphanRepairWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: PR_ORPHAN_REPAIR_WORKER_KIND,
    note: PR_ORPHAN_REPAIR_ENTRYPOINT.note,
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createPrOrphanRepairWorker({
        logger: deps.logger,
        ...deps.prMaintenance,
        store: deps.store,
        startDelayMs: 1 * PR_MAINTENANCE_WORKER_STAGGER_STEP_MS,
      }),
  });
  return registry;
}

export function registerPrDuplicateCloseWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: PR_DUPLICATE_CLOSE_WORKER_KIND,
    note: PR_DUPLICATE_CLOSE_ENTRYPOINT.note,
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createPrDuplicateCloseWorker({
        logger: deps.logger,
        ...deps.prMaintenance,
        store: deps.store,
        startDelayMs: 2 * PR_MAINTENANCE_WORKER_STAGGER_STEP_MS,
      }),
  });
  return registry;
}

export function createPrAdminBypassLandWorker(options: PrMaintenanceWorkerOptions): WorkerRuntime {
  return createPrMaintenanceWorker(PR_ADMIN_BYPASS_LAND_ENTRYPOINT, options);
}

export function createPrOrphanRepairWorker(options: PrMaintenanceWorkerOptions): WorkerRuntime {
  return createPrMaintenanceWorker(PR_ORPHAN_REPAIR_ENTRYPOINT, options);
}

export function createPrDuplicateCloseWorker(options: PrMaintenanceWorkerOptions): WorkerRuntime {
  return createPrMaintenanceWorker(PR_DUPLICATE_CLOSE_ENTRYPOINT, options);
}


export function createPrMaintenanceTick(options: PrMaintenanceTickOptions): WorkerTick {
  return async (ctx) => {
    await runPrMaintenanceEntrypoint(options, ctx.signal);
  };
}

export function probePrMaintenanceLock(options: PrMaintenanceLockProbeOptions): PrMaintenanceLockProbeResult {
  const flockProbe = spawnSync('flock', ['-n', options.lockPath, '-c', 'true'], {
    env: options.env,
    stdio: 'ignore',
    timeout: 3_000,
    killSignal: 'SIGKILL',
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

  const staleLockSeconds = options.staleLockSeconds ?? 3600;
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
    startDelayMs: options.startDelayMs,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    restartAfterSurvivedSignalMs: options.restartAfterSurvivedSignalMs ?? 30_000,
    onTick: options.onTick ?? createPrMaintenanceTick({
      entrypoint,
      logger: options.logger,
      repoRoot: options.repoRoot,
      env: options.env,
      intervalMs: options.intervalMs,
      lockPath: options.lockPath,
      tickTimeoutMs: options.tickTimeoutMs,
      shell: options.shell,
      spawnProcess: options.spawnProcess,
      lockProbe: options.lockProbe,
      store: options.store,
    }),
  });
}

async function runPrMaintenanceEntrypoint(
  options: PrMaintenanceTickOptions,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();

  const repoRoot = resolvePrMaintenanceRepoRoot(options.repoRoot);
  const startedAt = new Date().toISOString();
  const runExternalKey = `${options.entrypoint.kind}:${repoRoot}:${startedAt}`;
  const env = buildPrMaintenanceEnv(repoRoot, options.env);
  const lockPath = options.lockPath ?? env.INVOKER_PR_CRON_LOCK ?? defaultPrCronLockPath(env);
  env.INVOKER_PR_CRON_LOCK = lockPath;
  const lockProbe = options.lockProbe ?? probePrMaintenanceLock;
  const lock = await lockProbe({
    lockPath,
    env,
    staleLockSeconds: parsePositiveInteger(env.INVOKER_PR_CRON_LOCK_STALE_SECS),
  });

  signal?.throwIfAborted();

  if (lock.held) {
    options.logger.info(`[worker:${options.entrypoint.kind}] shared PR maintenance lock held; skipping tick`, {
      module: 'pr-maintenance-worker',
      worker: options.entrypoint.kind,
      lockPath,
      reason: lock.reason ?? 'lock-held',
    });
    return;
  }

  const scriptPath = resolve(repoRoot, options.entrypoint.scriptRelativePath);
  const shell = options.shell ?? 'bash';
  const spawnProcess = options.spawnProcess ?? spawn;
  options.logger.info(`[worker:${options.entrypoint.kind}] spawning ${options.entrypoint.scriptRelativePath}`, {
    module: 'pr-maintenance-worker',
    worker: options.entrypoint.kind,
    cwd: repoRoot,
    command: shell,
    args: [scriptPath],
    lockPath,
  });

  let child: ChildProcess;
  try {
    child = spawnProcess(shell, [scriptPath], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
  } catch (err) {
    options.logger.error(`[worker:${options.entrypoint.kind}] spawn failed`, {
      module: 'pr-maintenance-worker',
      worker: options.entrypoint.kind,
      err,
    });
    recordPrMaintenanceRun(options, runExternalKey, repoRoot, 'failed', `Spawn failed for ${options.entrypoint.scriptRelativePath}`, {
      reason: 'spawn-failed',
      error: String(err),
    });
    throw err;
  }

  attachChildStreamLogger(options, child.stdout, 'stdout');
  attachChildStreamLogger(options, child.stderr, 'stderr');
  recordPrMaintenanceRun(options, runExternalKey, repoRoot, 'running', `Started ${options.entrypoint.scriptRelativePath}`);

  const tickTimeoutMs = resolvePrMaintenanceTickTimeoutMs(options.tickTimeoutMs);

  await new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false;
    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let forceAbandonTimer: ReturnType<typeof setTimeout> | null = null;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
      if (forceAbandonTimer) { clearTimeout(forceAbandonTimer); forceAbandonTimer = null; }
      fn();
    };

    const onAbort = (): void => {
      void terminateChildProcessGroup(child, () => settled);
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    const onTickTimeout = (): void => {
      timedOut = true;
      options.logger.error(
        `[worker:${options.entrypoint.kind}] tick exceeded ${tickTimeoutMs}ms; killing spawned child`,
        { module: 'pr-maintenance-worker', worker: options.entrypoint.kind, tickTimeoutMs },
      );
      void terminateChildProcessGroup(child, () => settled);
      // Belt-and-suspenders: terminateChildProcessGroup already escalates
      // SIGTERM -> SIGKILL within SIGKILL_TIMEOUT_MS and the close handler
      // below settles this promise once the OS confirms exit. If 'close' is
      // somehow never delivered, force-settle anyway so worker-runtime.ts's
      // coalescing scheduler can never be wedged by this child no matter what.
      forceAbandonTimer = setTimeout(() => {
        settle(() => {
          const message = `PR maintenance worker ${options.entrypoint.kind} child did not exit within `
            + `${SIGKILL_TIMEOUT_MS}ms of SIGKILL after a ${tickTimeoutMs}ms tick timeout; abandoning`;
          options.logger.error(`[worker:${options.entrypoint.kind}] force-abandoning unresponsive child`, {
            module: 'pr-maintenance-worker',
            worker: options.entrypoint.kind,
          });
          recordPrMaintenanceRun(options, runExternalKey, repoRoot, 'failed', message, {
            reason: 'tick-timeout-force-abandoned',
            tickTimeoutMs,
          });
          rejectPromise(new Error(message));
        });
      }, SIGKILL_TIMEOUT_MS + 1_000);
      forceAbandonTimer.unref?.();
    };

    if (tickTimeoutMs > 0) {
      timeoutTimer = setTimeout(onTickTimeout, tickTimeoutMs);
      timeoutTimer.unref?.();
    }

    child.once('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      settle(() => {
        options.logger.error(`[worker:${options.entrypoint.kind}] process error`, {
          module: 'pr-maintenance-worker',
          worker: options.entrypoint.kind,
          err,
        });
        recordPrMaintenanceRun(options, runExternalKey, repoRoot, 'failed', 'PR maintenance process error', {
          reason: 'process-error',
          error: String(err),
        });
        rejectPromise(err);
      });
    });

    child.once('close', (code, closeSignal) => {
      signal?.removeEventListener('abort', onAbort);
      settle(() => {
        const fields = {
          module: 'pr-maintenance-worker',
          worker: options.entrypoint.kind,
          code,
          signal: closeSignal,
        };
        if (timedOut) {
          const message = `PR maintenance worker ${options.entrypoint.kind} exceeded its ${tickTimeoutMs}ms tick timeout and was killed`;
          options.logger.error(`[worker:${options.entrypoint.kind}] shell entrypoint killed after tick timeout`, fields);
          recordPrMaintenanceRun(options, runExternalKey, repoRoot, 'failed', message, {
            reason: 'tick-timeout',
            tickTimeoutMs,
            code,
            signal: closeSignal,
          });
          rejectPromise(new Error(message));
          return;
        }
        if (code === 0) {
          options.logger.info(`[worker:${options.entrypoint.kind}] shell entrypoint completed`, fields);
          recordPrMaintenanceRun(options, runExternalKey, repoRoot, 'completed', 'PR maintenance run completed');
          resolvePromise();
          return;
        }
        if (signal?.aborted) {
          recordPrMaintenanceRun(options, runExternalKey, repoRoot, 'failed', 'PR maintenance aborted by stop', {
            reason: 'aborted',
          });
          resolvePromise();
          return;
        }
        const message = `PR maintenance worker ${options.entrypoint.kind} exited with code ${code ?? 'null'}`
          + (closeSignal ? ` signal ${closeSignal}` : '');
        options.logger.error(`[worker:${options.entrypoint.kind}] shell entrypoint failed`, fields);
        recordPrMaintenanceRun(options, runExternalKey, repoRoot, 'failed', message, {
          reason: 'nonzero-exit',
          code,
          signal: closeSignal,
        });
        rejectPromise(new Error(message));
      });
    });
  });
}

function recordPrMaintenanceRun(
  options: PrMaintenanceTickOptions,
  externalKey: string,
  repoRoot: string,
  status: WorkerActionStatus,
  summary: string,
  payload?: Record<string, unknown>,
): void {
  if (!options.store) return;
  recordWorkerDecisionRow(options.store, {
    workerKind: options.entrypoint.kind,
    actionType: 'pr-maintenance-run',
    externalKey,
    subjectType: 'repo',
    subjectId: repoRoot,
    status,
    summary,
    incrementAttempt: status === 'running',
    ...(payload ? { payload } : {}),
  });
}

function attachChildStreamLogger(
  options: PrMaintenanceTickOptions,
  stream: Readable | null,
  streamName: 'stdout' | 'stderr',
): void {
  if (!stream) return;
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string | Buffer) => {
    buffer += String(chunk);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      logChildLine(options, streamName, line);
    }
  });
  stream.on('end', () => {
    if (buffer.length > 0) {
      logChildLine(options, streamName, buffer);
      buffer = '';
    }
  });
}

function logChildLine(
  options: PrMaintenanceTickOptions,
  streamName: 'stdout' | 'stderr',
  line: string,
): void {
  const fields = {
    module: 'pr-maintenance-worker',
    worker: options.entrypoint.kind,
    stream: streamName,
  };
  if (streamName === 'stderr') {
    options.logger.warn(`[worker:${options.entrypoint.kind}] ${line}`, fields);
    return;
  }
  options.logger.info(`[worker:${options.entrypoint.kind}] ${line}`, fields);
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
  delete env.INVOKER_HEADLESS_STANDALONE;
  env.INVOKER_HEADLESS_REQUIRE_EXISTING_OWNER = '1';
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

function resolvePrMaintenanceTickTimeoutMs(explicit: number | undefined): number {
  if (explicit !== undefined) return explicit;
  const raw = process.env.INVOKER_PR_MAINTENANCE_TICK_TIMEOUT_MS?.trim();
  if (raw === '0') return 0;
  if (!raw || !/^(0|[1-9]\d*)$/.test(raw)) return DEFAULT_PR_MAINTENANCE_WORKER_TICK_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_PR_MAINTENANCE_WORKER_TICK_TIMEOUT_MS;
}

function readMkdirLockHolder(lockDir: string): number | undefined {
  try {
    const raw = readFileSync(resolve(lockDir, 'pid'), 'utf8').trim();
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
