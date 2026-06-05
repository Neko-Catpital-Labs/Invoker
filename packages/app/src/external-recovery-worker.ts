import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@invoker/contracts';
import type { Orchestrator, TaskState } from '@invoker/workflow-core';
import type { MessageBus } from '@invoker/transport';

import type { InvokerConfig } from './config.js';
import {
  createExternalRecoveryLauncher,
  type ExternalRecoveryLauncher,
  type RecoveryContext,
  type RecoveryLaunchResult,
} from './external-failure-recovery.js';
import {
  startWorkerRuntime,
  type WorkerRuntimeController,
  type WorkerRuntimeOptions,
  type WorkerRuntimeScanContext,
  type WorkerRuntimeSubmitContext,
} from './worker-runtime.js';

type ExternalRecoveryWorkerPersistence = {
  listWorkflows(): Array<{ id: string }>;
  loadTasks(workflowId: string): TaskState[];
};

export interface ExternalRecoveryWorkerCandidate {
  readonly workflowId: string;
  readonly taskId: string;
  readonly reason: 'task_failed' | 'task_stalled';
  readonly taskStateVersion: number;
  readonly generation: number;
  readonly attemptId?: string;
}

export interface ExternalRecoveryWorkerOptions {
  readonly logger: Logger;
  readonly messageBus: MessageBus;
  readonly persistence: ExternalRecoveryWorkerPersistence;
  readonly orchestrator?: Pick<Orchestrator, 'syncFromDb'>;
  readonly repoRoot: string;
  readonly dbDir?: string;
  readonly getConfig: () => InvokerConfig;
  readonly launcher?: ExternalRecoveryLauncher;
  readonly launchExternalRecovery?: (
    context: RecoveryContext,
    submitContext: WorkerRuntimeSubmitContext<ExternalRecoveryWorkerCandidate>,
  ) => RecoveryLaunchResult;
  readonly pollIntervalMs?: number;
  readonly startImmediately?: boolean;
  readonly signalTarget?: WorkerRuntimeOptions<ExternalRecoveryWorkerCandidate>['signalTarget'];
  readonly signalNames?: WorkerRuntimeOptions<ExternalRecoveryWorkerCandidate>['signalNames'];
  readonly now?: () => Date;
}

const EXTERNAL_RECOVERY_WORKER_NAME = 'external-recovery';
const ACTIVE_STALL_STATUSES = new Set(['running', 'fixing_with_ai'] as const);

export function startExternalRecoveryWorker(options: ExternalRecoveryWorkerOptions): WorkerRuntimeController {
  const launcher = options.launcher ?? createExternalRecoveryLauncher({
    config: () => options.getConfig().externalFailureRecovery,
  });

  return startWorkerRuntime<ExternalRecoveryWorkerCandidate>({
    name: EXTERNAL_RECOVERY_WORKER_NAME,
    messageBus: options.messageBus,
    logger: options.logger,
    pollIntervalMs: options.pollIntervalMs ?? options.getConfig().workerPollIntervalMs,
    startImmediately: options.startImmediately,
    signalTarget: options.signalTarget,
    signalNames: options.signalNames,
    relevantLifecycleEvents: (event) => (
      event.kind === 'task.failed'
      || event.kind === 'task.updated'
      || event.kind === 'workflow.wakeup'
    ),
    scan: (context) => scanExternalRecoveryCandidates(options, context),
    submit: (candidate, context) => submitExternalRecoveryCandidate(options, launcher, candidate, context),
    now: options.now,
  });
}

export function scanExternalRecoveryCandidates(
  options: Pick<ExternalRecoveryWorkerOptions, 'logger' | 'persistence' | 'orchestrator' | 'getConfig' | 'now'>,
  context: WorkerRuntimeScanContext,
): ExternalRecoveryWorkerCandidate[] {
  const config = options.getConfig().externalFailureRecovery;
  if (!config || config.enabled !== true) return [];

  const recoverFailedTasks = config.recoverFailedTasks !== false;
  const stalledTaskSeconds = typeof config.stalledTaskSeconds === 'number'
    ? Math.max(0, config.stalledTaskSeconds)
    : 0;
  const recoverStalledTasks = stalledTaskSeconds > 0;
  if (!recoverFailedTasks && !recoverStalledTasks) return [];

  const nowMs = (options.now?.() ?? new Date()).getTime();
  const candidates: ExternalRecoveryWorkerCandidate[] = [];
  const seen = new Set<string>();

  for (const workflow of options.persistence.listWorkflows()) {
    options.orchestrator?.syncFromDb(workflow.id);
    for (const task of options.persistence.loadTasks(workflow.id)) {
      const candidate = buildExternalRecoveryCandidate(task, {
        recoverFailedTasks,
        recoverStalledTasks,
        stalledTaskSeconds,
        nowMs,
      });
      if (!candidate) continue;
      const key = externalRecoveryCandidateKey(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
    }
  }

  if (candidates.length > 0) {
    options.logger.info('external recovery worker found eligible task(s)', {
      module: 'external-recovery-worker',
      triggerKind: context.trigger.kind,
      count: candidates.length,
    });
  }
  return candidates;
}

function buildExternalRecoveryCandidate(
  task: TaskState,
  policy: {
    readonly recoverFailedTasks: boolean;
    readonly recoverStalledTasks: boolean;
    readonly stalledTaskSeconds: number;
    readonly nowMs: number;
  },
): ExternalRecoveryWorkerCandidate | undefined {
  const workflowId = task.config.workflowId;
  if (!workflowId) return undefined;

  if (policy.recoverFailedTasks && task.status === 'failed') {
    return {
      workflowId,
      taskId: task.id,
      reason: 'task_failed',
      taskStateVersion: task.taskStateVersion,
      generation: task.execution.generation ?? 0,
      ...(task.execution.selectedAttemptId ? { attemptId: task.execution.selectedAttemptId } : {}),
    };
  }

  if (
    policy.recoverStalledTasks
    && ACTIVE_STALL_STATUSES.has(task.status as 'running' | 'fixing_with_ai')
    && isTaskHeartbeatStalled(task, policy.nowMs, policy.stalledTaskSeconds)
  ) {
    return {
      workflowId,
      taskId: task.id,
      reason: 'task_stalled',
      taskStateVersion: task.taskStateVersion,
      generation: task.execution.generation ?? 0,
      ...(task.execution.selectedAttemptId ? { attemptId: task.execution.selectedAttemptId } : {}),
    };
  }

  return undefined;
}

function isTaskHeartbeatStalled(task: TaskState, nowMs: number, stalledTaskSeconds: number): boolean {
  const heartbeat = task.execution.lastHeartbeatAt ?? task.execution.startedAt;
  if (!heartbeat) return false;
  return nowMs - heartbeat.getTime() >= stalledTaskSeconds * 1000;
}

async function submitExternalRecoveryCandidate(
  options: ExternalRecoveryWorkerOptions,
  launcher: ExternalRecoveryLauncher,
  candidate: ExternalRecoveryWorkerCandidate,
  context: WorkerRuntimeSubmitContext<ExternalRecoveryWorkerCandidate>,
): Promise<void> {
  const recoveryContext = buildExternalRecoveryContext(candidate, options);
  const result = options.launchExternalRecovery
    ? options.launchExternalRecovery(recoveryContext, context)
    : launcher.launch(recoveryContext);

  logExternalRecoveryLaunchResult(options.logger, candidate, result);
}

export function buildExternalRecoveryContext(
  candidate: ExternalRecoveryWorkerCandidate,
  options: Pick<ExternalRecoveryWorkerOptions, 'repoRoot' | 'dbDir'>,
): RecoveryContext {
  return {
    failedTaskId: candidate.taskId,
    failedWorkflowId: candidate.workflowId,
    repoRoot: options.repoRoot,
    dbDir: options.dbDir ?? resolveInvokerDbDir(),
    reason: candidate.reason,
  };
}

function externalRecoveryCandidateKey(candidate: ExternalRecoveryWorkerCandidate): string {
  return [
    candidate.workflowId,
    candidate.taskId,
    candidate.reason,
    candidate.generation,
    candidate.attemptId ?? 'no-attempt',
    candidate.taskStateVersion,
  ].join(':');
}

function resolveInvokerDbDir(): string {
  return process.env.INVOKER_DB_DIR ?? join(homedir(), '.invoker');
}

function logExternalRecoveryLaunchResult(
  logger: Logger,
  candidate: ExternalRecoveryWorkerCandidate,
  result: RecoveryLaunchResult,
): void {
  const details = {
    module: 'external-recovery-worker',
    taskId: candidate.taskId,
    workflowId: candidate.workflowId,
    reason: candidate.reason,
  };

  switch (result.status) {
    case 'launched':
      logger.info('external recovery launched', { ...details, pid: result.pid });
      return;
    case 'cooldown':
      logger.info('external recovery launch skipped by cooldown', {
        ...details,
        remainingSeconds: result.remainingSeconds,
      });
      return;
    case 'disabled':
    case 'missing-command':
      logger.warn('external recovery launch skipped by configuration', {
        ...details,
        status: result.status,
      });
      return;
    case 'spawn-error':
      logger.error('external recovery launch failed', {
        ...details,
        err: result.error,
      });
      return;
  }
}
