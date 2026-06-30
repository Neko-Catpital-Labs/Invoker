import type { Logger } from '@invoker/contracts';
import type {
  WorkerActionRecord,
  WorkerActionStatus,
  WorkerActionWrite,
  WorkflowMutationIntent,
  WorkflowMutationIntentStatus,
  WorkflowMutationPriority,
} from '@invoker/data-store';
import { Channels, type MessageBus, type Unsubscribe } from '@invoker/transport';
import type { TaskState } from '@invoker/workflow-core';

import type { WorkflowLifecycleEvent } from '../lifecycle-events.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const AUTO_APPROVE_WORKER_KIND = 'autoapprove';

const DEFAULT_AUTO_APPROVE_POLL_INTERVAL_MS = 60_000;
const HEADLESS_EXEC_CHANNEL = 'headless.exec';
const AUTO_APPROVE_ACTION_TYPE = 'approve-ai-fix';

type AutoApproveActionStatus = WorkerActionStatus | 'stale';

export interface AutoApproveWorkerStore {
  listWorkflows(): ReadonlyArray<{ id: string }>;
  loadTasks(workflowId: string): TaskState[];
  loadTask?(taskId: string): TaskState | undefined;
  listWorkflowMutationIntents?(
    workflowId?: string,
    statuses?: WorkflowMutationIntentStatus[],
  ): WorkflowMutationIntent[];
  getWorkerAction?(workerKind: string, externalKey: string): WorkerActionRecord | undefined;
  upsertWorkerAction?(action: WorkerActionWrite): WorkerActionRecord;
  listWorkerActions?(filters?: { workerKind?: string; status?: string; limit?: number }): WorkerActionRecord[];
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface AutoApproveWorkerSubmitter {
  submit(
    workflowId: string,
    priority: WorkflowMutationPriority,
    channel: typeof HEADLESS_EXEC_CHANNEL,
    args: unknown[],
    options?: { deferDrain?: boolean },
  ): number;
}

export interface AutoApproveWorkerPolicyOptions {
  store: AutoApproveWorkerStore;
  submitter: AutoApproveWorkerSubmitter;
  logger: Logger;
  getAutoApproveAIFixes?: () => boolean | undefined;
}

export interface AutoApproveCandidate {
  taskId: string;
  workflowId: string;
  generation: number;
  taskStateVersion: number;
  attemptId?: string;
  pendingFixError?: string;
  task: TaskState;
}

function workflowIdForTask(task: TaskState, fallbackWorkflowId?: string): string | undefined {
  return task.config.workflowId ?? fallbackWorkflowId ?? task.id.split('/')[0];
}

export function autoApproveActionKey(candidate: Pick<AutoApproveCandidate, 'taskId' | 'generation' | 'taskStateVersion' | 'attemptId'>): string {
  return [
    candidate.taskId,
    `g${candidate.generation}`,
    `v${candidate.taskStateVersion}`,
    `a${candidate.attemptId ?? 'none'}`,
  ].join(':');
}

function candidateFromTask(task: TaskState, fallbackWorkflowId?: string): AutoApproveCandidate | undefined {
  const workflowId = workflowIdForTask(task, fallbackWorkflowId);
  if (!workflowId) return undefined;
  return {
    taskId: task.id,
    workflowId,
    generation: task.execution.generation ?? 0,
    taskStateVersion: task.taskStateVersion,
    attemptId: task.execution.selectedAttemptId,
    pendingFixError: task.execution.pendingFixError,
    task,
  };
}

export function listAutoApproveScanCandidates(
  options: Pick<AutoApproveWorkerPolicyOptions, 'store'>,
): AutoApproveCandidate[] {
  const candidates: AutoApproveCandidate[] = [];
  for (const workflow of options.store.listWorkflows()) {
    for (const task of options.store.loadTasks(workflow.id)) {
      if (task.status !== 'awaiting_approval') continue;
      const candidate = candidateFromTask(task, workflow.id);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

function isOpenActionStatus(status: string): boolean {
  return status === 'queued' || status === 'pending' || status === 'running';
}

function isTerminalQueuedActionStatus(status: string): boolean {
  return isOpenActionStatus(status) || status === 'completed';
}

function coerceActionStatus(status: AutoApproveActionStatus): WorkerActionStatus {
  return status as WorkerActionStatus;
}

function actionIdForKey(externalKey: string): string {
  return `${AUTO_APPROVE_WORKER_KIND}:${externalKey}`;
}

function taskPayload(candidate: AutoApproveCandidate, payload: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    generation: candidate.generation,
    taskStateVersion: candidate.taskStateVersion,
    attemptId: candidate.attemptId ?? null,
    hasPendingFixError: candidate.pendingFixError !== undefined,
    ...payload,
  };
}

function recordAutoApproveAction(
  options: AutoApproveWorkerPolicyOptions,
  candidate: AutoApproveCandidate,
  status: AutoApproveActionStatus,
  summary: string,
  payload: Record<string, unknown> = {},
  intentId?: number | string,
): WorkerActionRecord | undefined {
  const externalKey = autoApproveActionKey(candidate);
  const existing = options.store.getWorkerAction?.(AUTO_APPROVE_WORKER_KIND, externalKey);
  const now = new Date().toISOString();
  return options.store.upsertWorkerAction?.({
    id: existing?.id ?? actionIdForKey(externalKey),
    workerKind: AUTO_APPROVE_WORKER_KIND,
    actionType: AUTO_APPROVE_ACTION_TYPE,
    workflowId: candidate.workflowId,
    taskId: candidate.taskId,
    subjectType: 'task',
    subjectId: candidate.taskId,
    externalKey,
    status: coerceActionStatus(status),
    attemptCount: status === 'queued' ? (existing?.attemptCount ?? 0) + 1 : existing?.attemptCount ?? 0,
    ...(intentId !== undefined ? { intentId: String(intentId) } : {}),
    summary,
    payload: taskPayload(candidate, payload),
    updatedAt: now,
    ...(status === 'skipped' || status === 'stale' ? { completedAt: now } : {}),
  });
}

function logAutoApproveWorkerEvent(
  options: AutoApproveWorkerPolicyOptions,
  candidate: AutoApproveCandidate,
  phase: string,
  details: Record<string, unknown>,
): void {
  const payload = {
    phase,
    worker: AUTO_APPROVE_WORKER_KIND,
    workflowId: candidate.workflowId,
    generation: candidate.generation,
    taskStateVersion: candidate.taskStateVersion,
    attemptId: candidate.attemptId ?? null,
    ...details,
  };
  options.store.logEvent?.(candidate.taskId, 'debug.auto-approve', payload);
  options.logger.debug?.(`[worker:${AUTO_APPROVE_WORKER_KIND}] ${phase}`, {
    module: 'auto-approve-worker',
    taskId: candidate.taskId,
    ...payload,
  });
}

type HeadlessExecPayload = {
  args?: unknown[];
};

function isApproveIntentForTask(intent: WorkflowMutationIntent, taskId: string): boolean {
  if (intent.channel !== HEADLESS_EXEC_CHANNEL) return false;
  const payload = intent.args[0] as HeadlessExecPayload | undefined;
  const args = Array.isArray(payload?.args) ? payload.args : [];
  return args[0] === 'approve' && args[1] === taskId;
}

function listOpenApproveIntentsForTask(
  options: AutoApproveWorkerPolicyOptions,
  candidate: AutoApproveCandidate,
): WorkflowMutationIntent[] {
  const open = options.store.listWorkflowMutationIntents?.(candidate.workflowId, ['queued', 'running']) ?? [];
  return open.filter((intent) => isApproveIntentForTask(intent, candidate.taskId));
}

function loadTaskForAction(
  options: AutoApproveWorkerPolicyOptions,
  action: WorkerActionRecord,
): TaskState | undefined {
  if (action.taskId) {
    const direct = options.store.loadTask?.(action.taskId);
    if (direct) return direct;
  }
  if (!action.workflowId) return undefined;
  return options.store.loadTasks(action.workflowId).find((task) => task.id === action.taskId);
}

function staleReasonForAction(
  action: WorkerActionRecord,
  task: TaskState | undefined,
): { stale: true; reason: string; candidate?: AutoApproveCandidate } | { stale: false; candidate?: AutoApproveCandidate } {
  if (!task) {
    return { stale: true, reason: 'task-not-found' };
  }
  const candidate = candidateFromTask(task, action.workflowId);
  if (!candidate) {
    return { stale: true, reason: 'workflow-not-found' };
  }
  if (task.status !== 'awaiting_approval') {
    return { stale: true, reason: 'status-changed', candidate };
  }
  if (task.execution.pendingFixError === undefined) {
    return { stale: true, reason: 'pending-fix-cleared', candidate };
  }
  if (autoApproveActionKey(candidate) !== action.externalKey) {
    return { stale: true, reason: 'lineage-changed', candidate };
  }
  return { stale: false, candidate };
}

function markStaleQueuedActions(options: AutoApproveWorkerPolicyOptions): void {
  const actions = options.store.listWorkerActions?.({ workerKind: AUTO_APPROVE_WORKER_KIND }) ?? [];
  for (const action of actions) {
    if (!isOpenActionStatus(action.status)) continue;
    const task = loadTaskForAction(options, action);
    const stale = staleReasonForAction(action, task);
    if (!stale.stale) continue;
    const candidate = stale.candidate ?? {
      taskId: action.taskId ?? action.subjectId,
      workflowId: action.workflowId ?? '',
      generation: 0,
      taskStateVersion: 0,
      task: task ?? ({
        id: action.taskId ?? action.subjectId,
        description: '',
        status: 'stale',
        dependencies: [],
        createdAt: new Date(0),
        config: {},
        execution: {},
        taskStateVersion: 0,
      } as TaskState),
    };
    recordAutoApproveAction(options, candidate, 'stale', `Stale auto-approval: ${stale.reason}`, {
      reason: stale.reason,
      previousStatus: action.status,
      previousExternalKey: action.externalKey,
      latestStatus: task?.status ?? null,
    }, action.intentId);
    logAutoApproveWorkerEvent(options, candidate, 'worker-autoapprove-stale', {
      reason: stale.reason,
      previousExternalKey: action.externalKey,
      previousStatus: action.status,
    });
  }
}

export function createAutoApproveTick(options: AutoApproveWorkerPolicyOptions): WorkerTick {
  return async () => {
    markStaleQueuedActions(options);
    const enabled = options.getAutoApproveAIFixes?.() === true;
    const submittedThisTick = new Set<string>();

    for (const candidate of listAutoApproveScanCandidates(options)) {
      const externalKey = autoApproveActionKey(candidate);
      if (submittedThisTick.has(externalKey)) {
        recordAutoApproveAction(options, candidate, 'skipped', 'Skipped duplicate auto-approval candidate', {
          reason: 'duplicate-candidate',
        });
        continue;
      }
      if (candidate.pendingFixError === undefined) {
        recordAutoApproveAction(options, candidate, 'skipped', 'Skipped non-AI approval gate', {
          reason: 'missing-pending-fix-error',
        });
        logAutoApproveWorkerEvent(options, candidate, 'worker-autoapprove-skip', {
          reason: 'missing-pending-fix-error',
        });
        continue;
      }
      if (!enabled) {
        recordAutoApproveAction(options, candidate, 'skipped', 'Skipped auto-approval because autoApproveAIFixes is disabled', {
          reason: 'auto-approve-disabled',
        });
        logAutoApproveWorkerEvent(options, candidate, 'worker-autoapprove-skip', {
          reason: 'auto-approve-disabled',
        });
        continue;
      }

      const existing = options.store.getWorkerAction?.(AUTO_APPROVE_WORKER_KIND, externalKey);
      if (existing && isTerminalQueuedActionStatus(existing.status)) {
        logAutoApproveWorkerEvent(options, candidate, 'worker-autoapprove-skip', {
          reason: 'already-recorded',
          existingStatus: existing.status,
          intentId: existing.intentId ?? null,
        });
        continue;
      }

      const openApproveIntents = listOpenApproveIntentsForTask(options, candidate);
      if (openApproveIntents.length > 0) {
        const intentId = openApproveIntents[0]?.id;
        recordAutoApproveAction(options, candidate, 'queued', 'Auto-approval already queued', {
          reason: 'already-queued-intent',
          existingIntentIds: openApproveIntents.map((intent) => intent.id),
        }, intentId);
        submittedThisTick.add(externalKey);
        continue;
      }

      const intentId = options.submitter.submit(candidate.workflowId, 'normal', HEADLESS_EXEC_CHANNEL, [
        { args: ['approve', candidate.taskId], noTrack: true },
      ]);
      recordAutoApproveAction(options, candidate, 'queued', 'Queued auto-approval for AI fix', {
        channel: HEADLESS_EXEC_CHANNEL,
      }, intentId);
      submittedThisTick.add(externalKey);
      logAutoApproveWorkerEvent(options, candidate, 'worker-autoapprove-submitted', {
        intentId,
        channel: HEADLESS_EXEC_CHANNEL,
      });
    }
  };
}

export interface AutoApproveWorkerOptions {
  logger: Logger;
  instanceId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  messageBus?: MessageBus;
  autoApprove?: Omit<AutoApproveWorkerPolicyOptions, 'logger'>;
  onTick?: WorkerTick;
}

export function createAutoApproveWorker(options: AutoApproveWorkerOptions): WorkerRuntime {
  let lifecycleUnsubscribe: Unsubscribe | undefined;
  const onTick = options.onTick ?? (
    options.autoApprove
      ? createAutoApproveTick({
        ...options.autoApprove,
        logger: options.logger,
      })
      : (() => {})
  );
  const runtime = createWorkerRuntime({
    kind: AUTO_APPROVE_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_AUTO_APPROVE_POLL_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick,
  });

  if (!options.messageBus || !options.autoApprove || options.onTick) {
    return runtime;
  }

  const start = (): void => {
    if (!lifecycleUnsubscribe) {
      lifecycleUnsubscribe = options.messageBus?.subscribe<WorkflowLifecycleEvent>(
        Channels.WORKFLOW_LIFECYCLE,
        (event) => {
          if (event.kind === 'task.awaiting_approval') {
            runtime.wake('wake');
          }
        },
      );
    }
    runtime.start();
  };
  const stop = async (): Promise<void> => {
    lifecycleUnsubscribe?.();
    lifecycleUnsubscribe = undefined;
    await runtime.stop();
  };

  return {
    identity: runtime.identity,
    start,
    wake: runtime.wake,
    tick: runtime.tick,
    stop,
    isRunning: runtime.isRunning,
  };
}
