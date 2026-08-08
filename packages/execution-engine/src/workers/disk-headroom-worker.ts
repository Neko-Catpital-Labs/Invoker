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
  type DiskHeadroomWorkerStore,
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
  /** Optional workflow/task state reader used to protect in-use local paths from cleanup. */
  workflowStore?: DiskHeadroomWorkerStore;
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
  workflowStore?: DiskHeadroomWorkerStore;
  writeActivityLog?: (level: ActivityLogLevel, message: string) => void;
  runCheck?: (deps: DiskHeadroomMonitorDeps) => Promise<DiskHeadroomEvaluation[] | unknown>;
  cleanupLocal?: typeof cleanupLocalInvokerHome;
  cleanupRemote?: typeof cleanupRemoteInvokerHome;
  onTick?: WorkerTick;
}

function isEvaluationList(value: unknown): value is DiskHeadroomEvaluation[] {
  return Array.isArray(value);
}

const UNKNOWN_ALERT_STREAK = 2;

class DiskUnknownStreakTracker {
  private readonly streaks = new Map<string, number>();

  recordAndShouldAlert(targetKey: string, isUnknown: boolean): boolean {
    if (!isUnknown) {
      this.streaks.delete(targetKey);
      return false;
    }
    const next = (this.streaks.get(targetKey) ?? 0) + 1;
    this.streaks.set(targetKey, next);
    return next === UNKNOWN_ALERT_STREAK;
  }
}

function recordCleanupDecision(
  store: WorkerDecisionStore | undefined,
  result: DiskCleanupResult,
  externalKey = `cleanup:${result.targetKey}:${result.reason}`,
): void {
  if (!store) return;
  recordWorkerDecisionRow(store, {
    workerKind: DISK_HEADROOM_WORKER_KIND,
    actionType: 'disk-cleanup',
    externalKey,
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

const WARN_PACED_STREAK = 2;

function isLocalTargetKey(targetKey: string): boolean {
  return !targetKey.startsWith('ssh:');
}

function warnPacedCooldownKey(targetKey: string): string {
  return `cleanup:${targetKey}:warn-paced`;
}

export function createDiskHeadroomWorker(options: DiskHeadroomWorkerOptions): WorkerRuntime {
  const runCheck = options.runCheck ?? runDiskHeadroomCheck;
  const cleanupLocal = options.cleanupLocal ?? cleanupLocalInvokerHome;
  const cleanupRemote = options.cleanupRemote ?? cleanupRemoteInvokerHome;
  const cleanupEnabled = options.cleanupEnabled ?? resolveDiskCleanupEnabled();
  const cooldown = new DiskCleanupCooldownTracker(
    options.cleanupCooldownMs ?? resolveDiskCleanupCooldownMs(),
  );
  const unknownStreaks = new DiskUnknownStreakTracker();
  const warnStreaks = new Map<string, number>();

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
      if (!isEvaluationList(evaluationsRaw)) return;

      for (const evaluation of evaluationsRaw) {
        const shouldAlert = unknownStreaks.recordAndShouldAlert(
          evaluation.label,
          evaluation.level === 'unknown',
        );
        if (!shouldAlert) continue;
        const message = `[disk-headroom] ${evaluation.label} has failed its last ${UNKNOWN_ALERT_STREAK} disk checks — usage can no longer be verified`;
        options.logger.error(message, { module: 'disk-headroom', targetKey: evaluation.label });
        options.writeActivityLog?.('error', message);
        if (options.store) {
          recordWorkerDecisionRow(options.store, {
            workerKind: DISK_HEADROOM_WORKER_KIND,
            actionType: 'disk-check-unknown',
            externalKey: `unknown:${evaluation.label}`,
            subjectType: 'disk-target',
            subjectId: evaluation.label,
            status: 'skipped',
            summary: message,
            reason: evaluation.level === 'unknown' ? evaluation.error : undefined,
          });
        }
      }

      if (!cleanupEnabled) return;

      const warnPacedTargets: DiskHeadroomEvaluation[] = [];
      for (const evaluation of evaluationsRaw) {
        const targetKey = evaluation.label;
        if (!isLocalTargetKey(targetKey)) continue;
        if (evaluation.level !== 'warn') {
          warnStreaks.delete(targetKey);
          continue;
        }
        const next = (warnStreaks.get(targetKey) ?? 0) + 1;
        warnStreaks.set(targetKey, next);
        if (next >= WARN_PACED_STREAK) {
          warnPacedTargets.push(evaluation);
        }
      }

      for (const evaluation of warnPacedTargets) {
        if (ctx.signal?.aborted) return;
        const targetKey = evaluation.label;
        const cooldownKey = warnPacedCooldownKey(targetKey);
        if (!cooldown.canCleanup(cooldownKey)) {
          const skipped: DiskCleanupResult = {
            targetKey,
            ok: false,
            reason: 'cooldown',
          };
          options.logger.info?.(
            `[disk-headroom-cleanup] skip ${targetKey}: warn-paced cooldown`,
            { module: 'disk-headroom', targetKey },
          );
          recordCleanupDecision(options.store, skipped, cooldownKey);
          continue;
        }

        options.logger.info?.(
          `[disk-headroom-cleanup] warn-paced begin ${targetKey}`,
          { module: 'disk-headroom', targetKey },
        );
        const result = await cleanupLocal({
          invokerHome: options.localPath,
          targetKey,
          logger: options.logger,
          store: options.workflowStore,
          mode: 'stale-only',
        });
        const recordedResult: DiskCleanupResult = result.ok
          ? { ...result, reason: 'warn-paced' }
          : result;
        cooldown.markCleaned(cooldownKey);
        options.logger.info?.(
          `[disk-headroom-cleanup] warn-paced done ${targetKey}`,
          { module: 'disk-headroom', targetKey, result: recordedResult },
        );
        recordCleanupDecision(options.store, recordedResult, cooldownKey);
        options.writeActivityLog?.(
          recordedResult.ok ? 'warn' : 'error',
          `[disk-headroom-cleanup] ${recordedResult.reason}: ${recordedResult.targetKey}`
            + (recordedResult.detail ? ` (${recordedResult.detail.slice(0, 200)})` : ''),
        );
      }

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
              store: options.workflowStore,
            });
          }
        } else {
          result = await cleanupLocal({
            invokerHome: options.localPath,
            targetKey,
            logger: options.logger,
            store: options.workflowStore,
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
        workflowStore: config?.workflowStore ?? deps.store,
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
