import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { Logger } from '@invoker/contracts';

import { recordWorkerDecisionRow, type WorkerDecisionStore } from '../worker-decision-ledger.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';
import { expandLocalRepoPath } from './catstack-deploy-worker.js';

export const HOOK_METRICS_COLLECT_WORKER_KIND = 'hook-metrics-collect';
export const DEFAULT_HOOK_METRICS_COLLECT_INTERVAL_MINUTES = 60;
export const DEFAULT_HOOK_METRICS_COLLECT_INTERVAL_MS = DEFAULT_HOOK_METRICS_COLLECT_INTERVAL_MINUTES * 60 * 1000;
export const DEFAULT_HOOK_METRICS_CATSTACK_REPO_PATH = '~/Documents/GitHub/catstack';
export const HOOK_METRICS_COLLECT_SCRIPT_PATH = 'engine/hooks/_sdk/collect.py';

export type HookMetricsCollectSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; stdio: ['ignore', 'pipe', 'pipe']; env: NodeJS.ProcessEnv },
) => ChildProcess;

export interface HookMetricsCollectWorkerConfig {
  /** Poll cadence in milliseconds. Defaults to one hour. */
  intervalMs?: number;
  /** Local catstack checkout path (tilde expanded). Defaults to ~/Documents/GitHub/catstack. */
  catstackRepoPath?: string;
  tickOnStart?: boolean;
  store?: WorkerDecisionStore;
  /** Test seam: override collector process spawn. */
  spawnCollector?: HookMetricsCollectSpawn;
  onTick?: WorkerTick;
}

export interface HookMetricsCollectWorkerOptions {
  logger: Logger;
  intervalMs?: number;
  catstackRepoPath: string;
  tickOnStart?: boolean;
  store?: WorkerDecisionStore;
  spawnCollector?: HookMetricsCollectSpawn;
  onTick?: WorkerTick;
}

interface CollectorResult {
  exitStatus: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

function parseJsonObjectFromStdout(stdout: string): Record<string, unknown> | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  const candidates = [trimmed, ...trimmed.split(/\r?\n/).reverse()];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // The collector may emit human-readable logs; fall back to regex parsing.
    }
  }
  return undefined;
}

function numericField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.length;
  }
  return undefined;
}

export function parseUncheckedMachineCount(stdout: string): number | undefined {
  const parsed = parseJsonObjectFromStdout(stdout);
  if (parsed) {
    const fromJson = numericField(parsed, [
      'uncheckedMachineCount',
      'unchecked_machine_count',
      'uncheckedMachines',
      'unchecked_machines',
    ]);
    if (fromJson !== undefined) return fromJson;
  }

  const match = stdout.match(/unchecked(?:[_\s-]?machines?)?(?:[_\s-]?count)?\D+(\d+)/i);
  if (!match?.[1]) return undefined;
  return Number.parseInt(match[1], 10);
}

async function runCollectorProcess(
  repoPath: string,
  spawnCollector: HookMetricsCollectSpawn,
): Promise<CollectorResult> {
  return new Promise<CollectorResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: CollectorResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child: ChildProcess;
    try {
      child = spawnCollector('python3', [HOOK_METRICS_COLLECT_SCRIPT_PATH], {
        cwd: repoPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (error) {
      finish({
        exitStatus: null,
        stdout,
        stderr,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.once('error', (error) => {
      finish({
        exitStatus: null,
        stdout,
        stderr,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    child.once('close', (code) => {
      finish({ exitStatus: code, stdout, stderr });
    });
  });
}

export async function runHookMetricsCollectTick(options: HookMetricsCollectWorkerOptions): Promise<void> {
  const repoPath = expandLocalRepoPath(options.catstackRepoPath);
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const result = await runCollectorProcess(repoPath, options.spawnCollector ?? spawn);
  const durationMs = Date.now() - startedMs;
  const uncheckedMachineCount = parseUncheckedMachineCount(result.stdout);
  const status = result.exitStatus === 0 ? 'completed' : 'failed';
  const exitLabel = result.exitStatus === null ? 'spawn-error' : String(result.exitStatus);
  const summary = `Hook metrics collector exit=${exitLabel}, uncheckedMachines=${uncheckedMachineCount ?? 'unknown'}`;
  const payload = {
    catstackRepoPath: repoPath,
    scriptPath: HOOK_METRICS_COLLECT_SCRIPT_PATH,
    exitStatus: result.exitStatus,
    uncheckedMachineCount,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs,
    ...(result.error ? { error: result.error } : {}),
  };

  if (options.store) {
    recordWorkerDecisionRow(options.store, {
      workerKind: HOOK_METRICS_COLLECT_WORKER_KIND,
      actionType: 'hook-metrics-collect',
      externalKey: `hook-metrics-collect:${startedAt}:${randomUUID()}`,
      subjectType: 'catstack-hook-fleet',
      subjectId: 'fleet',
      status,
      summary,
      payload,
      now: startedAt,
    });
  }

  const logFields = {
    module: HOOK_METRICS_COLLECT_WORKER_KIND,
    path: repoPath,
    exitStatus: result.exitStatus,
    uncheckedMachineCount,
  };
  if (status === 'completed') {
    options.logger.info(`[${HOOK_METRICS_COLLECT_WORKER_KIND}] ${summary}`, logFields);
  } else {
    options.logger.error(`[${HOOK_METRICS_COLLECT_WORKER_KIND}] ${summary}`, logFields);
  }
}

export function createHookMetricsCollectWorker(
  config: HookMetricsCollectWorkerConfig & { logger: Logger },
): WorkerRuntime {
  const options: HookMetricsCollectWorkerOptions = {
    logger: config.logger,
    intervalMs: config.intervalMs,
    catstackRepoPath: config.catstackRepoPath ?? DEFAULT_HOOK_METRICS_CATSTACK_REPO_PATH,
    tickOnStart: config.tickOnStart,
    store: config.store,
    spawnCollector: config.spawnCollector,
  };
  const onTick: WorkerTick = config.onTick ?? (async () => {
    await runHookMetricsCollectTick(options);
  });
  return createWorkerRuntime({
    kind: HOOK_METRICS_COLLECT_WORKER_KIND,
    logger: config.logger,
    onTick,
    intervalMs: config.intervalMs ?? DEFAULT_HOOK_METRICS_COLLECT_INTERVAL_MS,
    tickOnStart: config.tickOnStart ?? true,
  });
}

/** Register the built-in hook-metrics-collect worker. */
export function registerHookMetricsCollectWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: HOOK_METRICS_COLLECT_WORKER_KIND,
    note: 'Runs catstack engine/hooks/_sdk/collect.py from the owner checkout and records each collector result.',
    source: 'built-in',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime => {
      if (!deps.hookMetricsCollect) {
        throw new Error('hook-metrics-collect worker is not configured; add hookMetricsCollect to Invoker config before starting it.');
      }
      return createHookMetricsCollectWorker({
        logger: deps.logger,
        store: deps.hookMetricsCollect.store ?? deps.store,
        ...deps.hookMetricsCollect,
      });
    },
  });
  return registry;
}
