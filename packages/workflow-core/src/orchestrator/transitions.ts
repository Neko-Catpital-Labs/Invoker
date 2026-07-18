/**
 * Extracted transition domain.
 *
 * These functions implement worker-response state transitions (completed,
 * failed, review_ready, needs_input, spawn/select experiments) and the
 * post-transition completion checks as standalone functions operating on a
 * `TransitionHost`. The Orchestrator delegates to them, keeping the methods on
 * the class for API compatibility (see `graph-mutation.ts` for the same
 * host-delegation pattern).
 *
 * Behavior is intentionally identical to the previous in-class methods: write
 * order, attempt dual-writes, event names, delta publication, and the
 * downstream auto-start / deferred re-enqueue sequence are preserved exactly.
 */

import type { FailureClass, TaskState, TaskDelta, TaskStateChanges } from '@invoker/workflow-graph';
import type { Logger } from '@invoker/contracts';
import type { ParsedResponse } from '../response-handler.js';
import { scopePlanTaskId } from '../task-id-scope.js';
import { parseMergeConflictError } from '../merge-conflict-error.js';
import type { TaskStateMachine } from '../state-machine.js';
import type { TaskRepository } from '../task-repository.js';
import {
  OrchestratorError,
  OrchestratorErrorCode,
} from '../orchestrator.js';
import type {
  GraphMutation,
  GraphMutationNodeDef,
  OrchestratorPersistence,
  OrchestratorMessageBus,
  TaskLineageExpectation,
  LaunchReadinessOptions,
} from '../orchestrator.js';

const TASK_DELTA_CHANNEL = 'task.delta';

// ── Host Interface ──────────────────────────────────────────

/**
 * Subset of Orchestrator that the transition functions need.
 * Keeps the extracted functions decoupled from the full Orchestrator class.
 */
export interface TransitionHost {
  readonly stateMachine: TaskStateMachine;
  readonly persistence: OrchestratorPersistence;
  readonly messageBus: OrchestratorMessageBus;
  readonly logger: Logger;
  readonly taskRepository: TaskRepository;
  readonly deferredTaskIds: Set<string>;
  readonly activeWorkflowIds: Set<string>;

  stateGetTask(taskId: string): TaskState | undefined;
  writeAndSync(
    taskId: string,
    changes: TaskStateChanges,
    opts?: { skipWorkflowStatusSync?: boolean },
  ): TaskState;
  buildUpdateDelta(before: TaskState, after: TaskState, changes: TaskStateChanges): TaskDelta;
  ensureCurrentPendingAttempt(task: TaskState): string;
  touchWorkflow(workflowId: string): void;
  setTaskApprovalStatus(
    taskId: string,
    status: 'awaiting_approval' | 'review_ready',
    eventName: 'task.awaiting_approval' | 'task.review_ready',
    additionalChanges?: TaskStateChanges,
    expectedLineage?: TaskLineageExpectation,
  ): void;
  applyGraphMutation(mutation: GraphMutation): TaskDelta[];
  selectExperiment(taskId: string, experimentId: string): TaskState[];

  // Scheduler-domain entrypoints (kept as Orchestrator methods that delegate
  // to scheduler-domain.ts); transitions trigger downstream work through them.
  autoStartReadyTasks(taskIds: string[], priority?: number, opts?: LaunchReadinessOptions): TaskState[];
  autoStartUnblockedTasks(): TaskState[];
  autoStartExternallyUnblockedReadyTasks(): TaskState[];
  drainScheduler(): TaskState[];
}

// ── Extracted Functions ─────────────────────────────────────

export function handleCompletedImpl(
  host: TransitionHost,
  taskId: string,
  parsed: Extract<ParsedResponse, { type: 'completed' }>,
): TaskState[] {
  const task = host.stateGetTask(taskId);
  const needsApproval = task?.config.requiresManualApproval === true;

  const execution: {
    exitCode: number;
    completedAt: Date;
    commit?: string;
    agentSessionId?: string;
    agentName?: string;
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
    execution.lastAgentName = parsed.agentName ?? task?.execution.agentName ?? task?.execution.lastAgentName;
  }
  if (parsed.agentName !== undefined) {
    execution.agentName = parsed.agentName;
    execution.lastAgentName = parsed.agentName;
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
  const delta: TaskDelta = host.buildUpdateDelta(task!, completedUpdated, changes);
  const eventName = needsApproval ? 'task.awaiting_approval' : 'task.completed';
  host.persistence.logEvent?.(taskId, eventName, changes);
  host.messageBus.publish(TASK_DELTA_CHANNEL, delta);

  // Dual-write: update current selected attempt to completed (best-effort)
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
  } catch { /* best effort */ }

  // If task requires manual approval, don't trigger downstream tasks yet
  if (needsApproval) return [];

  checkExperimentCompletionImpl(host, taskId);

  const readyTaskIds = host.stateMachine.findNewlyReadyTasks(taskId);
  host.logger.info('[orchestrator] handleCompleted', {
    taskId,
    newlyReadyCount: readyTaskIds.length,
    readyTaskIds,
  });
  const started = host.autoStartReadyTasks(readyTaskIds);
  started.push(...host.autoStartUnblockedTasks());
  started.push(...host.autoStartExternallyUnblockedReadyTasks());

  // Re-enqueue deferred tasks now that a slot freed up
  if (host.deferredTaskIds.size > 0) {
    const deferredTaskIds = [...host.deferredTaskIds]
      .filter((id) => host.stateGetTask(id)?.status === 'pending');
    host.deferredTaskIds.clear();
    started.push(...host.autoStartReadyTasks(deferredTaskIds));
  }

  checkWorkflowCompletionImpl(host);
  return started;
}

/**
 * Marks a task as failed, writes to DB atomically (task + attempt), logs event,
 * publishes delta, checks for newly ready tasks, and returns newly started tasks.
 */
export function finalizeFailedTaskImpl(
  host: TransitionHost,
  taskId: string,
  executionFields: {
    exitCode?: number;
    error?: string;
    agentName?: string;
    lastAgentName?: string;
    protocolErrorCode?: string;
    protocolErrorMessage?: string;
    mergeConflict?: { failedBranch: string; conflictFiles: string[] };
    failureClass?: FailureClass;
  },
  eventName: string,
): TaskState[] {
  const existing = host.stateGetTask(taskId);
  if (!existing) {
    throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `finalizeFailedTask: task ${taskId} not found in graph`);
  }

  const changes: TaskStateChanges = {
    status: 'failed',
    execution: {
      ...executionFields,
      completedAt: new Date(),
    },
  };

  // Atomic write for task + attempt via repository
  host.taskRepository.failTaskAndAttempt(taskId, changes, {
    status: 'failed',
    exitCode: executionFields.exitCode,
    error: executionFields.error,
    completedAt: new Date(),
  });

  // Sync to in-memory state (same pattern as writeAndSync)
  const updated: TaskState = {
    ...existing,
    status: 'failed',
    execution: { ...existing.execution, ...changes.execution },
    taskStateVersion: existing.taskStateVersion + 1,
  };
  host.stateMachine.restoreTask(updated);

  const delta: TaskDelta = host.buildUpdateDelta(existing, updated, changes);
  host.persistence.logEvent?.(taskId, eventName, changes);
  host.messageBus.publish(TASK_DELTA_CHANNEL, delta);

  checkExperimentCompletionImpl(host, taskId);

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

  // Re-enqueue deferred tasks now that a slot freed up
  if (host.deferredTaskIds.size > 0) {
    const deferredTaskIds = [...host.deferredTaskIds]
      .filter((id) => host.stateGetTask(id)?.status === 'pending');
    host.deferredTaskIds.clear();
    started.push(...host.autoStartReadyTasks(deferredTaskIds));
  }

  checkWorkflowCompletionImpl(host);
  return started;
}

export function handleReviewReadyImpl(
  host: TransitionHost,
  taskId: string,
  parsed: Extract<ParsedResponse, { type: 'review_ready' }>,
): TaskState[] {
  const changes: TaskStateChanges = {
    config: { summary: parsed.summary },
    execution: {
      exitCode: parsed.exitCode,
      branch: parsed.branch,
      reviewUrl: parsed.reviewUrl,
      reviewId: parsed.reviewId,
      reviewStatus: parsed.reviewStatus,
      reviewGate: parsed.reviewGate,
    },
  };
  host.setTaskApprovalStatus(taskId, 'review_ready', 'task.review_ready', changes);

  const started = host.autoStartUnblockedTasks();
  started.push(...host.autoStartExternallyUnblockedReadyTasks());
  checkWorkflowCompletionImpl(host);
  return started;
}

export function handleFailedImpl(
  host: TransitionHost,
  taskId: string,
  parsed: Extract<ParsedResponse, { type: 'failed' }>,
): TaskState[] {
  const mergeConflict = parseMergeConflictError(parsed.error);
  return finalizeFailedTaskImpl(
    host,
    taskId,
    {
      exitCode: parsed.exitCode,
      error: parsed.error,
      agentName: parsed.agentName,
      lastAgentName: parsed.agentName,
      failureClass: parsed.failureClass,
      mergeConflict,
    },
    'task.failed',
  );
}

export function handleNeedsInputImpl(
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
  const delta: TaskDelta = host.buildUpdateDelta(needsInputBefore, needsInputUpdated, changes);
  host.persistence.logEvent?.(taskId, 'task.needs_input', changes);
  host.messageBus.publish(TASK_DELTA_CHANNEL, delta);
  return [];
}

export function handleSpawnExperimentsImpl(
  host: TransitionHost,
  taskId: string,
  parsed: Extract<ParsedResponse, { type: 'spawn_experiments' }>,
): TaskState[] {
  const parentTask = host.stateGetTask(taskId);
  const wfId = parentTask?.config.workflowId;
  if (!wfId) {
    host.logger.warn('[orchestrator] handleSpawnExperiments: missing workflowId; skipping', {
      taskId,
    });
    return [];
  }
  const scopeLocal = (local: string) => scopePlanTaskId(wfId, local);

  const experimentTasks: GraphMutationNodeDef[] = parsed.variants.map((v) => ({
    id: scopeLocal(v.id),
    description: v.description ?? `Experiment: ${v.id}`,
    dependencies: [taskId],
    workflowId: wfId,
    parentTask: taskId,
    experimentPrompt: v.prompt,
    prompt: v.prompt,
    command: v.command,
    runnerKind: parentTask?.config.runnerKind,
  }));

  const reconciliationId = `${taskId}-reconciliation`;
  const newNodes: GraphMutationNodeDef[] = [
    ...experimentTasks,
    {
      id: reconciliationId,
      description: `Review and select winning experiment for ${taskId}`,
      dependencies: experimentTasks.map((t) => t.id),
      workflowId: wfId,
      parentTask: taskId,
      isReconciliation: true,
      requiresManualApproval: true,
    },
  ];

  const wf =
    wfId && typeof host.persistence.loadWorkflow === 'function'
      ? host.persistence.loadWorkflow(wfId)
      : undefined;
  const pivotBranch =
    wf && typeof (wf as { baseBranch?: string }).baseBranch === 'string'
      ? (wf as { baseBranch: string }).baseBranch.trim()
      : '';
  const sourceChanges =
    pivotBranch !== '' ? { execution: { branch: pivotBranch } } : undefined;

  host.applyGraphMutation({
    sourceNodeId: taskId,
    sourceDisposition: 'complete',
    sourceChanges,
    newNodes,
    outputNodeId: reconciliationId,
  });

  const readyIds = experimentTasks.map((t) => t.id);
  return host.autoStartReadyTasks(readyIds);
}

export function handleSelectExperimentImpl(
  host: TransitionHost,
  taskId: string,
  parsed: Extract<ParsedResponse, { type: 'select_experiment' }>,
): TaskState[] {
  return host.selectExperiment(taskId, parsed.experimentId);
}

export function checkExperimentCompletionImpl(host: TransitionHost, taskId: string): void {
  for (const recon of host.stateMachine.getAllTasks()) {
    if (!recon.config.isReconciliation) continue;
    if (
      recon.status === 'needs_input' ||
      recon.status === 'completed' ||
      recon.status === 'running' ||
      recon.status === 'fixing_with_ai'
    ) {
      continue;
    }
    if (!recon.dependencies.includes(taskId)) continue;

    const allReported = recon.dependencies.every((depId) => {
      const dep = host.stateGetTask(depId);
      return dep && (dep.status === 'completed' || dep.status === 'failed');
    });

    if (allReported) {
      const experimentResults = recon.dependencies.map((depId) => {
        const dep = host.stateGetTask(depId)!;
        return {
          id: depId,
          status: (dep.status === 'completed' ? 'completed' : 'failed') as 'completed' | 'failed',
          summary: dep.config.summary,
          exitCode: dep.execution.exitCode,
        };
      });

      // Persist results only; reconciliation stays pending until the scheduler runs it.
      // TaskRunner then acquires a worktree and emits `needs_input` (open-terminal cwd).
      const reconChanges: TaskStateChanges = {
        execution: { experimentResults },
      };
      const reconUpdated = host.writeAndSync(recon.id, reconChanges);
      const delta: TaskDelta = host.buildUpdateDelta(recon, reconUpdated, reconChanges);
      host.persistence.logEvent?.(recon.id, 'task.experiment_results_recorded', reconChanges);
      host.messageBus.publish(TASK_DELTA_CHANNEL, delta);
    }
  }
}

export function checkWorkflowCompletionImpl(host: TransitionHost): void {
  for (const wfId of host.activeWorkflowIds) {
    host.touchWorkflow(wfId);
  }
}
