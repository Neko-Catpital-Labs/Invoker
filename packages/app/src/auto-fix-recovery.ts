/**
 * Auto-fix recovery worker policy.
 *
 * This is the reconcile-loop brain that decides, from *persisted* workflow and
 * task state, which failed tasks deserve an auto-fix and then submits that fix
 * through the exact same command/action route a human operator uses
 * (`invoker:fix-with-agent` with `--auto-fix`). It is intentionally a *policy*,
 * not an executor:
 *
 *   - It never calls `TaskRunner.fixWithAgent` or `autoFixOnFailure` directly.
 *   - It never mutates task state (no `updateTask`, no status writes). The
 *     command route it submits owns the retry-budget increment and the restart.
 *
 * The worker is woken by lifecycle events but governed by the database: every
 * decision re-reads persisted state, so a stale or duplicate wakeup can never
 * cause a double-submit or act on out-of-date generation/attempt information.
 */

import type { Logger } from '@invoker/contracts';
import type { TaskState } from '@invoker/workflow-core';

import { shouldSkipAutoFixForError } from './auto-fix-gating.js';
import { buildFixWithAgentMutationArgs } from './auto-fix-intents.js';
import { createRecoveryWorker, type WorkerRuntime } from './worker-runtime.js';

/**
 * The single command/action route the worker submits through — the same channel
 * a manual operator `fix <taskId> --auto-fix` resolves to.
 */
export const AUTO_FIX_RECOVERY_CHANNEL = 'invoker:fix-with-agent';

/** Why a candidate task was *not* submitted for recovery on this scan. */
export type AutoFixRecoverySkipReason =
  | 'missing'
  | 'not-failed'
  | 'cancelled-error'
  | 'stale-event'
  | 'not-eligible'
  | 'duplicate';

/**
 * Context carried by a lifecycle-event wakeup. The worker treats these as hints
 * only: they identify a task to reconsider and let it discard a wakeup that is
 * older than the persisted state, but the actual decision is made from the DB.
 */
export interface AutoFixRecoveryEvent {
  readonly taskId: string;
  readonly generation?: number;
  readonly attemptId?: string;
  readonly taskStateVersion?: number;
}

/** A recovery submission, shaped for the `invoker:fix-with-agent` command route. */
export interface AutoFixRecoverySubmission {
  readonly channel: typeof AUTO_FIX_RECOVERY_CHANNEL;
  readonly workflowId: string;
  readonly taskId: string;
  readonly agentName?: string;
  /** Mutation args produced by {@link buildFixWithAgentMutationArgs}. */
  readonly args: unknown[];
}

type RecoveryOrchestrator = {
  shouldAutoFix(taskId: string): boolean;
  getTask(taskId: string): TaskState | undefined;
  syncFromDb?(): void;
};

type RecoveryPersistence = {
  listWorkflows(): Array<{ id: string }>;
  loadTasks(workflowId: string): TaskState[];
};

export interface AutoFixRecoveryDeps {
  orchestrator: RecoveryOrchestrator;
  persistence: RecoveryPersistence;
  /**
   * Submits the recovery fix through the shared command route. Production wiring
   * forwards this to the workflow mutation coordinator; tests assert on the
   * submission shape.
   */
  submit: (submission: AutoFixRecoverySubmission) => void | Promise<void>;
  /** Agent to request for the fix (defaults to the operator default downstream). */
  getAutoFixAgent?: () => string | undefined;
  /** Test-observable hook recording why a candidate was skipped. */
  logSkip?: (
    taskId: string,
    reason: AutoFixRecoverySkipReason,
    details?: Record<string, unknown>,
  ) => void;
  logger?: Logger;
}

export interface AutoFixRecoveryScanReport {
  readonly submitted: string[];
  readonly skipped: Array<{ taskId: string; reason: AutoFixRecoverySkipReason }>;
}

export interface AutoFixRecoveryScan {
  /**
   * Reconcile persisted state once. With no event, scans every failed task
   * across all workflows (the startup/poll sweep). With an event, reconsiders
   * only that task, discarding the wakeup if it is stale.
   */
  scan(options?: { event?: AutoFixRecoveryEvent }): Promise<AutoFixRecoveryScanReport>;
}

/**
 * A fingerprint of the exact persisted state we submitted a fix for. A repeated
 * wakeup with the same fingerprint is a duplicate and is skipped; a genuinely
 * new failure (new generation / attempt / version / budget consumed) changes the
 * fingerprint and is eligible to submit again.
 */
function fingerprintOf(task: TaskState): string {
  return [
    task.execution.generation ?? 0,
    task.execution.selectedAttemptId ?? '',
    task.taskStateVersion,
    task.execution.autoFixAttempts ?? 0,
  ].join(':');
}

/** True when an event wakeup is older than the persisted state it points at. */
function isStaleEvent(event: AutoFixRecoveryEvent, task: TaskState): boolean {
  const taskGeneration = task.execution.generation ?? 0;
  if (event.generation != null && event.generation < taskGeneration) return true;
  if (event.taskStateVersion != null && event.taskStateVersion < task.taskStateVersion) return true;
  if (
    event.attemptId != null &&
    task.execution.selectedAttemptId != null &&
    event.attemptId !== task.execution.selectedAttemptId
  ) {
    return true;
  }
  return false;
}

export function createAutoFixRecoveryScan(deps: AutoFixRecoveryDeps): AutoFixRecoveryScan {
  const submittedFingerprints = new Map<string, string>();

  const skip = (
    report: AutoFixRecoveryScanReport,
    taskId: string,
    reason: AutoFixRecoverySkipReason,
    details?: Record<string, unknown>,
  ): void => {
    report.skipped.push({ taskId, reason });
    deps.logSkip?.(taskId, reason, details);
  };

  const considerTask = async (
    taskId: string,
    report: AutoFixRecoveryScanReport,
    event?: AutoFixRecoveryEvent,
  ): Promise<void> => {
    // Always re-read persisted state — the wakeup is only a hint.
    const task = deps.orchestrator.getTask(taskId);
    if (!task) {
      skip(report, taskId, 'missing');
      return;
    }
    if (task.status !== 'failed') {
      skip(report, taskId, 'not-failed', { status: task.status });
      return;
    }
    if (event && isStaleEvent(event, task)) {
      skip(report, taskId, 'stale-event', {
        eventGeneration: event.generation,
        taskGeneration: task.execution.generation ?? 0,
        eventTaskStateVersion: event.taskStateVersion,
        taskStateVersion: task.taskStateVersion,
      });
      return;
    }
    if (shouldSkipAutoFixForError(task.execution.error)) {
      skip(report, taskId, 'cancelled-error');
      return;
    }
    if (!deps.orchestrator.shouldAutoFix(taskId)) {
      skip(report, taskId, 'not-eligible');
      return;
    }
    const fingerprint = fingerprintOf(task);
    if (submittedFingerprints.get(taskId) === fingerprint) {
      skip(report, taskId, 'duplicate', { fingerprint });
      return;
    }

    const agentName = deps.getAutoFixAgent?.();
    const submission: AutoFixRecoverySubmission = {
      channel: AUTO_FIX_RECOVERY_CHANNEL,
      workflowId: task.config.workflowId ?? '',
      taskId,
      ...(agentName ? { agentName } : {}),
      args: buildFixWithAgentMutationArgs(taskId, agentName, { autoFix: true }),
    };
    await deps.submit(submission);
    submittedFingerprints.set(taskId, fingerprint);
    report.submitted.push(taskId);
  };

  const scan = async (options?: { event?: AutoFixRecoveryEvent }): Promise<AutoFixRecoveryScanReport> => {
    // Governed by the database: refresh in-memory state from persistence first.
    deps.orchestrator.syncFromDb?.();
    const report: AutoFixRecoveryScanReport = { submitted: [], skipped: [] };

    if (options?.event) {
      await considerTask(options.event.taskId, report, options.event);
      return report;
    }

    for (const workflow of deps.persistence.listWorkflows()) {
      for (const task of deps.persistence.loadTasks(workflow.id)) {
        if (task.status !== 'failed') continue;
        await considerTask(task.id, report);
      }
    }
    return report;
  };

  return { scan };
}

export interface AutoFixRecoveryWorkerOptions extends AutoFixRecoveryDeps {
  logger: Logger;
  instanceId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
}

/**
 * Build the recovery worker runtime. It runs a startup scan, then reconciles on
 * its poll interval (and on any external wakeup). The tick is the recovery
 * policy — submitting through the command route, never executing directly.
 */
export function createAutoFixRecoveryWorker(options: AutoFixRecoveryWorkerOptions): WorkerRuntime {
  const scan = createAutoFixRecoveryScan(options);
  return createRecoveryWorker({
    logger: options.logger,
    instanceId: options.instanceId,
    intervalMs: options.intervalMs,
    installSignalHandlers: options.installSignalHandlers,
    tickOnStart: true,
    onTick: async () => {
      await scan.scan();
    },
  });
}
