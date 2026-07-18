import type { Logger } from '@invoker/contracts';

import { resolveInvokerHomeRoot } from '../worker-lock.js';
import { recordWorkerDecisionRow, type WorkerDecisionStore } from '../worker-decision-ledger.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

import {
  resolveDiskCheckIntervalMs,
  resolveDiskHeadroomThresholds,
  type DiskHeadroomEvaluation,
  type DiskHeadroomThresholds,
} from './disk-headroom.js';
import {
  cleanupLocalInvokerHome,
  cleanupRemoteInvokerHome,
  DiskCleanupCooldownTracker,
  resolveDiskCleanupCooldownMs,
  resolveDiskCleanupEnabled,
  type DiskCleanupResult,
} from './disk-headroom-reclaim.js';
import {
  runDiskHeadroomCheck,
  type ActivityLogLevel,
  type DiskHeadroomMonitorDeps,
  type RemoteDiskTarget,
} from './disk-headroom-monitor.js';

export const DISK_HEADROOM_WORKER_KIND = 'disk-headroom';

export interface DiskHeadroomWorkerConfig {
  /** Local path to check. Defaults to resolveInvokerHomeRoot(). */
  localPath?: string;
  /** Remote SSH targets to check. Defaults to none. */
  remoteTargets?: RemoteDiskTarget[];

  thresholds?: DiskHeadroomThresholds;
  intervalMs?: number;
  tickOnStart?: boolean;

  /** When false, critical disks are logged only. Default: enabled. */
  cleanupEnabled?: boolean;
  /** Min ms between cleanups for the same target. Default: 30 min. */
  cleanupCooldownMs?: number;

  /** Optional decision ledger for cleanup act/skip rows. */
  store?: WorkerDecisionStore;
  /** Optional activity-log sink (wired from owner persistence). */
  writeActivityLog?: (level: ActivityLogLevel, message: string) => void;

  /** Test seam: override the check runner. */
  runCheck?: (deps: DiskHeadroomMonitorDeps) => Promise<DiskHeadroomEvaluation[] | unknown>;
  /** Test seam: override local cleanup. */
  cleanupLocal?: typeof cleanupLocalInvokerHome;
  /** Test seam: override remote cleanup. */
  cleanupRemote?: typeof cleanupRemoteInvokerHome;
  /** Test seam: wrap the worker tick for observability. */
  onTick?: WorkerTick;
}

export interface DiskHeadroomWorkerOptions {
  logger: Logger;
  localPath: string;
  remoteTargets: RemoteDiskTarget[];
  thresholds?: DiskHeadroomThresholds;
  intervalMs?: number;
  tickOnStart?: boolean;
  cleanupEnabled?: boolean;
  cleanupCooldownMs?: number;
  store?: WorkerDecisionStore;
  writeActivityLog?: (level: ActivityLogLevel, message: string) => void;
  runCheck?: (deps: DiskHeadroomMonitorDeps) => Promise<DiskHeadroomEvaluation[] | unknown>;
  cleanupLocal?: typeof cleanupLocalInvokerHome;
  cleanupRemote?: typeof cleanupRemoteInvokerHome;
  onTick?: WorkerTick;
}

function isEvaluationList(value: unknown): value is DiskHeadroomEvaluation[] {
  return Array.isArray(value);
}

function recordCleanupDecision(
  store: WorkerDecisionStore | undefined,
  result: DiskCleanupResult,
): void {
  if (!store) return;
  recordWorkerDecisionRow(store, {
    workerKind: DISK_HEADROOM_WORKER_KIND,
    actionType: 'disk-cleanup',
    externalKey: `cleanup:${result.targetKey}:${result.reason}`,
    subjectType: 'disk-target',
    subjectId: result.targetKey,
    status: result.ok ? 'completed' : result.reason === 'cooldown' || result.reason === 'disabled'
      ? 'skipped'
      : 'failed',
    summary: result.ok
      ? `Cleaned ${result.targetKey}`
      : `Cleanup ${result.reason} for ${result.targetKey}`,
    reason: result.reason,
    payload: result.detail ? { detail: result.detail } : undefined,
    incrementAttempt: result.ok,
  });
}

export function createDiskHeadroomWorker(options: DiskHeadroomWorkerOptions): WorkerRuntime {
  const runCheck = options.runCheck ?? runDiskHeadroomCheck;
  const cleanupLocal = options.cleanupLocal ?? cleanupLocalInvokerHome;
  const cleanupRemote = options.cleanupRemote ?? cleanupRemoteInvokerHome;
  const cleanupEnabled = options.cleanupEnabled ?? resolveDiskCleanupEnabled();
  const cooldown = new DiskCleanupCooldownTracker(
    options.cleanupCooldownMs ?? resolveDiskCleanupCooldownMs(),
  );

  return createWorkerRuntime({
    kind: DISK_HEADROOM_WORKER_KIND,
    logger: options.logger,
    intervalMs: options.intervalMs ?? resolveDiskCheckIntervalMs(),
    tickOnStart: options.tickOnStart ?? true,
    onTick: async (ctx) => {
      ctx.signal?.throwIfAborted();
      await options.onTick?.(ctx);
      ctx.signal?.throwIfAborted();

      const thresholds = options.thresholds ?? resolveDiskHeadroomThresholds();
      const evaluationsRaw = await runCheck({
        logger: options.logger,
        thresholds,
        localPath: options.localPath,
        remoteTargets: options.remoteTargets,
        writeActivityLog: options.writeActivityLog,
      });
      if (ctx.signal?.aborted) return;
      if (!cleanupEnabled) return;
      if (!isEvaluationList(evaluationsRaw)) return;

      const critical = evaluationsRaw.filter((e) => e.level === 'critical');
      for (const evaluation of critical) {
        if (ctx.signal?.aborted) return;
        const targetKey = evaluation.label;
        if (!cooldown.canCleanup(targetKey)) {
          const skipped: DiskCleanupResult = {
            targetKey,
            ok: false,
            reason: 'cooldown',
          };
          options.logger.info?.(
            `[disk-headroom-cleanup] skip ${targetKey}: cooldown`,
            { module: 'disk-headroom', targetKey },
          );
          recordCleanupDecision(options.store, skipped);
          continue;
        }

        let result: DiskCleanupResult;
        if (targetKey.startsWith('ssh:')) {
          const target = options.remoteTargets.find(
            (t) => `ssh:${t.name} ${t.remotePath}` === targetKey,
          );
          if (!target) {
            result = {
              targetKey,
              ok: false,
              reason: 'cleanup-error',
              detail: `remote target not found for ${targetKey}`,
            };
          } else {
            result = await cleanupRemote({
              target,
              logger: options.logger,
            });
          }
        } else {
          result = await cleanupLocal({
            invokerHome: options.localPath,
            targetKey,
            logger: options.logger,
          });
        }

        if (result.ok || result.reason === 'critical-cleanup') {
          cooldown.markCleaned(targetKey);
        } else if (result.reason !== 'cooldown') {
          // Mark failed attempts too so we do not hammer a wedged host every tick.
          cooldown.markCleaned(targetKey);
        }
        recordCleanupDecision(options.store, result);
        options.writeActivityLog?.(
          result.ok ? 'warn' : 'error',
          `[disk-headroom-cleanup] ${result.reason}: ${result.targetKey}`
            + (result.detail ? ` (${result.detail.slice(0, 200)})` : ''),
        );
      }
    },
  });
}

/** Register the built-in disk-headroom worker (df checks + critical cleanup). */
export function registerDiskHeadroomWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: DISK_HEADROOM_WORKER_KIND,
    note: 'Monitors local/remote disk usage and cleans Invoker-managed dirs on critical pressure.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime => {
      const config = deps.diskHeadroom;
      return createDiskHeadroomWorker({
        logger: deps.logger,
        localPath: config?.localPath ?? resolveInvokerHomeRoot(),
        remoteTargets: config?.remoteTargets ?? [],
        thresholds: config?.thresholds,
        intervalMs: config?.intervalMs,
        tickOnStart: config?.tickOnStart,
        cleanupEnabled: config?.cleanupEnabled,
        cleanupCooldownMs: config?.cleanupCooldownMs,
        store: config?.store ?? deps.store,
        writeActivityLog: config?.writeActivityLog,
        runCheck: config?.runCheck as DiskHeadroomWorkerOptions['runCheck'],
        cleanupLocal: config?.cleanupLocal,
        cleanupRemote: config?.cleanupRemote,
        onTick: config?.onTick,
      });
    },
  });
  return registry;
}
