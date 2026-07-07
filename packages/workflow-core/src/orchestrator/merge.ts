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

import type { TaskState, TaskDelta, TaskStateChanges, TaskStatus, Attempt } from '@invoker/workflow-graph';
import { ATTEMPT_LEASE_MS } from '@invoker/contracts';
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

/**
 * Resting states a fix session may begin from — and therefore the only
 * states `revertFixSessionImpl` will ever restore. Explicit allow-list:
 *
 * - `failed`             — the classic fix-a-broken-task flow.
 * - `review_ready`       — a merge gate with an open review whose PR checks
 *                          went red; the gate task itself never failed.
 * - `awaiting_approval`  — a manual gate waiting on a human.
 *
 * Everything else is deliberately out: `pending`/`running`/`needs_input`/
 * `blocked` belong to the launch and input lifecycles (restoring `running`
 * would claim a live process that does not exist), and `completed`/`closed`/
 * `stale` are terminal — a revert that resurrects finished work is a
 * different, dangerous operation.
 */
export const FIX_SESSION_ENTRY_STATUSES = ['failed', 'review_ready', 'awaiting_approval'] as const;
export type FixSessionEntryStatus = (typeof FIX_SESSION_ENTRY_STATUSES)[number];

function isFixSessionEntryStatus(status: TaskStatus): status is FixSessionEntryStatus {
  return (FIX_SESSION_ENTRY_STATUSES as readonly TaskStatus[]).includes(status);
}

/**
 * Begin a fix session: record the entry status on the task (persisted, so a
 * later revert — possibly after a restart, from an approve/reject surface —
 * knows exactly where to return), then move the task to `fixing_with_ai`.
 *
 * At most one session may be open per task: beginning while a pending fix is
 * parked (`pendingFixError` set) is refused; the human must approve or reject
 * the parked fix first.
 */
export function beginFixSessionImpl(
  host: MergeHost,
  taskId: string,
  opts: { savedError?: string; expectedLineage?: TaskLineageExpectation } = {},
): { savedError: string } {
  host.refreshFromDb();
  const task = host.stateGetTask(taskId);
  if (!task) throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);
  if (!host.taskMatchesLineageExpectation(task, opts.expectedLineage)) {
    throw new Error(`Task ${taskId} lineage is stale for fix session start`);
  }
  if (task.execution.pendingFixError !== undefined) {
    throw new Error(
      `Task ${taskId} already has a pending fix awaiting approval or rejection; approve or reject it before starting another fix`,
    );
  }
  if (!isFixSessionEntryStatus(task.status)) {
    throw new Error(
      `Task ${taskId} is not in a fix-session entry state (status: ${task.status}; allowed: ${FIX_SESSION_ENTRY_STATUSES.join(', ')})`,
    );
  }
  return startFixSession(host, task, task.status, opts.savedError);
}

function startFixSession(
  host: MergeHost,
  task: TaskState,
  entryStatus: FixSessionEntryStatus,
  savedErrorOverride: string | undefined,
): { savedError: string } {
  const savedError = savedErrorOverride ?? task.execution.error ?? '';
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
      fixSessionEntryStatus: entryStatus,
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
    leaseExpiresAt: new Date(startedAt.getTime() + ATTEMPT_LEASE_MS),
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

/**
 * Revert a fix session to the entry status recorded by `beginFixSessionImpl`.
 *
 * Valid at two points of the session: while the fix runs (`fixing_with_ai`)
 * and after it parked awaiting a human (`awaiting_approval` +
 * `pendingFixError`, the reject path). Restore means "status equals entry
 * status" — monotonic fields stay monotonic: the execution generation stays
 * bumped (it guards against orphaned async work) and the replaced attempt
 * stays replaced, marked failed.
 *
 * Legacy rows (a session begun before the entry status was recorded) restore
 * `failed`, which is exact: every pre-existing session came through the
 * failed-only guard. A revert with no session and no legacy evidence is an
 * idempotent no-op — reverts run inside catch blocks and retried mutation
 * intents, where throwing would mask the original error.
 */
export function revertFixSessionImpl(
  host: MergeHost,
  taskId: string,
  opts: {
    savedError: string;
    fixError?: string;
    expectedLineage?: TaskLineageExpectation;
  },
): void {
  host.refreshFromDb();
  const task = host.stateGetTask(taskId);
  if (!task) {
    throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);
  }
  if (!host.taskMatchesLineageExpectation(task, opts.expectedLineage)) return;

  const recorded = task.execution.fixSessionEntryStatus;
  const entryStatus: FixSessionEntryStatus | undefined =
    recorded !== undefined && isFixSessionEntryStatus(recorded)
      ? recorded
      : task.status === 'fixing_with_ai' ||
          task.status === 'failed' ||
          task.execution.pendingFixError !== undefined
        ? 'failed' // legacy session or failed-task error rewrite: pre-column behavior
        : undefined;
  if (entryStatus === undefined) {
    host.persistence.logEvent?.(task.id, 'task.fix_session_revert_noop', {
      status: task.status,
      fixError: opts.fixError ?? null,
    });
    return;
  }

  if (entryStatus === 'failed') {
    restoreFailedEntry(host, task, opts.savedError, opts.fixError);
    return;
  }

  const completedAt = new Date();
  const attemptError = opts.fixError
    ? `[Fix with Agent failed] ${opts.fixError}`
    : opts.savedError;
  const changes: TaskStateChanges = {
    status: entryStatus,
    execution: {
      error: undefined,
      isFixingWithAI: false,
      pendingFixError: undefined,
      fixSessionEntryStatus: undefined,
      completedAt,
    },
  };
  const updated = host.writeAndSync(taskId, changes);
  host.updateSelectedAttempt(taskId, {
    status: 'failed',
    error: attemptError,
    completedAt,
  });
  const delta: TaskDelta = host.buildUpdateDelta(task, updated, changes);
  host.persistence.logEvent?.(task.id, 'task.fix_session_reverted', {
    restoreStatus: entryStatus,
    fixError: opts.fixError ?? null,
  });
  publishTaskDelta(host.messageBus, delta);
}

/**
 * Reclaim a fix session (`status: 'fixing_with_ai'`) whose owner process died
 * mid-fix: its attempt lease has expired and no live executor is driving it.
 *
 * Reverts the session to its recorded entry status (via `revertFixSessionImpl`,
 * so a `failed` task returns to `failed` and a `review_ready` merge gate returns
 * to review polling). `expectedLineage` guards against reclaiming a newer,
 * live session a concurrent restart re-dispatched between observation and
 * revert.
 *
 * Returns `'reverted'` when it reclaimed the session, or `'noop'` when the task
 * is no longer a stalled fix session or the lineage no longer matches.
 */
export function reclaimStalledFixSessionImpl(
  host: MergeHost,
  taskId: string,
  opts: { reason: string; expectedLineage?: TaskLineageExpectation },
): 'reverted' | 'noop' {
  host.refreshFromDb();
  const task = host.stateGetTask(taskId);
  if (!task || task.status !== 'fixing_with_ai') return 'noop';
  if (!host.taskMatchesLineageExpectation(task, opts.expectedLineage)) return 'noop';

  revertFixSessionImpl(host, taskId, {
    savedError: task.execution.error ?? task.execution.pendingFixError ?? '',
    fixError: opts.reason,
    expectedLineage: opts.expectedLineage,
  });

  const reverted = host.stateGetTask(taskId);
  if (!reverted || reverted.status === 'fixing_with_ai') return 'noop';

  host.persistence.logEvent?.(taskId, 'task.fix_session_reclaimed', {
    reason: opts.reason,
    restoreStatus: reverted.status,
  });
  return 'reverted';
}

function restoreFailedEntry(
  host: MergeHost,
  task: TaskState,
  savedError: string,
  fixError?: string,
): void {
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
      pendingFixError: undefined,
      fixSessionEntryStatus: undefined,
      completedAt,
    },
  };
  const revertUpdated = host.writeAndSync(id, changes);
  host.updateSelectedAttempt(id, {
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
