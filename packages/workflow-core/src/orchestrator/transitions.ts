import type { TaskDelta, TaskState, TaskStateChanges, Attempt } from '@invoker/workflow-graph';
import type { Logger } from '@invoker/contracts';
import type { ParsedResponse } from '../response-handler.js';
import type { OrchestratorMessageBus, OrchestratorPersistence } from '../orchestrator.js';
import type { TaskScheduler } from '../scheduler.js';
import type { TaskRepository } from '../task-repository.js';
import type { TaskStateMachine } from '../state-machine.js';
import { publishTaskDelta } from './events.js';

function tryParseJsonObject(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function parseMergeConflictError(
  value: string | undefined,
): { failedBranch: string; conflictFiles: string[] } | undefined {
  const obj = tryParseJsonObject(value);
  if (obj?.type !== 'merge_conflict') return undefined;

  const failedBranch = typeof obj.failedBranch === 'string' ? obj.failedBranch : '';
  const conflictFiles = Array.isArray(obj.conflictFiles)
    ? obj.conflictFiles.filter((file): file is string => typeof file === 'string')
    : [];
  return { failedBranch, conflictFiles };
}

export interface TransitionHost {
  readonly stateMachine: TaskStateMachine;
  readonly persistence: OrchestratorPersistence;
  readonly messageBus: OrchestratorMessageBus;
  readonly taskRepository: TaskRepository;
  readonly scheduler: TaskScheduler;
  readonly logger: Logger;
  readonly deferredTaskIds: Set<string>;

  stateGetTask(taskId: string): TaskState | undefined;
  writeAndSync(taskId: string, changes: TaskStateChanges): TaskState;
  buildUpdateDelta(before: TaskState, after: TaskState, changes: TaskStateChanges): TaskDelta;
  taskNotFound(message: string): Error;
  checkExperimentCompletion(taskId: string): void;
  checkWorkflowCompletion(): void;
  autoStartReadyTasks(taskIds: string[]): TaskState[];
  autoStartUnblockedTasks(): TaskState[];
  autoStartExternallyUnblockedReadyTasks(): TaskState[];
  ensureCurrentPendingAttempt(task: TaskState): string;
  drainScheduler(): TaskState[];
}

function reenqueueDeferredTasks(host: TransitionHost, started: TaskState[]): void {
  if (host.deferredTaskIds.size === 0) return;

  for (const id of host.deferredTaskIds) {
      const task = host.stateGetTask(id);
      if (task && task.status === 'pending') {
        const attemptId = host.ensureCurrentPendingAttempt(task);
      host.scheduler.enqueue({ taskId: id, attemptId, priority: 0 });
    }
  }
  host.deferredTaskIds.clear();
  started.push(...host.drainScheduler());
}

export function handleCompletedDomain(
  host: TransitionHost,
  taskId: string,
  parsed: Extract<ParsedResponse, { type: 'completed' }>,
): TaskState[] {
  const task = host.stateGetTask(taskId);
  if (!task) {
    throw host.taskNotFound(`handleCompleted: task ${taskId} not found in graph`);
  }

  const needsApproval = task.config.requiresManualApproval === true;
  const execution: {
    exitCode: number;
    completedAt: Date;
    commit?: string;
    agentSessionId?: string;
    lastAgentSessionId?: string;
    lastAgentName?: string;
    branch?: string;
    reviewUrl?: string;
    reviewId?: string;
    reviewStatus?: string;
  } = {
    exitCode: parsed.exitCode,
    completedAt: new Date(),
  };
  if (parsed.commitHash !== undefined) {
    execution.commit = parsed.commitHash;
  }
  if (parsed.agentSessionId !== undefined) {
    execution.agentSessionId = parsed.agentSessionId;
    execution.lastAgentSessionId = parsed.agentSessionId;
    execution.lastAgentName = task.execution.agentName ?? task.execution.lastAgentName;
  }
  if (parsed.branch !== undefined) {
    execution.branch = parsed.branch;
  }
  if (parsed.reviewUrl !== undefined) {
    execution.reviewUrl = parsed.reviewUrl;
  }
  if (parsed.reviewId !== undefined) {
    execution.reviewId = parsed.reviewId;
  }
  if (parsed.reviewStatus !== undefined) {
    execution.reviewStatus = parsed.reviewStatus;
  }

  const changes: TaskStateChanges = {
    status: needsApproval ? 'awaiting_approval' : 'completed',
    config: { summary: parsed.summary },
    execution,
  };
  const completedUpdated = host.writeAndSync(taskId, changes);
  const delta = host.buildUpdateDelta(task, completedUpdated, changes);
  const eventName = needsApproval ? 'task.awaiting_approval' : 'task.completed';
  host.persistence.logEvent?.(taskId, eventName, changes);
  publishTaskDelta(host, delta);

  try {
    const currentAttemptId = host.stateGetTask(taskId)?.execution.selectedAttemptId;
    const currentAttempt = currentAttemptId ? host.persistence.loadAttempt(currentAttemptId) : undefined;
    if (currentAttempt && currentAttempt.status === 'running') {
      host.taskRepository.updateAttempt(currentAttempt.id, {
        status: needsApproval ? 'needs_input' : 'completed',
        exitCode: parsed.exitCode,
        completedAt: new Date(),
        ...(parsed.commitHash !== undefined ? { commit: parsed.commitHash } : {}),
        ...(parsed.agentSessionId !== undefined ? { agentSessionId: parsed.agentSessionId } : {}),
      });
    }
  } catch {
    /* best effort */
  }

  if (needsApproval) return [];

  host.checkExperimentCompletion(taskId);

  const readyTaskIds = host.stateMachine.findNewlyReadyTasks(taskId);
  host.logger.info('[orchestrator] handleCompleted', {
    taskId,
    newlyReadyCount: readyTaskIds.length,
    readyTaskIds,
  });
  const started = host.autoStartReadyTasks(readyTaskIds);
  started.push(...host.autoStartUnblockedTasks());
  started.push(...host.autoStartExternallyUnblockedReadyTasks());
  reenqueueDeferredTasks(host, started);

  host.checkWorkflowCompletion();
  return started;
}

export function finalizeFailedTaskDomain(
  host: TransitionHost,
  taskId: string,
  executionFields: {
    exitCode?: number;
    error?: string;
    protocolErrorCode?: string;
    protocolErrorMessage?: string;
    mergeConflict?: { failedBranch: string; conflictFiles: string[] };
  },
  eventName: string,
): TaskState[] {
  const existing = host.stateGetTask(taskId);
  if (!existing) {
    throw host.taskNotFound(`finalizeFailedTask: task ${taskId} not found in graph`);
  }

  const changes: TaskStateChanges = {
    status: 'failed',
    execution: {
      ...executionFields,
      completedAt: new Date(),
    },
  };

  host.taskRepository.failTaskAndAttempt(taskId, changes, {
    status: 'failed',
    exitCode: executionFields.exitCode,
    error: executionFields.error,
    completedAt: new Date(),
  });

  const updated: TaskState = {
    ...existing,
    status: 'failed',
    execution: { ...existing.execution, ...changes.execution },
    taskStateVersion: existing.taskStateVersion + 1,
  };
  host.stateMachine.restoreTask(updated);

  const delta = host.buildUpdateDelta(existing, updated, changes);
  host.persistence.logEvent?.(taskId, eventName, changes);
  publishTaskDelta(host, delta);

  host.checkExperimentCompletion(taskId);

  const readyTaskIds = host.stateMachine.findNewlyReadyTasks(taskId);
  host.logger.info('[orchestrator] finalizeFailedTask', {
    taskId,
    eventName,
    newlyReadyCount: readyTaskIds.length,
    readyTaskIds,
  });
  const started = host.autoStartReadyTasks(readyTaskIds);
  started.push(...host.autoStartUnblockedTasks());
  started.push(...host.autoStartExternallyUnblockedReadyTasks());
  reenqueueDeferredTasks(host, started);

  host.checkWorkflowCompletion();
  return started;
}

export function handleReviewReadyDomain(
  host: TransitionHost,
  taskId: string,
  parsed: Extract<ParsedResponse, { type: 'review_ready' }>,
  setTaskApprovalStatus: (
    taskId: string,
    status: 'awaiting_approval' | 'review_ready',
    eventName: 'task.awaiting_approval' | 'task.review_ready',
    additionalChanges?: TaskStateChanges,
  ) => void,
): TaskState[] {
  const changes: TaskStateChanges = {
    config: { summary: parsed.summary },
    execution: {
      exitCode: parsed.exitCode,
      branch: parsed.branch,
      reviewUrl: parsed.reviewUrl,
      reviewId: parsed.reviewId,
      reviewStatus: parsed.reviewStatus,
    },
  };
  setTaskApprovalStatus(taskId, 'review_ready', 'task.review_ready', changes);

  const started = host.autoStartUnblockedTasks();
  started.push(...host.autoStartExternallyUnblockedReadyTasks());
  host.checkWorkflowCompletion();
  return started;
}

export function handleFailedDomain(
  host: TransitionHost,
  taskId: string,
  parsed: Extract<ParsedResponse, { type: 'failed' }>,
): TaskState[] {
  const mergeConflict = parseMergeConflictError(parsed.error);
  return finalizeFailedTaskDomain(
    host,
    taskId,
    {
      exitCode: parsed.exitCode,
      error: parsed.error,
      mergeConflict,
    },
    'task.failed',
  );
}

export function handleNeedsInputDomain(
  host: TransitionHost,
  taskId: string,
  parsed: Extract<ParsedResponse, { type: 'needs_input' }>,
): TaskState[] {
  const changes: TaskStateChanges = {
    status: 'needs_input',
    execution: { inputPrompt: parsed.prompt },
  };
  const needsInputBefore = host.stateGetTask(taskId)!;
  const needsInputUpdated = host.writeAndSync(taskId, changes);
  const currentAttemptId = needsInputUpdated.execution.selectedAttemptId;
  if (currentAttemptId) {
    host.taskRepository.updateAttempt(currentAttemptId, { status: 'needs_input' });
  }
  const delta = host.buildUpdateDelta(needsInputBefore, needsInputUpdated, changes);
  host.persistence.logEvent?.(taskId, 'task.needs_input', changes);
  publishTaskDelta(host, delta);
  return [];
}
