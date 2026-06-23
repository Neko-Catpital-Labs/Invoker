/**
 * Extracted merge / conflict-resolution domain.
 *
 * These functions implement the merge-experiment lifecycle that lives on the
 * orchestrator rather than in the graph layer: the fresh-base recreate flow,
 * the AI conflict-resolution / auto-fix session transitions, and merge-node
 * lookup. They run as standalone functions operating on a `MergeHost`, with
 * the Orchestrator delegating to them for API compatibility (see
 * `graph-mutation.ts` for the same host-delegation pattern; the structural
 * merge-leaf invariants stay in `graph-mutation.ts`).
 *
 * Behavior is intentionally identical to the previous in-class methods: write
 * order, attempt dual-writes, event names, and delta publication are preserved
 * exactly so merge/experiment behavior and the TASK_DELTA contract stay stable.
 */

import type { TaskState, TaskDelta, TaskStateChanges, Attempt } from '@invoker/workflow-graph';
import type { Logger } from '@invoker/contracts';
import { parseMergeConflictError } from '../merge-conflict-error.js';
import type { TaskStateMachine } from '../state-machine.js';
import type { TaskRepository } from '../task-repository.js';
import {
  OrchestratorError,
  OrchestratorErrorCode,
} from '../orchestrator.js';
import type {
  OrchestratorPersistence,
  TaskLineageExpectation,
} from '../orchestrator.js';
import { buildTaskUpdateDelta, publishTaskDelta } from './events.js';

const FIX_FAILURE_PREFIX_RE = /^\[Fix with (?:Claude|Agent) failed\] [^\n]*\n\n/;

function stripFixFailureWrapper(errorText: string): string {
  return errorText.replace(FIX_FAILURE_PREFIX_RE, '');
}

// ── Host Interface ──────────────────────────────────────────

/**
 * Subset of Orchestrator that the merge functions need.
 * Keeps the extracted functions decoupled from the full Orchestrator class.
 */
export interface MergeHost {
  readonly stateMachine: TaskStateMachine;
  readonly persistence: OrchestratorPersistence;
  readonly messageBus: { publish<T>(channel: string, message: T): void };
  readonly logger: Logger;
  readonly taskRepository: TaskRepository;
  readonly knownFreshBaseCommits: Map<string, string>;

  refreshFromDb(): void;
  stateGetTask(taskId: string): TaskState | undefined;
  taskMatchesLineageExpectation(task: TaskState, expected?: TaskLineageExpectation): boolean;
  withBumpedExecutionGeneration(task: TaskState, changes: TaskStateChanges): TaskStateChanges;
  writeAndSync(
    taskId: string,
    changes: TaskStateChanges,
    opts?: { skipWorkflowStatusSync?: boolean },
  ): TaskState;
  replaceSelectedAttempt(
    task: TaskState,
    opts?: Partial<Omit<Attempt, 'id' | 'nodeId' | 'createdAt'>>,
    writeOpts?: { skipWorkflowStatusSync?: boolean },
  ): string;
  updateSelectedAttempt(
    taskId: string,
    changes: Partial<
      Pick<
        Attempt,
        | 'status'
        | 'claimedAt'
        | 'startedAt'
        | 'completedAt'
        | 'exitCode'
        | 'error'
        | 'lastHeartbeatAt'
        | 'leaseExpiresAt'
        | 'branch'
        | 'commit'
        | 'summary'
        | 'workspacePath'
        | 'agentSessionId'
        | 'containerId'
        | 'mergeConflict'
      >
    >,
  ): void;
  buildUpdateDelta(before: TaskState, after: TaskState, changes: TaskStateChanges): TaskDelta;
  recreateWorkflow(workflowId: string): TaskState[];
}

// ── Extracted Functions ─────────────────────────────────────

export async function recreateWorkflowFromFreshBaseImpl(
  host: MergeHost,
  workflowId: string,
  options?: {
    refreshBase?: (
      workflowId: string,
    ) => Promise<{ commit?: string; branch?: string } | undefined | void>;
  },
): Promise<TaskState[]> {
  if (options?.refreshBase) {
    const fresh = await options.refreshBase(workflowId);
    if (fresh && typeof fresh === 'object') {
      if (typeof fresh.commit === 'string' && fresh.commit.length > 0) {
        host.knownFreshBaseCommits.set(workflowId, fresh.commit);
        host.logger.info('[orchestrator] recreateWorkflowFromFreshBase fresh base commit', {
          workflowId,
          freshBaseCommit: fresh.commit.slice(0, 12),
        });
      }
      if (typeof fresh.branch === 'string' && fresh.branch.length > 0 && host.persistence.updateWorkflow) {
        host.persistence.updateWorkflow(workflowId, { baseBranch: fresh.branch });
        host.logger.info('[orchestrator] recreateWorkflowFromFreshBase fresh base branch', {
          workflowId,
          freshBaseBranch: fresh.branch,
        });
      }
    }
  }
  return host.recreateWorkflow(workflowId);
}

export function getKnownFreshBaseCommitImpl(host: MergeHost, workflowId: string): string | undefined {
  return host.knownFreshBaseCommits.get(workflowId);
}

export function beginConflictResolutionImpl(
  host: MergeHost,
  taskId: string,
  expectedLineage?: TaskLineageExpectation,
): { savedError: string } {
  host.refreshFromDb();
  const task = host.stateGetTask(taskId);
  if (!task) throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);
  if (!host.taskMatchesLineageExpectation(task, expectedLineage)) {
    throw new Error(`Task ${taskId} lineage is stale for conflict resolution start`);
  }
  if (task.status !== 'failed') throw new Error(`Task ${taskId} is not failed (status: ${task.status})`);

  const savedError = task.execution.error ?? '';
  const startedAt = new Date();

  const id = task.id;
  const changes: TaskStateChanges = {
    status: 'fixing_with_ai',
    execution: {
      error: undefined,
      exitCode: undefined,
      completedAt: undefined,
      mergeConflict: undefined,
      isFixingWithAI: false,
      startedAt,
      lastHeartbeatAt: startedAt,
    },
  };
  const changesWithGeneration = host.withBumpedExecutionGeneration(task, changes);
  const conflictUpdated = host.writeAndSync(taskId, changesWithGeneration);
  const attemptId = host.replaceSelectedAttempt(task);
  host.taskRepository.updateAttempt(attemptId, {
    status: 'running',
    startedAt,
    lastHeartbeatAt: startedAt,
    branch: task.execution.branch,
    commit: task.execution.commit,
    workspacePath: task.execution.workspacePath,
    agentSessionId: task.execution.agentSessionId,
    containerId: task.execution.containerId,
    mergeConflict: undefined,
    error: undefined,
    exitCode: undefined,
  });
  const delta: TaskDelta = host.buildUpdateDelta(task, conflictUpdated, changesWithGeneration);
  host.persistence.logEvent?.(id, 'task.fixing_with_ai', changesWithGeneration);
  publishTaskDelta(host.messageBus, delta);

  return { savedError };
}

export function beginAutoFixSessionImpl(
  host: MergeHost,
  taskId: string,
  opts: { savedError?: string; expectedLineage?: TaskLineageExpectation } = {},
): { savedError: string } {
  host.refreshFromDb();
  const task = host.stateGetTask(taskId);
  if (!task) throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);
  if (!host.taskMatchesLineageExpectation(task, opts.expectedLineage)) {
    throw new Error(`Task ${taskId} lineage is stale for auto-fix start`);
  }
  if (
    task.status !== 'failed' &&
    task.status !== 'review_ready' &&
    task.status !== 'awaiting_approval'
  ) {
    throw new Error(`Task ${taskId} is not in an auto-fixable state (status: ${task.status})`);
  }

  const savedError = opts.savedError ?? task.execution.error ?? '';
  const startedAt = new Date();
  const id = task.id;
  const changes: TaskStateChanges = {
    status: 'fixing_with_ai',
    execution: {
      error: undefined,
      exitCode: undefined,
      completedAt: undefined,
      mergeConflict: undefined,
      isFixingWithAI: false,
      startedAt,
      lastHeartbeatAt: startedAt,
    },
  };
  const changesWithGeneration = host.withBumpedExecutionGeneration(task, changes);
  const updated = host.writeAndSync(id, changesWithGeneration);
  const attemptId = host.replaceSelectedAttempt(task);
  host.taskRepository.updateAttempt(attemptId, {
    status: 'running',
    startedAt,
    lastHeartbeatAt: startedAt,
    branch: task.execution.branch,
    commit: task.execution.commit,
    workspacePath: task.execution.workspacePath,
    agentSessionId: task.execution.agentSessionId,
    containerId: task.execution.containerId,
    mergeConflict: undefined,
    error: undefined,
    exitCode: undefined,
  });
  const delta: TaskDelta = host.buildUpdateDelta(task, updated, changesWithGeneration);
  host.persistence.logEvent?.(id, 'task.fixing_with_ai', changesWithGeneration);
  publishTaskDelta(host.messageBus, delta);
  return { savedError };
}

export function revertConflictResolutionImpl(
  host: MergeHost,
  taskId: string,
  savedError: string,
  fixError?: string,
  expectedLineage?: TaskLineageExpectation,
): void {
  host.refreshFromDb();
  const task = host.stateGetTask(taskId);
  if (!task) {
    throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);
  }
  if (!host.taskMatchesLineageExpectation(task, expectedLineage)) return;
  const id = task.id;

  const normalizedSavedError = stripFixFailureWrapper(savedError);
  const mergeConflict = parseMergeConflictError(normalizedSavedError);

  const displayError = fixError
    ? `[Fix with Agent failed] ${fixError}\n\n${normalizedSavedError}`
    : savedError;
  const completedAt = new Date();
  const changes: TaskStateChanges = {
    status: 'failed',
    execution: {
      error: displayError,
      mergeConflict,
      isFixingWithAI: false,
      completedAt,
    },
  };
  const revertUpdated = host.writeAndSync(taskId, changes);
  host.updateSelectedAttempt(taskId, {
    status: 'failed',
    error: displayError,
    mergeConflict,
    completedAt,
  });
  const delta: TaskDelta = host.buildUpdateDelta(task, revertUpdated, changes);
  host.persistence.logEvent?.(id, 'task.failed', changes);
  publishTaskDelta(host.messageBus, delta);
}

/**
 * Find the terminal merge node for a given workflow.
 */
export function getMergeNodeImpl(host: MergeHost, workflowId: string): TaskState | undefined {
  return host.stateMachine.getAllTasks().find(
    (t) => t.config.workflowId === workflowId && t.config.isMergeNode,
  );
}
