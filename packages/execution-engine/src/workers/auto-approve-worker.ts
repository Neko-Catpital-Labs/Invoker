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

import type { RecoveryWorkerWakeupHint, WorkflowLifecycleEvent } from '../lifecycle-events.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const AUTO_APPROVE_WORKER_KIND = 'autoapprove';
export const DEFAULT_AUTO_APPROVE_WORKER_INTERVAL_MS = 60_000;
const AUTO_APPROVE_COMMAND_CHANNEL = 'invoker:approve';
const AUTO_APPROVE_ACTION_TYPE = 'approve-ai-fix';

type AutoApproveActionStatus = WorkerActionStatus;

export interface AutoApproveWorkerStore {
  listWorkflows(): ReadonlyArray<{ id: string }>;
  loadWorkflow?(workflowId: string): { mergeMode?: string | null; onFinish?: string | null } | undefined;
  loadTasks(workflowId: string): TaskState[];
  loadTask?(taskId: string): TaskState | undefined;
  listWorkflowMutationIntents?(
    workflowId?: string,
    statuses?: WorkflowMutationIntentStatus[],
  ): WorkflowMutationIntent[];
  getWorkerAction?(workerKind: string, externalKey: string): WorkerActionRecord | undefined;
  upsertWorkerAction?(action: WorkerActionWrite): WorkerActionRecord;
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface AutoApproveWorkerSubmitter {
  submit(
    workflowId: string,
    priority: WorkflowMutationPriority,
    channel: typeof AUTO_APPROVE_COMMAND_CHANNEL,
    args: unknown[],
    options?: { deferDrain?: boolean },
  ): number;
}

export interface AutoApproveWorkerConfig {
  enabled?: boolean;
}

export interface AutoApproveWorkerPolicyOptions {
  store: AutoApproveWorkerStore;
  submitter: AutoApproveWorkerSubmitter;
  logger: Logger;
  enabled?: boolean;
  drainWakeupHints?: () => RecoveryWorkerWakeupHint[];
}

export interface AutoApproveWorkerOptions {
  logger: Logger;
  instanceId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  messageBus?: MessageBus;
  autoApprove?: Omit<AutoApproveWorkerPolicyOptions, 'logger' | 'drainWakeupHints'>;
  onTick?: WorkerTick;
}

export type AutoApproveCandidate = {
  taskId: string;
  workflowId: string;
  generation: number;
  taskStateVersion: number;
  attemptId?: string;
  source: 'scan' | 'wakeup';
};

type AutoApproveTaskRef = Omit<AutoApproveCandidate, 'source'>;

type ValidatedAutoApproveCandidate = AutoApproveTaskRef & {
  source: AutoApproveCandidate['source'];
  task: TaskState;
};

type AutoApproveSnapshotMismatchReason =
  | 'stale-workflow'
  | 'stale-generation'
  | 'stale-task-state-version'
  | 'stale-attempt';

type AutoApproveSnapshotComparison =
  | { ok: true; ref: AutoApproveTaskRef }
  | { ok: false; reason: AutoApproveSnapshotMismatchReason; details: Record<string, unknown> };

export function registerAutoApproveWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: AUTO_APPROVE_WORKER_KIND,
    note: 'Approves AI fixes that are awaiting approval after a pending fix error.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createAutoApproveWorker({
        logger: deps.logger,
        messageBus: deps.messageBus,
        autoApprove: {
          store: deps.store,
          submitter: deps.submitter,
          enabled: deps.autoApprove?.enabled,
        },
      }),
  });
  return registry;
}

function workflowIdForTask(task: TaskState): string | undefined {
  return task.config.workflowId ?? task.id.split('/')[0];
}

function taskRefFromTask(task: TaskState): AutoApproveTaskRef | undefined {
  const workflowId = workflowIdForTask(task);
  if (!workflowId) return undefined;
  return {
    taskId: task.id,
    workflowId,
    generation: task.execution.generation ?? 0,
    taskStateVersion: task.taskStateVersion,
    attemptId: task.execution.selectedAttemptId,
  };
}

function candidateFromTask(task: TaskState): AutoApproveCandidate | undefined {
  const ref = taskRefFromTask(task);
  if (!ref) return undefined;
  return { ...ref, source: 'scan' };
}

function shouldAutoApproveReviewReadyTask(
  options: Pick<AutoApproveWorkerPolicyOptions, 'store'>,
  task: TaskState,
): boolean {
  if (!task.config.isMergeNode) return false;
  const workflowId = workflowIdForTask(task);
  if (!workflowId) return false;
  const workflow = options.store.loadWorkflow?.(workflowId);
  if (!workflow) return false;
  return (workflow.mergeMode ?? 'manual') === 'automatic' && (workflow.onFinish ?? 'none') === 'merge';
}

export function listAutoApproveScanCandidates(
  options: Pick<AutoApproveWorkerPolicyOptions, 'store'>,
): AutoApproveCandidate[] {
  const candidates: AutoApproveCandidate[] = [];
  for (const workflow of options.store.listWorkflows()) {
    for (const task of options.store.loadTasks(workflow.id)) {
      const awaitingApprovalFix = task.status === 'awaiting_approval' && task.execution.pendingFixError !== undefined;
      const reviewReadyAutomaticGate = task.status === 'review_ready' && shouldAutoApproveReviewReadyTask(options, task);
      if (!awaitingApprovalFix && !reviewReadyAutomaticGate) continue;
      const candidate = candidateFromTask(task);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

function candidateFromWakeup(wakeup: RecoveryWorkerWakeupHint): AutoApproveCandidate | undefined {
  if (!wakeup.taskId || wakeup.taskStateVersion == null) return undefined;
  return {
    taskId: wakeup.taskId,
    workflowId: wakeup.workflowId,
    generation: wakeup.generation,
    taskStateVersion: wakeup.taskStateVersion,
    attemptId: wakeup.attemptId,
    source: 'wakeup',
  };
}

function dedupeCandidates(candidates: AutoApproveCandidate[]): AutoApproveCandidate[] {
  const seen = new Set<string>();
  const deduped: AutoApproveCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.taskId}:${candidate.generation}:${candidate.taskStateVersion}:${candidate.attemptId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
}

function loadLatestTask(
  candidate: AutoApproveCandidate,
  options: AutoApproveWorkerPolicyOptions,
): TaskState | undefined {
  const direct = options.store.loadTask?.(candidate.taskId);
  if (direct) return direct;
  return options.store.loadTasks(candidate.workflowId).find((task) => task.id === candidate.taskId);
}

function compareCandidateSnapshot(
  candidate: AutoApproveCandidate,
  latest: TaskState,
): AutoApproveSnapshotComparison {
  const latestRef = taskRefFromTask(latest);
  if (!latestRef || latestRef.workflowId !== candidate.workflowId) {
    return { ok: false, reason: 'stale-workflow', details: { latestWorkflowId: latestRef?.workflowId ?? null } };
  }
  if (latestRef.generation !== candidate.generation) {
    return { ok: false, reason: 'stale-generation', details: { latestGeneration: latestRef.generation } };
  }
  if (latestRef.taskStateVersion !== candidate.taskStateVersion) {
    return {
      ok: false,
      reason: 'stale-task-state-version',
      details: { latestTaskStateVersion: latestRef.taskStateVersion },
    };
  }
  if ((latestRef.attemptId ?? null) !== (candidate.attemptId ?? null)) {
    return { ok: false, reason: 'stale-attempt', details: { latestAttemptId: latestRef.attemptId ?? null } };
  }
  return { ok: true, ref: latestRef };
}

function actionExternalKey(candidate: Pick<AutoApproveCandidate, 'taskId' | 'generation' | 'taskStateVersion' | 'attemptId'>): string {
  return `autoapprove:${candidate.taskId}:${candidate.generation}:${candidate.taskStateVersion}:${candidate.attemptId ?? 'no-attempt'}`;
}

function actionIdForExternalKey(externalKey: string): string {
  return `${AUTO_APPROVE_WORKER_KIND}:${externalKey}`;
}

function isOpenOrCompletedActionStatus(status: string): boolean {
  return status === 'queued'
    || status === 'pending'
    || status === 'running'
    || status === 'needs_input'
    || status === 'review_ready'
    || status === 'completed';
}

function coerceActionStatus(status: AutoApproveActionStatus): WorkerActionStatus {
  return status;
}

function recordAutoApproveAction(
  options: AutoApproveWorkerPolicyOptions,
  candidate: AutoApproveCandidate,
  status: AutoApproveActionStatus,
  summary: string,
  payload: Record<string, unknown> = {},
  intentId?: number | string,
): WorkerActionRecord | undefined {
  const externalKey = actionExternalKey(candidate);
  const existing = options.store.getWorkerAction?.(AUTO_APPROVE_WORKER_KIND, externalKey);
  const now = new Date().toISOString();
  return options.store.upsertWorkerAction?.({
    id: existing?.id ?? actionIdForExternalKey(externalKey),
    workerKind: AUTO_APPROVE_WORKER_KIND,
    actionType: AUTO_APPROVE_ACTION_TYPE,
    workflowId: candidate.workflowId,
    taskId: candidate.taskId,
    subjectType: 'task',
    subjectId: candidate.taskId,
    externalKey,
    status: coerceActionStatus(status),
    attemptCount: status === 'queued' || status === 'failed'
      ? (existing?.attemptCount ?? 0) + 1
      : existing?.attemptCount ?? 0,
    ...(intentId !== undefined ? { intentId: String(intentId) } : {}),
    summary,
    payload: {
      taskId: candidate.taskId,
      workflowId: candidate.workflowId,
      generation: candidate.generation,
      taskStateVersion: candidate.taskStateVersion,
      selectedAttemptId: candidate.attemptId ?? null,
      source: candidate.source,
      ...payload,
    },
    updatedAt: now,
    ...(status === 'skipped' || status === 'failed' || status === 'completed' ? { completedAt: now } : {}),
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
    selectedAttemptId: candidate.attemptId ?? null,
    source: candidate.source,
    ...details,
  };
  options.store.logEvent?.(candidate.taskId, 'debug.autoapprove-worker', payload);
  options.logger.debug?.(`[worker:${AUTO_APPROVE_WORKER_KIND}] ${phase}`, {
    module: 'auto-approve-worker',
    taskId: candidate.taskId,
    ...payload,
  });
}

function skipAutoApproveCandidate(
  options: AutoApproveWorkerPolicyOptions,
  candidate: AutoApproveCandidate,
  reason: string,
  details: Record<string, unknown> = {},
): void {
  recordAutoApproveAction(
    options,
    candidate,
    'skipped',
    `Skipped AI fix approval: ${reason}`,
    { reason, ...details },
  );
  logAutoApproveWorkerEvent(options, candidate, 'worker-autoapprove-skip', { reason, ...details });
}

function hasAlreadyRecordedAction(
  options: AutoApproveWorkerPolicyOptions,
  candidate: AutoApproveCandidate,
): boolean {
  const externalKey = actionExternalKey(candidate);
  const existing = options.store.getWorkerAction?.(AUTO_APPROVE_WORKER_KIND, externalKey);
  if (!existing) return false;
  if (!isOpenOrCompletedActionStatus(existing.status)) return false;
  logAutoApproveWorkerEvent(options, candidate, 'worker-autoapprove-skip', {
    reason: 'already-recorded',
    existingStatus: existing.status,
    intentId: existing.intentId ?? null,
  });
  return true;
}

export function isApproveIntentForTask(intent: WorkflowMutationIntent, taskId: string): boolean {
  if (intent.channel === AUTO_APPROVE_COMMAND_CHANNEL) return intent.args[0] === taskId;
  if (intent.channel !== 'headless.exec') return false;
  const firstArg = intent.args[0];
  if (typeof firstArg !== 'object' || firstArg === null || Array.isArray(firstArg)) return false;
  const args = (firstArg as { args?: unknown }).args;
  return Array.isArray(args) && args[0] === 'approve' && args[1] === taskId;
}

function openApprovalIntents(
  options: AutoApproveWorkerPolicyOptions,
  workflowId: string,
  taskId: string,
): WorkflowMutationIntent[] {
  const open = options.store.listWorkflowMutationIntents?.(workflowId, ['queued', 'running']) ?? [];
  return open.filter((intent) => isApproveIntentForTask(intent, taskId));
}

function validateAutoApproveCandidate(
  candidate: AutoApproveCandidate,
  options: AutoApproveWorkerPolicyOptions,
): ValidatedAutoApproveCandidate | undefined {
  const latest = loadLatestTask(candidate, options);
  if (!latest) {
    skipAutoApproveCandidate(options, candidate, 'task-not-found');
    return undefined;
  }

  const snapshotComparison = compareCandidateSnapshot(candidate, latest);
  if (!snapshotComparison.ok) {
    skipAutoApproveCandidate(options, candidate, snapshotComparison.reason, snapshotComparison.details);
    return undefined;
  }

  if (latest.status === 'review_ready') {
    if (!shouldAutoApproveReviewReadyTask(options, latest)) {
      skipAutoApproveCandidate(options, candidate, 'review-ready-ambiguous');
      return undefined;
    }
  } else {
    if (latest.status !== 'awaiting_approval') {
      skipAutoApproveCandidate(options, candidate, 'status-changed', { status: latest.status });
      return undefined;
    }
    if (latest.execution.pendingFixError === undefined) {
      skipAutoApproveCandidate(options, candidate, 'no-pending-fix');
      return undefined;
    }
  }

  if (hasAlreadyRecordedAction(options, candidate)) return undefined;

  const openIntents = openApprovalIntents(options, snapshotComparison.ref.workflowId, candidate.taskId);
  if (openIntents.length > 0) {
    skipAutoApproveCandidate(options, candidate, 'already-queued-intent', {
      existingIntentIds: openIntents.map((intent) => intent.id),
    });
    return undefined;
  }

  return { ...snapshotComparison.ref, source: candidate.source, task: latest };
}

export function collectValidatedAutoApproveCandidates(
  options: AutoApproveWorkerPolicyOptions,
  candidates: AutoApproveCandidate[] = listAutoApproveScanCandidates(options),
): ValidatedAutoApproveCandidate[] {
  return candidates
    .map((candidate) => validateAutoApproveCandidate(candidate, options))
    .filter((candidate): candidate is ValidatedAutoApproveCandidate => Boolean(candidate));
}

export function createAutoApproveTick(options: AutoApproveWorkerPolicyOptions): WorkerTick {
  return async (ctx) => {
    if (options.enabled !== true) return;
    const wakeups = options.drainWakeupHints?.() ?? [];
    const wakeupCandidates = wakeups.map(candidateFromWakeup).filter((c): c is AutoApproveCandidate => Boolean(c));
    const candidates = dedupeCandidates(
      wakeupCandidates.length > 0 && ctx.reason === 'wake'
        ? wakeupCandidates
        : listAutoApproveScanCandidates(options),
    );
    const submittedThisTick = new Set<string>();

    for (const candidate of collectValidatedAutoApproveCandidates(options, candidates)) {
      if (submittedThisTick.has(candidate.taskId)) {
        skipAutoApproveCandidate(options, candidate, 'duplicate-candidate');
        continue;
      }
      const intentId = options.submitter.submit(
        candidate.workflowId,
        'normal',
        AUTO_APPROVE_COMMAND_CHANNEL,
        [candidate.taskId],
      );
      submittedThisTick.add(candidate.taskId);
      recordAutoApproveAction(
        options,
        candidate,
        'queued',
        'Queued AI fix approval',
        { channel: AUTO_APPROVE_COMMAND_CHANNEL },
        intentId,
      );
      logAutoApproveWorkerEvent(options, candidate, 'worker-autoapprove-submitted', {
        intentId,
        channel: AUTO_APPROVE_COMMAND_CHANNEL,
      });
    }
  };
}

function isAwaitingApprovalEvent(event: WorkflowLifecycleEvent): boolean {
  return event.kind === 'task.awaiting_approval' && Boolean(event.taskId);
}

export function createAutoApproveWorker(options: AutoApproveWorkerOptions): WorkerRuntime {
  const pendingWakeups: RecoveryWorkerWakeupHint[] = [];
  let lifecycleUnsubscribe: Unsubscribe | undefined;
  const onTick = options.onTick ?? (
    options.autoApprove
      ? createAutoApproveTick({
        ...options.autoApprove,
        logger: options.logger,
        drainWakeupHints: () => pendingWakeups.splice(0),
      })
      : (() => {})
  );
  const runtime = createWorkerRuntime({
    kind: AUTO_APPROVE_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_AUTO_APPROVE_WORKER_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick,
  });

  if (!options.messageBus || !options.autoApprove || options.onTick) return runtime;

  const start = (): void => {
    if (!lifecycleUnsubscribe) {
      lifecycleUnsubscribe = options.messageBus?.subscribe<WorkflowLifecycleEvent>(
        Channels.WORKFLOW_LIFECYCLE,
        (event) => {
          if (!isAwaitingApprovalEvent(event)) return;
          pendingWakeups.push(event.recoveryWakeup);
          runtime.wake('wake');
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
