import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { Readable } from 'node:stream';

import { resolveRepoRoot, type Logger } from '@invoker/contracts';
import { Channels, type MessageBus } from '@invoker/transport';

import { terminateChildProcessGroup } from '../process-utils.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const E2E_AUTOFIX_WORKER_KIND = 'e2e-autofix';
export const E2E_AUTOFIX_SCRIPT_RELATIVE_PATH = 'scripts/cron-e2e-regression-watch.sh';
/** Default cadence: sweep default-branch push CI every fifteen minutes. */
export const DEFAULT_E2E_AUTOFIX_INTERVAL_MS = 15 * 60_000;
/**
 * If the spawned child's own process exits but Node's `close` event does not
 * follow within this window, resolve the tick using the `exit` result anyway
 * instead of waiting on `close` forever. `close` only fires once every stdio
 * pipe (not just the direct child's) has ended; a grandchild that inherits
 * the piped stdout/stderr fds and outlives its parent (e.g. `something &`
 * inside the shell entrypoint) can hold that pipe open indefinitely even
 * though the direct child has fully exited, permanently blocking every
 * future tick — worker-runtime.ts's scheduler coalesces ticks, so a tick
 * that never settles blocks the worker forever, silently (2026-08-31: e2e-
 * autofix ticked once after an owner restart, then never again for 40+
 * minutes, with no error logged — proven root cause via a controlled repro:
 * `exit` fires immediately while `close` never fires when the child
 * backgrounds a long-lived grandchild sharing its stdio fds).
 */
export const DEFAULT_E2E_AUTOFIX_CLOSE_GRACE_MS = 2_000;
export const DEFAULT_RED_DEFAULT_BRANCH_ALERT_HOURS = 48;
const DEFAULT_CI_WATCH_TARGET_REPO = 'Neko-Catpital-Labs/Invoker';

type EnvOverrides = Record<string, string | undefined>;

export interface E2eAutoFixWorkerConfig {
  /** Repository root that owns the shell script. Defaults to the current Invoker repo root. */
  repoRoot?: string;
  /** Environment overrides passed to the shell entrypoint. `undefined` removes a variable. */
  env?: EnvOverrides;
  /** Poll cadence in milliseconds. `> 0` arms the periodic timer. Defaults to fifteen minutes. */
  intervalMs?: number;
  /** Shell executable used to run the existing entrypoint. Defaults to `bash`. */
  shell?: string;
  /** See DEFAULT_E2E_AUTOFIX_CLOSE_GRACE_MS. */
  closeGraceMs?: number;
  redDefaultBranchAlertHours?: number;
}

export interface E2eAutoFixWorkerOptions extends E2eAutoFixWorkerConfig {
  logger: Logger;
  instanceId?: string;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  onTick?: WorkerTick;
  spawnProcess?: typeof spawn;
  messageBus?: MessageBus;
}

export interface E2eAutoFixTickOptions extends E2eAutoFixWorkerConfig {
  logger: Logger;
  spawnProcess?: typeof spawn;
  messageBus?: MessageBus;
}

interface RedDefaultBranchAlertState {
  lastAlertedUtcDate?: string;
}

const RED_DEFAULT_BRANCH_ALERT_STATE_FILE = 'red-default-branch-alert.json';

/** Register the built-in default-branch CI auto-fix watcher. */
export function registerE2eAutoFixWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: E2E_AUTOFIX_WORKER_KIND,
    note: 'Watches default-branch push CI and opens one repair workflow per first-bad SHA/job.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createE2eAutoFixWorker({
        logger: deps.logger,
        ...deps.e2eAutoFix,
        ...(deps.messageBus !== undefined ? { messageBus: deps.messageBus } : {}),
      }),
  });
  return registry;
}

export function createE2eAutoFixWorker(options: E2eAutoFixWorkerOptions): WorkerRuntime {
  return createWorkerRuntime({
    kind: E2E_AUTOFIX_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_E2E_AUTOFIX_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? true,
    installSignalHandlers: options.installSignalHandlers,
    onTick: options.onTick ?? createE2eAutoFixTick({
      logger: options.logger,
      repoRoot: options.repoRoot,
      env: options.env,
      intervalMs: options.intervalMs,
      shell: options.shell,
      closeGraceMs: options.closeGraceMs,
      redDefaultBranchAlertHours: options.redDefaultBranchAlertHours,
      messageBus: options.messageBus,
      spawnProcess: options.spawnProcess,
    }),
  });
}

export function createE2eAutoFixTick(options: E2eAutoFixTickOptions): WorkerTick {
  const alertState: RedDefaultBranchAlertState = {};
  return async (ctx) => {
    await runE2eAutoFixEntrypoint(options, alertState, ctx?.signal);
  };
}

async function runE2eAutoFixEntrypoint(
  options: E2eAutoFixTickOptions,
  alertState: RedDefaultBranchAlertState,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const repoRoot = options.repoRoot ? resolve(options.repoRoot) : resolveRepoRoot(process.cwd());
  const scriptPath = resolve(repoRoot, E2E_AUTOFIX_SCRIPT_RELATIVE_PATH);
  const shell = options.shell ?? 'bash';
  const spawnProcess = options.spawnProcess ?? spawn;

  options.logger.info(`[worker:${E2E_AUTOFIX_WORKER_KIND}] spawning ${E2E_AUTOFIX_SCRIPT_RELATIVE_PATH}`, {
    module: 'e2e-autofix-worker',
    worker: E2E_AUTOFIX_WORKER_KIND,
    cwd: repoRoot,
    command: shell,
    args: [scriptPath],
  });

  let child: ChildProcess;
  let childEnv: NodeJS.ProcessEnv;
  try {
    childEnv = { ...process.env, ...options.env };
    delete childEnv.INVOKER_HEADLESS_STANDALONE;
    child = spawnProcess(shell, [scriptPath], {
      cwd: repoRoot,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
  } catch (err) {
    options.logger.error(`[worker:${E2E_AUTOFIX_WORKER_KIND}] spawn failed`, {
      module: 'e2e-autofix-worker',
      worker: E2E_AUTOFIX_WORKER_KIND,
      err,
    });
    throw err;
  }

  attachChildStreamLogger(options, child.stdout, 'stdout');
  attachChildStreamLogger(options, child.stderr, 'stderr');

  const closeGraceMs = options.closeGraceMs ?? DEFAULT_E2E_AUTOFIX_CLOSE_GRACE_MS;
  let succeeded = false;

  await new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
      fn();
    };

    const finish = (code: number | null, exitSignal: NodeJS.Signals | null, source: 'close' | 'exit'): void => {
      settle(() => {
        const fields = {
          module: 'e2e-autofix-worker',
          worker: E2E_AUTOFIX_WORKER_KIND,
          code,
          signal: exitSignal,
          source,
        };
        if (code === 0) {
          if (source === 'exit') {
            options.logger.warn(
              `[worker:${E2E_AUTOFIX_WORKER_KIND}] shell entrypoint exited but stdio did not close within ${closeGraceMs}ms; resolving via exit so future ticks are not blocked`,
              fields,
            );
          } else {
            options.logger.info(`[worker:${E2E_AUTOFIX_WORKER_KIND}] shell entrypoint completed`, fields);
          }
          succeeded = true;
          resolvePromise();
          return;
        }
        if (signal?.aborted) {
          options.logger.info(`[worker:${E2E_AUTOFIX_WORKER_KIND}] shell entrypoint aborted by stop`, fields);
          resolvePromise();
          return;
        }
        const message = `e2e auto-fix worker exited with code ${code ?? 'null'}`
          + (exitSignal ? ` signal ${exitSignal}` : '');
        options.logger.error(`[worker:${E2E_AUTOFIX_WORKER_KIND}] shell entrypoint failed`, fields);
        rejectPromise(new Error(message));
      });
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

    child.once('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      settle(() => {
        options.logger.error(`[worker:${E2E_AUTOFIX_WORKER_KIND}] process error`, {
          module: 'e2e-autofix-worker',
          worker: E2E_AUTOFIX_WORKER_KIND,
          err,
        });
        rejectPromise(err);
      });
    });

    child.once('close', (code, exitSignal) => {
      signal?.removeEventListener('abort', onAbort);
      finish(code, exitSignal, 'close');
    });

    child.once('exit', (code, exitSignal) => {
      if (settled) return;
      graceTimer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        finish(code, exitSignal, 'exit');
      }, closeGraceMs);
      graceTimer.unref?.();
    });
  });

  if (succeeded) {
    checkRedDefaultBranchAlert(options, childEnv, alertState);
  }
}

function checkRedDefaultBranchAlert(
  options: E2eAutoFixTickOptions,
  env: NodeJS.ProcessEnv,
  alertState: RedDefaultBranchAlertState,
): void {
  const stateDir = resolveCiWatchStateDir(env);
  const sweepLogPath = resolve(stateDir, 'sweep-log.jsonl');

  let lastLine: string | undefined;
  try {
    const raw = readFileSync(sweepLogPath, 'utf8');
    const lines = raw.split('\n').filter((line) => line.trim().length > 0);
    lastLine = lines[lines.length - 1];
    if (lastLine === undefined) throw new Error('sweep log is empty');
  } catch (err) {
    options.logger.warn(
      `[worker:${E2E_AUTOFIX_WORKER_KIND}] could not read the CI regression watcher sweep log at ${sweepLogPath}`,
      { module: 'e2e-autofix-worker', worker: E2E_AUTOFIX_WORKER_KIND, err },
    );
    return;
  }

  let entry: { defaultBranchRedForHours?: number | null; lastGreenDefaultBranchRunAt?: string | null };
  try {
    entry = JSON.parse(lastLine);
  } catch (err) {
    options.logger.warn(
      `[worker:${E2E_AUTOFIX_WORKER_KIND}] could not parse the CI regression watcher sweep log at ${sweepLogPath}`,
      { module: 'e2e-autofix-worker', worker: E2E_AUTOFIX_WORKER_KIND, err },
    );
    return;
  }

  const redForHours = entry.defaultBranchRedForHours;
  const thresholdHours = options.redDefaultBranchAlertHours ?? DEFAULT_RED_DEFAULT_BRANCH_ALERT_HOURS;
  if (typeof redForHours !== 'number' || !Number.isFinite(redForHours) || redForHours < thresholdHours) {
    return;
  }

  if (!options.messageBus) return;

  const utcDate = new Date().toISOString().slice(0, 10);
  const alertStatePath = resolve(stateDir, RED_DEFAULT_BRANCH_ALERT_STATE_FILE);
  if (alertState.lastAlertedUtcDate === undefined) {
    alertState.lastAlertedUtcDate = readPersistedAlertDate(options, alertStatePath);
  }
  if (alertState.lastAlertedUtcDate === utcDate) return;

  const redForDays = redForHours / 24;
  const lastGreenText = entry.lastGreenDefaultBranchRunAt
    ? `last green at ${entry.lastGreenDefaultBranchRunAt}`
    : 'no green run on record';

  try {
    options.messageBus.publish(Channels.SURFACE_EVENT, {
      type: 'alert',
      alert: {
        severity: 'critical',
        source: E2E_AUTOFIX_WORKER_KIND,
        subject: `Default branch CI has been red for ${redForDays.toFixed(1)} days`,
        message: `${lastGreenText}; red for ${redForHours.toFixed(1)} hours.`,
        alertKey: `default-branch-red:${utcDate}`,
      },
    });
  } catch (err) {
    options.logger.warn(
      `[worker:${E2E_AUTOFIX_WORKER_KIND}] could not publish the red default branch alert`,
      { module: 'e2e-autofix-worker', worker: E2E_AUTOFIX_WORKER_KIND, err },
    );
    return;
  }

  alertState.lastAlertedUtcDate = utcDate;
  persistAlertDate(options, alertStatePath, utcDate);
}

function readPersistedAlertDate(options: E2eAutoFixTickOptions, path: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as RedDefaultBranchAlertState;
    return typeof parsed.lastAlertedUtcDate === 'string' ? parsed.lastAlertedUtcDate : undefined;
  } catch (err) {
    options.logger.warn(
      `[worker:${E2E_AUTOFIX_WORKER_KIND}] could not parse the red default branch alert state at ${path}`,
      { module: 'e2e-autofix-worker', worker: E2E_AUTOFIX_WORKER_KIND, err },
    );
    return undefined;
  }
}

function persistAlertDate(options: E2eAutoFixTickOptions, path: string, utcDate: string): void {
  const state: RedDefaultBranchAlertState = { lastAlertedUtcDate: utcDate };
  try {
    writeFileSync(path, `${JSON.stringify(state)}\n`);
  } catch (err) {
    options.logger.warn(
      `[worker:${E2E_AUTOFIX_WORKER_KIND}] could not persist the red default branch alert state at ${path}`,
      { module: 'e2e-autofix-worker', worker: E2E_AUTOFIX_WORKER_KIND, err },
    );
  }
}

function resolveCiWatchStateDir(env: NodeJS.ProcessEnv): string {
  const explicit = env.INVOKER_CI_WATCH_STATE_DIR ?? env.INVOKER_E2E_WATCH_STATE_DIR;
  if (typeof explicit === 'string' && explicit.trim()) return explicit;
  const targetRepo = env.INVOKER_GITHUB_TARGET_REPO?.trim() || DEFAULT_CI_WATCH_TARGET_REPO;
  if (targetRepo === DEFAULT_CI_WATCH_TARGET_REPO) {
    return resolve(homedir(), '.invoker', 'e2e-regression-watch');
  }
  return resolve(homedir(), '.invoker', 'e2e-regression-watch-targets', slugifyCiWatchTargetRepo(targetRepo));
}

function slugifyCiWatchTargetRepo(value: string, maxLength = 128): string {
  const slug = trimDashes(value.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  return trimDashes((slug || 'ci-job').slice(0, maxLength)) || 'ci-job';
}

function trimDashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '-') start += 1;
  while (end > start && value[end - 1] === '-') end -= 1;
  return value.slice(start, end);
}

function attachChildStreamLogger(
  options: E2eAutoFixTickOptions,
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
  options: E2eAutoFixTickOptions,
  streamName: 'stdout' | 'stderr',
  line: string,
): void {
  const fields = {
    module: 'e2e-autofix-worker',
    worker: E2E_AUTOFIX_WORKER_KIND,
    stream: streamName,
  };
  if (streamName === 'stderr') {
    options.logger.warn(`[worker:${E2E_AUTOFIX_WORKER_KIND}] ${line}`, fields);
    return;
  }
  options.logger.info(`[worker:${E2E_AUTOFIX_WORKER_KIND}] ${line}`, fields);
}
