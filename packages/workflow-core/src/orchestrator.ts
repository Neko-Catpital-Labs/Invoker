/**
 * Orchestrator — Single coordinator for all task state mutations.
 *
 * ALL writes go through the persistence layer (DB) first. The in-memory
 * graph (via TaskStateMachine) is a read-only cache that is refreshed
 * from the DB. This ensures the DB is always the single source of truth.
 *
 * Pattern for every mutation:
 *   1. refreshFromDb()  — ensure in-memory state is current
 *   2. validate / compute using read-only queries
 *   3. writeAndSync()   — persist changes to DB, update graph cache
 *   4. publish delta    — notify UI
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { TaskStateMachine } from './state-machine.js';
import { ResponseHandler } from './response-handler.js';
import type { ParsedResponse } from './response-handler.js';
import { TaskScheduler } from './scheduler.js';
import type { TaskState, TaskDelta, TaskStateChanges, TaskConfig, TaskExecution, Attempt, ExternalDependency, ExternalDependencyChange, DetachedExternalDependency, TaskStatus, TaskHeartbeatSource } from '@invoker/workflow-graph';
import type { RunnerKind } from '@invoker/workflow-graph';
import { createTaskState, createAttempt, hasFailedDependencyPath, isCrashPreservedExecution, isLivenessFailureClass } from '@invoker/workflow-graph';
import type { WorkflowDerivedStatus } from '@invoker/workflow-graph';
import type { Logger, WorkResponse } from '@invoker/contracts';
import { ATTEMPT_LEASE_MS } from '@invoker/contracts';
import { normalizeRunnerKind } from '@invoker/workflow-graph';
import {
  buildExecutorRoutedPayload,
  buildHeavyweightRoutingRules,
  resolveExecutorRouting,
  type ExecutorRoutingReason,
  type ExecutorRoutingRule,
  type HeavyweightCommandRoutingPolicy,
} from './executor-routing.js';
import { requireDefaultBranchRemote } from './repo-default-branch.js';
import { unapprovedRequiredReviewArtifacts } from './review-gate-artifacts.js';

const MERGE_TRACE_LOG = resolve(homedir(), '.invoker', 'merge-trace.log');
function mergeTrace(tag: string, data: Record<string, unknown>): void {
  try {
    mkdirSync(resolve(homedir(), '.invoker'), { recursive: true });
    appendFileSync(MERGE_TRACE_LOG, `${new Date().toISOString()} [merge-trace:orchestrator] ${tag} ${JSON.stringify(data)}\n`);
  } catch { /* best effort */ }
}

// ── Typed domain error codes ────────────────────────────────────
export const OrchestratorErrorCode = {
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  TASK_ALREADY_TERMINAL: 'TASK_ALREADY_TERMINAL',
  WORKFLOW_NOT_FOUND: 'WORKFLOW_NOT_FOUND',
  REVIEW_GATE_NOT_APPROVED: 'REVIEW_GATE_NOT_APPROVED',
} as const;

export type OrchestratorErrorCode = (typeof OrchestratorErrorCode)[keyof typeof OrchestratorErrorCode];

export class OrchestratorError extends Error {
  readonly code: OrchestratorErrorCode;
  constructor(code: OrchestratorErrorCode, message: string) {
    super(message);
    this.name = 'OrchestratorError';
    this.code = code;
  }
}

function isActiveForInvalidation(status: TaskStatus): boolean {
  return (
    status === 'running' ||
    status === 'fixing_with_ai' ||
    status === 'awaiting_approval' ||
    status === 'review_ready'
  );
}

import { getTransitiveDependents } from '@invoker/workflow-graph';
import { ActionGraph } from '@invoker/workflow-graph';
import {
  reconcileMergeLeavesImpl,
  applyGraphMutationImpl,
  assertMergeLeavesInvariantImpl,
  assertMergeExperimentDependenciesInvariantImpl,
} from './graph-mutation.js';
import type { GraphMutationHost } from './graph-mutation.js';
import {
  autoStartReadyTasksImpl,
  enqueueIfNotScheduledImpl,
  autoStartExternallyUnblockedReadyTasksImpl,
  autoStartUnblockedTasksImpl,
  getPendingLaunchQueueSnapshotImpl,
  getTaskLaunchReadinessImpl,
  areLocalDependenciesSatisfiedImpl,
  getLocalDependencyBlockerImpl,
  drainSchedulerImpl,
} from './orchestrator/scheduler-domain.js';
import type { SchedulerDomainHost } from './orchestrator/scheduler-domain.js';
import {
  handleCompletedImpl,
  finalizeFailedTaskImpl,
  handleReviewReadyImpl,
  handleFailedImpl,
  handleNeedsInputImpl,
  handleSpawnExperimentsImpl,
  handleSelectExperimentImpl,
  checkExperimentCompletionImpl,
  checkWorkflowCompletionImpl,
} from './orchestrator/transitions.js';
import type { TransitionHost } from './orchestrator/transitions.js';
import {
  cancelActiveBeforeInvalidationImpl,
  cancelActiveCandidatesImpl,
  cancelTaskImpl,
  cancelWorkflowImpl,
  deferTaskImpl,
} from './orchestrator/cancellation.js';
import type { CancellationHost } from './orchestrator/cancellation.js';
import {
  EXPEDITED_PRIORITY as LIFECYCLE_EXPEDITED_PRIORITY,
  applyRecreateResetImpl,
  bumpWorkflowGenerationImpl,
  collectSubgraphTaskIdsImpl,
  dispatchPostMutationImpl,
  invalidateLaunchArtifactsForTasksImpl,
  recreateDownstreamImpl,
  recreateTaskImpl,
  recreateWorkflowImpl,
  resetSubgraphToPendingImpl,
  restartTaskImpl,
  retryTaskImpl,
  retryWorkflowImpl,
} from './orchestrator/lifecycle.js';
import type { LifecycleHost } from './orchestrator/lifecycle.js';
import {
  editTaskCommandImpl,
  editTaskPromptImpl,
  editTaskTypeImpl,
  editTaskPoolImpl,
  editTaskAgentImpl,
  editTaskMergeModeImpl,
  editTaskFixContextImpl,
} from './orchestrator/task-edits.js';
import type { TaskEditHost } from './orchestrator/task-edits.js';
import {
  buildTaskUpdateDelta,
  buildTaskRemoveDelta,
} from './orchestrator/events.js';
import {
  recreateWorkflowFromFreshBaseImpl,
  getKnownFreshBaseCommitImpl,
  beginFixSessionImpl,
  revertFixSessionImpl,
  reclaimStalledFixSessionImpl,
  getMergeNodeImpl,
} from './orchestrator/merge.js';
import type { MergeHost } from './orchestrator/merge.js';
import { buildPlanLocalToScopedIdMap, scopePlanTaskId } from './task-id-scope.js';
import type { TaskRepository } from './task-repository.js';
import {
  planInvalidation,
  type InvalidationPlan,
} from './invalidation-plan.js';
import {
  MUTATION_POLICIES,
  type InvalidationAction,
} from './invalidation-policy.js';
import {
  isActiveAttempt,
  isDiscardedAttempt,
  isOutcomeTerminalAttempt,
} from './attempt-policy.js';
import { assertResetComplete, buildTaskResetChanges, type TaskResetKind } from './task-reset-policy.js';

// ── Channel Constants ───────────────────────────────────────

const TASK_DELTA_CHANNEL = 'task.delta';
let workflowCounter = 0;

function isReplaceableAttemptStatus(status: Attempt['status']): boolean {
  return status === 'pending'
    || status === 'claimed'
    || status === 'running'
    || status === 'needs_input';
}

function nextWorkflowId(): string {
  workflowCounter += 1;
  if (process.env.INVOKER_TEST_WORKFLOW_IDS === '1') return `wf-test-${workflowCounter}`;
  return `wf-${Date.now()}-${workflowCounter}`;
}

function workflowTimestamp(): Date {
  if (process.env.NODE_ENV === 'test' && process.env.INVOKER_TEST_FIXED_NOW) {
    return new Date(process.env.INVOKER_TEST_FIXED_NOW);
  }
  return new Date();
}

const TRACE_PERSIST_SYNC = process.env.INVOKER_TRACE_PERSIST_SYNC === '1';
const TRACE_WORKER_RESPONSE = process.env.INVOKER_TRACE_WORKER_RESPONSE === '1';
const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() { return noopLogger; },
};

function nextLeaseExpiry(from: Date): Date {
  return new Date(from.getTime() + ATTEMPT_LEASE_MS);
}

// ── Errors ──────────────────────────────────────────────────

export class PlanConflictError extends Error {
  constructor(
    message: string,
    public readonly conflictingTaskIds: string[],
    public readonly conflictingWorkflows: Array<{ id: string; name: string }>,
  ) {
    super(message);
    this.name = 'PlanConflictError';
  }
}

// ── Adapter Interfaces ──────────────────────────────────────

export interface LaunchDispatchInvalidationRow {
  id: number;
  taskId: string;
  attemptId: string;
  workflowId: string;
  state: string;
  generation: number;
}

export interface ExecutionResourceLeaseReleaseRow {
  resourceKey: string;
  resourceType: string;
  holderId: string;
  taskId?: string;
}

export type TaskLaunchReadiness =
  | { ready: true; task: TaskState }
  | { ready: false; reason: string; task?: TaskState };
export type LaunchReadinessOptions = { bypassLocalDependencyReadiness?: boolean };

export interface OrchestratorPersistence {
  saveWorkflow(workflow: {
    id: string;
    name: string;
    description?: string;
    visualProof?: boolean;
    createdAt: string;
    updatedAt: string;
    repoUrl?: string;
    intermediateRepoUrl?: string;
    onFinish?: string;
    baseBranch?: string;
    featureBranch?: string;
    mergeMode?: 'manual' | 'automatic' | 'external_review';
    externalDependencies?: ExternalDependency[];
    externalDependencyChanges?: ExternalDependencyChange[];
    detachedExternalDependencies?: DetachedExternalDependency[];
  }): void;
  updateWorkflow?(workflowId: string, changes: { updatedAt?: string; baseBranch?: string; generation?: number; mergeMode?: 'manual' | 'automatic' | 'external_review'; externalDependencies?: ExternalDependency[]; externalDependencyChanges?: ExternalDependencyChange[]; detachedExternalDependencies?: DetachedExternalDependency[] }): void;
  saveTask(workflowId: string, task: TaskState): void;
  updateTask(taskId: string, changes: TaskStateChanges): void;
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
  listWorkflows(): Array<{
    id: string;
    name: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    repoUrl?: string;
    baseBranch?: string;
    onFinish?: string;
    mergeMode?: 'manual' | 'automatic' | 'external_review';
    externalDependencies?: ExternalDependency[];
    externalDependencyChanges?: ExternalDependencyChange[];
    detachedExternalDependencies?: DetachedExternalDependency[];
    generation?: number;
  }>;
  loadTasks(workflowId: string): TaskState[];
  loadWorkflowTaskSnapshot?(): {
    workflows: Array<{
      id: string;
      name: string;
      status: string;
      createdAt: string;
      updatedAt: string;
      repoUrl?: string;
      baseBranch?: string;
      onFinish?: string;
      mergeMode?: 'manual' | 'automatic' | 'external_review';
      externalDependencies?: ExternalDependency[];
      externalDependencyChanges?: ExternalDependencyChange[];
      detachedExternalDependencies?: DetachedExternalDependency[];
      generation?: number;
    }>;
    tasks: TaskState[];
    tasksByWorkflowId: Map<string, TaskState[]>;
  };
  // Attempt methods
  saveAttempt(attempt: Attempt): void;
  loadAttempts(nodeId: string): Attempt[];
  loadAttempt(attemptId: string): Attempt | undefined;
  updateAttempt(attemptId: string, changes: Partial<Pick<Attempt, 'status' | 'claimedAt' | 'startedAt' | 'completedAt' | 'exitCode' | 'error' | 'lastHeartbeatAt' | 'leaseExpiresAt' | 'branch' | 'commit' | 'summary' | 'workspacePath' | 'agentSessionId' | 'containerId' | 'mergeConflict'>>): void;
  deleteTask?(taskId: string): void;
  failTaskAndAttempt?(
    taskId: string,
    taskChanges: TaskStateChanges,
    attemptPatch: Partial<Pick<Attempt, 'status' | 'exitCode' | 'error' | 'completedAt'>>
  ): void;
  /**
   * Load a workflow by ID. Used by:
   *   - SSH validation in `editTaskType` (`repoUrl`),
   *   - same-mode no-op detection in `editTaskMergeMode` (`mergeMode`).
   * The interface lists only the fields the orchestrator actually reads;
   * concrete adapters (e.g. `SQLiteAdapter.loadWorkflow`) return more.
   */
  loadWorkflow?(workflowId: string): {
    repoUrl?: string;
    intermediateRepoUrl?: string;
    baseBranch?: string;
    featureBranch?: string;
    mergeMode?: 'manual' | 'automatic' | 'external_review';
    externalDependencies?: ExternalDependency[];
    externalDependencyChanges?: ExternalDependencyChange[];
    detachedExternalDependencies?: DetachedExternalDependency[];
    generation?: number;
  } | undefined;
  /** Delete a single workflow and its tasks from the DB. */
  deleteWorkflow?(workflowId: string): void;
  /** Delete all workflows and tasks from the DB. */
  deleteAllWorkflows?(): void;
  /**
   * Optional launch-handoff outbox sink. When provided, `drainScheduler`
   * writes a durable `task_launch_dispatch` row for each claimed launch.
   */
  enqueueLaunchDispatch?(input: {
    taskId: string;
    attemptId: string;
    workflowId: string;
    priority?: 'high' | 'normal' | 'low';
    generation: number;
  }): {
    id: number;
    state?: 'enqueued' | 'leased' | 'completed' | 'abandoned';
    priority?: 'high' | 'normal' | 'low';
  };
  abandonLaunchDispatchesForTasks?(
    taskIds: readonly string[],
    reason: string,
    nowIso?: string,
  ): LaunchDispatchInvalidationRow[];
  releaseExecutionResourceLeasesForTasks?(
    taskIds: readonly string[],
    reason: string,
    nowIso?: string,
  ): ExecutionResourceLeaseReleaseRow[];
}

export interface OrchestratorMessageBus {
  publish<T>(channel: string, message: T): void;
}

// ── Public Types ────────────────────────────────────────────

/** Options for {@link Orchestrator.deleteAllWorkflows}. */
export interface DeleteAllWorkflowsOptions {
  /**
   * When `true` (the default), a `removed` TaskDelta is published for every
   * task before the method returns.  Set to `false` to skip per-task delta
   * publication — useful for bulk callers that notify the UI through a
   * separate channel.
   */
  publishRemovalDeltas?: boolean;
}

export interface PlanDefinition {
  name: string;
  description?: string;
  visualProof?: boolean;
  onFinish?: 'none' | 'merge' | 'pull_request';
  baseBranch?: string;
  featureBranch?: string;
  mergeMode?: 'manual' | 'automatic' | 'external_review';
  reviewProvider?: string;
  repoUrl?: string;
  intermediateRepoUrl?: string;
  externalDependencies?: Array<{
    workflowId: string;
    taskId?: string;
    requiredStatus?: 'completed';
    gatePolicy?: 'completed' | 'review_ready';
  }>;
  tasks: Array<{
    id: string;
    description: string;
    command?: string;
    prompt?: string;
    dependencies?: string[];
    /** @deprecated Cross-workflow dependencies are workflow-owned; parser rejects this for new YAML. */
    externalDependencies?: Array<{
      workflowId: string;
      taskId?: string;
      requiredStatus?: 'completed';
      gatePolicy?: 'completed' | 'review_ready';
    }>;
    pivot?: boolean;
    experimentVariants?: Array<{ id: string; description: string; prompt?: string; command?: string }>;
    requiresManualApproval?: boolean;
    featureBranch?: string;
    dockerImage?: string;
    poolId?: string;
    executionAgent?: string;
    executionModel?: string;
  }>;
}

/** User-visible merge-node description aligned with `onFinish` / `mergeMode` (list + graph subtitle). */
export function descriptionForMergeNode(plan: Pick<PlanDefinition, 'name' | 'onFinish' | 'mergeMode'>): string {
  const onFinish = plan.onFinish ?? 'none';
  const mergeMode = plan.mergeMode ?? 'manual';
  if (mergeMode === 'external_review') {
    return `Review gate for ${plan.name}`;
  }
  if (onFinish === 'pull_request') {
    return `Pull request gate for ${plan.name}`;
  }
  if (onFinish === 'merge') {
    return `Merge gate for ${plan.name}`;
  }
  return `Workflow gate for ${plan.name}`;
}

/**
 * Statuses that count a workflow as "live" for topology-mutation policy.
 *
 * Per `docs/architecture/task-invalidation-chart.md` ("Topology
 * inconsistency"), topology-changing requests must NOT mutate a live
 * workflow in place — they must instead fork a new workflow rooted from
 * the relevant node/result. A workflow is live if any non-merge task in
 * it is in any of these statuses.
 *
 * The merge node is intentionally excluded: it is `pending` for the
 * entire workflow lifetime, so including it would make every workflow
 * "live" forever and defeat the policy.
 */
const LIVE_TASK_STATUSES = new Set<string>([
  'pending',
  'running',
  'fixing_with_ai',
  'needs_input',
  'awaiting_approval',
  'review_ready',
  'blocked',
]);

/**
 * Thrown when a topology-changing graph mutation is requested against
 * a workflow that still has any live (non-terminal) task.
 *
 * Step 11 (`docs/architecture/task-invalidation-roadmap.md`) introduces
 * this surface; Step 12 builds the `forkWorkflow*` API the message
 * points callers at. Until then, callers handling this error must
 * either wait for the workflow to terminate or mark the affected
 * subgraph as terminal (e.g. via `cancelWorkflow`) before retrying.
 *
 * The message embeds both the workflow id and the offending task id so
 * the caller (and tests) can route the request to the correct fork
 * source without re-querying the orchestrator.
 */
export class TopologyForkRequired extends Error {
  readonly workflowId: string;
  readonly taskId: string;
  constructor(workflowId: string, taskId: string, detail?: string) {
    super(
      `TopologyForkRequired: cannot mutate graph topology in place on live ` +
        `workflow ${workflowId} (offending task ${taskId})` +
        (detail ? ` — ${detail}` : '') +
        `. Topology changes must fork a new workflow from the relevant ` +
        `node/result (see docs/architecture/task-invalidation-chart.md ` +
        `"Topology inconsistency"; forkWorkflow API lands in Step 12).`,
    );
    this.name = 'TopologyForkRequired';
    this.workflowId = workflowId;
    this.taskId = taskId;
  }
}

export interface ForkWorkflowResult {
  readonly forkedWorkflowId: string;
  readonly sourceWorkflowId: string;
  readonly started: TaskState[];
}

export interface GraphMutationNodeDef {
  id: string;
  description: string;
  dependencies: string[];
  workflowId?: string;
  parentTask?: string;
  experimentPrompt?: string;
  prompt?: string;
  command?: string;
  runnerKind?: RunnerKind;
  isReconciliation?: boolean;
  requiresManualApproval?: boolean;
  isMergeNode?: boolean;
}

export interface GraphMutation {
  sourceNodeId: string;
  sourceDisposition: 'complete' | 'stale';
  sourceChanges?: TaskStateChanges;
  newNodes: GraphMutationNodeDef[];
  outputNodeId: string;
}

export interface TaskReplacementDef {
  id: string;
  description: string;
  command?: string;
  prompt?: string;
  dependencies?: string[];
  runnerKind?: RunnerKind;
  executionAgent?: string;
  executionModel?: string;
}

export interface ExternalGatePolicyUpdate {
  workflowId: string;
  taskId?: string;
  gatePolicy: 'completed' | 'review_ready';
}

export {
  findMatchingExecutorRoutingRule,
  assertExecutorRoutingConforms,
  type ExecutorRoutingRule,
  type CommandRoutingMatcher,
  type HeavyweightCommandRoutingPolicy,
} from './executor-routing.js';

/**
 * Adapt an OrchestratorPersistence into the TaskRepository port.
 * Only the three write methods used by the orchestrator are bridged.
 */
export function taskRepositoryFromPersistence(p: OrchestratorPersistence): TaskRepository {
  const partial = p as Partial<OrchestratorPersistence>;
  return {
    runInTransaction: <T>(work: () => T) => {
      const maybeTransactional = partial as Partial<{ runInTransaction<T>(cb: () => T): T }>;
      if (typeof maybeTransactional.runInTransaction === 'function') {
        return maybeTransactional.runInTransaction(work);
      }
      return work();
    },
    saveWorkflow: (wf) => p.saveWorkflow(wf),
    updateWorkflow: (id, c) => p.updateWorkflow?.(id, c),
    deleteWorkflow: (id) => p.deleteWorkflow?.(id),
    deleteAllWorkflows: () => p.deleteAllWorkflows?.(),
    saveTask: (wfId, t) => p.saveTask(wfId, t),
    updateTask: (id, c) => p.updateTask(id, c),
    deleteTask: (id) => {
      if (!p.deleteTask) throw new Error('Persistence adapter does not support deleteTask');
      p.deleteTask(id);
    },
    logEvent: (id, et, pl) => p.logEvent?.(id, et, pl),
    saveAttempt: (a) => partial.saveAttempt?.(a),
    updateAttempt: (id, c) => partial.updateAttempt?.(id, c),
    failTaskAndAttempt: (tId, tc, ap) => {
      if (p.failTaskAndAttempt) {
        p.failTaskAndAttempt(tId, tc, ap);
      } else {
        p.updateTask(tId, tc);
        const attempts = partial.loadAttempts?.call(p, tId) ?? [];
        const latest = attempts[attempts.length - 1];
        if (latest) {
          partial.updateAttempt?.(latest.id, ap);
        }
      }
    },
  };
}

export interface OrchestratorConfig {
  persistence: OrchestratorPersistence;
  messageBus: OrchestratorMessageBus;
  logger?: Logger;
  /** Optional; defaults to an adapter wrapping `persistence`. */
  taskRepository?: TaskRepository;
  maxConcurrency?: number;
  /**
   * Rules that validate task execution environment against command patterns.
   * When loading a plan, the orchestrator validates that tasks with commands matching
   * a rule have the required runnerKind and poolId specified in the plan.
   */
  executorRoutingRules?: ExecutorRoutingRule[];
  /**
   * Deprecated compatibility alias for config-owned heavyweight command routing.
   * Internally translated into executorRoutingRules with strategy="route".
   */
  heavyweightCommandRouting?: HeavyweightCommandRoutingPolicy;
  /** Valid execution pool IDs available at plan submission time. */
  availablePoolIds?: string[];
  /** Default pool applied to tasks that do not declare a pool and do not match a route rule. */
  defaultPoolId?: string;
  /**
   * When true, keep tasks persisted as `pending` until the executor confirms
   * startup success, then transition to `running`.
   *
   * Default false preserves existing behavior (transition to `running` at
   * scheduler dequeue time).
   */
  deferRunningUntilLaunch?: boolean;
  /** Resolve the repo default branch. Must throw when no safe branch is known. */
  resolveRepoDefaultBranch?: (repoUrl: string) => string;
  /**
   * Backoff (ms) before a task deferred for a resource limit (no execution-pool
   * member capacity) is re-dispatched by the periodic scheduler. Default is an
   * exponential schedule (15s → 5min cap) so a capacity-starved task waits in
   * line and heartbeats instead of thrashing the launch outbox every poll.
   * A fixed number overrides the schedule (primarily for tests).
   */
  launchDeferralBackoffMs?: number;
  /**
   * When the persistence layer implements `enqueueLaunchDispatch`,
   * `drainScheduler` writes a durable `task_launch_dispatch` row for each
   * claimed launch and emits a `task.dispatch_enqueued` event.
   */
}

// ── Orchestrator ────────────────────────────────────────────

export interface TaskLineageExpectation {
  taskId?: string;
  selectedAttemptId?: string;
  generation?: number;
}

export class Orchestrator {
  private static readonly EXPEDITED_PRIORITY = LIFECYCLE_EXPEDITED_PRIORITY;
  private static readonly LAUNCH_DEFERRAL_BASE_BACKOFF_MS = 15_000;
  private static readonly LAUNCH_DEFERRAL_MAX_BACKOFF_MS = 5 * 60_000;
  private static readonly LAUNCH_DEFERRAL_HEARTBEAT_MS = 30_000;

  private readonly stateMachine: TaskStateMachine;
  private readonly responseHandler: ResponseHandler;
  private readonly scheduler: TaskScheduler;
  private readonly persistence: OrchestratorPersistence;
  private readonly messageBus: OrchestratorMessageBus;
  private readonly logger: Logger;
  private readonly taskRepository: TaskRepository;
  private readonly maxConcurrency: number;
  private readonly executorRoutingRules: ExecutorRoutingRule[];
  private readonly availablePoolIds: Set<string>;
  private readonly defaultPoolId: string | undefined;
  private readonly deferRunningUntilLaunch: boolean;
  private readonly launchDeferralBackoffMs?: number;
  private readonly resolveRepoDefaultBranch: (repoUrl: string) => string;

  private activeWorkflowIds = new Set<string>();
  private deferredTaskIds = new Set<string>();
  /** Coalesces UI polls (`refresh: false`) so IPC does not recompute every 2s. */
  private queueStatusUiCache:
    | { at: number; value: ReturnType<Orchestrator['getQueueStatus']> }
    | null = null;
  private static readonly QUEUE_STATUS_UI_CACHE_MS = 2500;
  /**
   * Owner-local backoff for tasks deferred due to execution-pool capacity.
   * Keyed to `deferredTaskIds` membership: the periodic scheduler skips
   * re-dispatching a parked task until its `until` elapses, while a freed slot
   * (completion path) still re-enqueues it immediately. Pruned when the task
   * leaves the deferred set (retry / cancel / recreate / completion / delete).
   */
  private launchDeferrals = new Map<string, { until: number; attempts: number; lastHeartbeatAt: number }>();
  private beforeApproveHook?: (task: TaskState) => Promise<void>;
  private lastInvalidationPlan?: InvalidationPlan;

  /**
   * Per-workflow record of the most recently observed upstream base
   * commit, written by `recreateWorkflowFromFreshBase` whenever its
   * `refreshBase` callback returns a fresh SHA.
   *
   * Step 12 introduces this map as the orchestrator-side observable
   * for the chart's `recreateWorkflowFromFreshBase` semantic
   * (`docs/architecture/task-invalidation-chart.md` rows
   * "Rebase and retry" + "Repo/base invalidation inconsistency"):
   * the only thing that distinguishes `recreateWorkflowFromFreshBase`
   * from plain `recreateWorkflow` at the orchestrator layer is that
   * the workflow's known upstream base advanced. The map gives tests
   * (and future API consumers) a stable signal that the fresh-base
   * step actually ran without coupling the orchestrator to the
   * executor's pool-mirror state. Production today still drives the
   * actual git-side refresh through `taskExecutor.preparePoolForRebaseRetry`
   * (wired by `packages/app/src/workflow-actions.ts → recreateWorkflowFromFreshBase`).
   */
  private knownFreshBaseCommits = new Map<string, string>();

  private static readonly DETACH_RESET_CHANGES: TaskStateChanges = buildTaskResetChanges('detach', {
    config: { summary: undefined },
  });

  constructor(config: OrchestratorConfig) {
    this.maxConcurrency = config.maxConcurrency ?? 3;
    this.persistence = config.persistence;
    this.messageBus = config.messageBus;
    this.logger = config.logger ?? noopLogger;
    this.taskRepository = config.taskRepository ?? taskRepositoryFromPersistence(config.persistence);
    this.executorRoutingRules = [
      ...(config.executorRoutingRules ?? []),
      ...buildHeavyweightRoutingRules('config', config.heavyweightCommandRouting),
    ];
    this.availablePoolIds = new Set(config.availablePoolIds ?? []);
    this.defaultPoolId = config.defaultPoolId;
    this.deferRunningUntilLaunch = config.deferRunningUntilLaunch ?? false;
    this.launchDeferralBackoffMs = config.launchDeferralBackoffMs;
    this.resolveRepoDefaultBranch = config.resolveRepoDefaultBranch ?? requireDefaultBranchRemote;

    this.stateMachine = new TaskStateMachine(new ActionGraph());
    this.responseHandler = new ResponseHandler();
    this.scheduler = new TaskScheduler(this.maxConcurrency);
  }

  // ── DB Sync Helpers ────────────────────────────────────────

  /**
   * Refresh the in-memory graph from the database.
   * Called at the start of every public mutation to ensure
   * we see any external changes before proceeding.
   */
  private refreshFromDb(): void {
    if (this.activeWorkflowIds.size === 0) return;
    this.stateMachine.clear();
    for (const wfId of this.activeWorkflowIds) {
      const tasks = this.persistence.loadTasks(wfId);
      for (const task of tasks) {
        this.stateMachine.restoreTask(task);
      }
    }
  }

  private refreshWorkflowFromDb(workflowId: string): void {
    this.activeWorkflowIds.add(workflowId);
    const tasks = this.persistence.loadTasks(workflowId);
    for (const task of tasks) {
      this.stateMachine.restoreTask(task);
    }
  }

  /**
   * Write field changes to the DB, then update the in-memory cache
   * to match. Returns the updated task state.
   */
  private writeAndSync(
    taskId: string,
    changes: TaskStateChanges,
    opts?: { skipWorkflowStatusSync?: boolean },
  ): TaskState {
    const existing = this.stateGetTask(taskId);
    if (!existing) {
      throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `writeAndSync: task ${taskId} not found in graph`);
    }
    const id = existing.id;
    this.taskRepository.updateTask(id, changes);
    this.queueStatusUiCache = null;
    const updated: TaskState = {
      ...existing,
      ...(changes.status !== undefined ? { status: changes.status } : {}),
      ...(changes.dependencies !== undefined ? { dependencies: changes.dependencies } : {}),
      // Type assertion: spread widens the discriminated union but the runtime
      // value preserves the correct runnerKind discriminant from existing.config.
      config: { ...existing.config, ...changes.config } as TaskConfig,
      execution: { ...existing.execution, ...changes.execution },
      taskStateVersion: existing.taskStateVersion + 1,
    };
    if (process.env.NODE_ENV !== 'test' && TRACE_PERSIST_SYNC) {
      const ex = updated.execution;
      const execKeys = changes.execution ? Object.keys(changes.execution).join(',') : '';
      this.logger.info('[persist-sync]', {
        taskId: id,
        resolvedStatus: updated.status,
        isFixingWithAI: ex.isFixingWithAI === true,
        exitCode: ex.exitCode ?? null,
        errorLen: ex.error?.length ?? 0,
        pendingFix: ex.pendingFixError !== undefined,
        inputPrompt: ex.inputPrompt !== undefined,
        changeStatus: changes.status ?? '—',
        execKeys: execKeys || '—',
      });
    }
    this.stateMachine.restoreTask(updated);
    if (!opts?.skipWorkflowStatusSync && changes.status !== undefined && existing.config.workflowId) {
      this.touchWorkflow(existing.config.workflowId);
    }
    return updated;
  }

  private writeResetAndSync(
    before: TaskState,
    kind: TaskResetKind,
    changes: TaskStateChanges,
    opts?: { skipWorkflowStatusSync?: boolean },
  ): TaskState {
    const updated = this.writeAndSync(before.id, changes, opts);
    assertResetComplete(before, updated, kind, { execution: changes.execution });
    return updated;
  }

  /**
   * Build an 'updated' TaskDelta with task-state continuity metadata.
   * `before` is the task state before the mutation, `after` is the state
   * returned by writeAndSync.
   */
  private buildUpdateDelta(before: TaskState, after: TaskState, changes: TaskStateChanges): TaskDelta {
    return buildTaskUpdateDelta(before, after, changes);
  }

  /**
   * Build a 'removed' TaskDelta with the task's last known task-state version.
   */
  private buildRemoveDelta(task: TaskState): TaskDelta {
    return buildTaskRemoveDelta(task);
  }

  private touchWorkflow(workflowId: string): void {
    if (!this.persistence.updateWorkflow) return;

    const tasks = this.stateMachine.getAllTasks().filter((task) => task.config.workflowId === workflowId);
    if (tasks.length === 0) return;

    this.persistence.updateWorkflow(workflowId, {
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * Create a new task: save to DB, then add to the in-memory cache.
   * Returns the new task state.
   */
  private createAndSync(task: TaskState): TaskState {
    const wfId = task.config.workflowId;
    if (!wfId) {
      throw new Error('createAndSync: task has no workflowId');
    }
    this.persistence.saveTask(wfId, task);
    this.stateMachine.restoreTask(task);
    return task;
  }

  /**
   * Return the root task IDs plus all transitive downstream dependents.
   * The returned list is de-duplicated and preserves first-seen order.
   */
  private collectSubgraphTaskIds(rootTaskIds: string[]): string[] {
    return collectSubgraphTaskIdsImpl(this as unknown as LifecycleHost, rootTaskIds);
  }

  private invalidateLaunchArtifactsForTasks(
    taskIds: readonly string[],
    reason: string,
    now: Date = new Date(),
  ): void {
    return invalidateLaunchArtifactsForTasksImpl(this as unknown as LifecycleHost, taskIds, reason, now);
  }

  /**
   * Reset root tasks and all downstream dependents to pending using the
   * provided reset payload. Returns the affected IDs and currently-ready IDs.
   */
  private resetSubgraphToPending(
    rootTaskIds: string[],
    kind: TaskResetKind,
    resetChanges: TaskStateChanges,
    opts?: { forceResetIds?: Set<string> },
  ): { affectedIds: string[]; readyIds: string[] } {
    return resetSubgraphToPendingImpl(this as unknown as LifecycleHost, rootTaskIds, kind, resetChanges, opts);
  }

  /**
   * Cancel-first invariant defense-in-depth: cancel any actively-running task
   * in the targeted scope before an invalidation reset. Full contract and
   * implementation notes live in `orchestrator/cancellation.ts`.
   */
  private cancelActiveBeforeInvalidation(scope: 'task' | 'workflow', id: string): string[] {
    return cancelActiveBeforeInvalidationImpl(this as unknown as CancellationHost, scope, id);
  }

  private cancelActiveCandidates(candidates: readonly TaskState[], scope: 'task' | 'workflow'): string[] {
    return cancelActiveCandidatesImpl(this as unknown as CancellationHost, candidates, scope);
  }

  private getExecutionGeneration(task: TaskState | undefined): number {
    return task?.execution.generation ?? 0;
  }

  private withBumpedExecutionGeneration(task: TaskState, changes: TaskStateChanges): TaskStateChanges {
    return {
      ...changes,
      execution: {
        ...changes.execution,
        generation: this.getExecutionGeneration(task) + 1,
      },
    };
  }

  private buildDiscardReviewGatePatch(
    task: TaskState,
    reason: string,
    nextGeneration: number,
    now: Date = new Date(),
  ): Partial<TaskExecution> {
    const reviewGate = task.execution.reviewGate;
    if (!reviewGate && !task.execution.reviewId && !task.execution.reviewUrl) return {};

    const discardedAt = now.toISOString();
    const oldArtifacts = reviewGate?.artifacts ?? [{
      id: task.execution.reviewId ?? 'review',
      ...(task.execution.reviewId ? { providerId: task.execution.reviewId } : {}),
      ...(task.execution.reviewUrl ? { url: task.execution.reviewUrl } : {}),
      required: true,
      status: 'discarded' as const,
      generation: task.execution.generation ?? 0,
      discardedAt,
      discardReason: reason,
    }];

    return {
      reviewUrl: undefined,
      reviewId: undefined,
      reviewStatus: undefined,
      reviewProviderId: undefined,
      reviewGate: {
        activeGeneration: nextGeneration,
        completion: { required: 'all', status: 'approved' },
        artifacts: oldArtifacts.map((artifact) =>
          artifact.discardedAt || artifact.status === 'discarded'
            ? artifact
            : {
                ...artifact,
                status: 'discarded',
                discardedAt,
                discardReason: reason,
              },
        ),
      },
    };
  }

  private withBumpedExecutionGenerationAndDiscardedReviewGate(
    task: TaskState,
    changes: TaskStateChanges,
    discardReason: string,
  ): TaskStateChanges {
    const bumpedChanges = this.withBumpedExecutionGeneration(task, changes);
    if (!task.config.isMergeNode) {
      return bumpedChanges;
    }

    const discardPatch = this.buildDiscardReviewGatePatch(
      task,
      discardReason,
      bumpedChanges.execution?.generation ?? this.getExecutionGeneration(task) + 1,
    );
    return {
      ...bumpedChanges,
      execution: {
        ...bumpedChanges.execution,
        ...discardPatch,
      },
    };
  }


  private getSelectedAttempt(task: TaskState | undefined): Attempt | undefined {
    const attemptId = task?.execution.selectedAttemptId;
    if (!attemptId) return undefined;
    return this.loadAttemptById(attemptId);
  }

  private loadAttemptById(attemptId: string | undefined): Attempt | undefined {
    if (!attemptId) return undefined;
    const loadAttempt = (this.persistence as Partial<OrchestratorPersistence>).loadAttempt;
    if (typeof loadAttempt !== 'function') return undefined;
    return loadAttempt.call(this.persistence, attemptId);
  }

  private attemptLeaseAnchor(attempt: Attempt): Date | undefined {
    return attempt.lastHeartbeatAt ?? attempt.claimedAt ?? attempt.startedAt;
  }

  private isAttemptLeaseActive(attempt: Attempt | undefined, now: number = Date.now()): boolean {
    if (!attempt) return false;
    if (isDiscardedAttempt(attempt)) return false;
    if (attempt.status !== 'claimed' && attempt.status !== 'running') return false;
    if (attempt.leaseExpiresAt) {
      return attempt.leaseExpiresAt.getTime() >= now;
    }
    const anchor = this.attemptLeaseAnchor(attempt);
    if (!anchor) return true;
    return anchor.getTime() + ATTEMPT_LEASE_MS >= now;
  }

  private isAttemptLeaseExpired(attempt: Attempt | undefined, now: number = Date.now()): boolean {
    if (!attempt) return false;
    if (isDiscardedAttempt(attempt)) return false;
    if (attempt.status !== 'claimed' && attempt.status !== 'running') return false;
    if (attempt.leaseExpiresAt) {
      return attempt.leaseExpiresAt.getTime() < now;
    }
    const anchor = this.attemptLeaseAnchor(attempt);
    if (!anchor) return false;
    return anchor.getTime() + ATTEMPT_LEASE_MS < now;
  }

  private isTaskExecutionActive(
    task: TaskState,
    attempt: Attempt | undefined,
    now: number = Date.now(),
  ): boolean {
    if (isCrashPreservedExecution(task.execution)) return false;
    if (attempt && this.isAttemptLeaseActive(attempt, now)) {
      return task.status === 'pending' || (task.status as string) === 'queued' || task.status === 'running' || task.status === 'fixing_with_ai';
    }
    if (attempt && this.isAttemptLeaseExpired(attempt, now)) {
      return false;
    }

    if (task.status !== 'running' && task.status !== 'fixing_with_ai') {
      return false;
    }
    const raw = task.execution.lastHeartbeatAt
      ?? task.execution.startedAt
      ?? task.execution.launchStartedAt;
    if (!raw) return true;
    const ts = raw instanceof Date
      ? raw.getTime()
      : typeof raw === 'string'
        ? Date.parse(raw)
        : Number.NaN;
    if (!Number.isFinite(ts)) return true;
    return ts + ATTEMPT_LEASE_MS >= now;
  }

  private isExecutableResponseTask(task: TaskState): boolean {
    if (isCrashPreservedExecution(task.execution)) return false;
    return task.status === 'running'
      || task.status === 'fixing_with_ai'
      || (
        (task.status === 'pending' || (task.status as string) === 'queued')
        && task.execution.phase === 'launching'
        && !!task.execution.selectedAttemptId
      );
  }

  private countActivePersistedAttempts(now: number = Date.now()): number {
    let count = 0;
    for (const task of this.stateMachine.getAllTasks()) {
      if (this.isTaskExecutionActive(task, this.getSelectedAttempt(task), now)) {
        count += 1;
      }
    }
    return count;
  }

  private clearQueuedSchedulerEntries(taskId: string, attemptId?: string): void {
    if (attemptId) {
      this.scheduler.removeJob(attemptId);
    }
    this.scheduler.removeJob(taskId);
  }

  getPersistedActiveTaskIds(now: number = Date.now()): Set<string> {
    const active = new Set<string>();
    for (const task of this.stateMachine.getAllTasks()) {
      if (this.isTaskExecutionActive(task, this.getSelectedAttempt(task), now)) {
        active.add(task.id);
      }
    }
    return active;
  }

  private ensureCurrentPendingAttempt(task: TaskState): string {
    const selected = this.getSelectedAttempt(task);
    if (selected && isActiveAttempt(selected)) {
      return selected.id;
    }

    const loadAttempts = (this.persistence as Partial<OrchestratorPersistence>).loadAttempts;
    const attempts =
      typeof loadAttempts === 'function' ? loadAttempts.call(this.persistence, task.id) : [];
    const current = attempts[attempts.length - 1];
    if (current && isActiveAttempt(current)) {
      if (task.execution.selectedAttemptId !== current.id) {
        this.writeAndSync(task.id, { execution: { selectedAttemptId: current.id } });
      }
      return current.id;
    }

    const upstreamAttemptIds = task.dependencies
      .map(depId => this.stateGetTask(depId)?.execution.selectedAttemptId)
      .filter((id): id is string => !!id);
    const freshAttempt = createAttempt(task.id, {
      status: 'pending',
      upstreamAttemptIds,
      supersedesAttemptId: current?.id,
    });
    if (current && !isOutcomeTerminalAttempt(current) && !isDiscardedAttempt(current)) {
      this.taskRepository.updateAttempt(current.id, { status: 'superseded' });
    }
    this.taskRepository.saveAttempt(freshAttempt);
    this.writeAndSync(task.id, { execution: { selectedAttemptId: freshAttempt.id } });
    return freshAttempt.id;
  }

  private replaceSelectedAttempt(
    task: TaskState,
    opts: Partial<Omit<Attempt, 'id' | 'nodeId' | 'createdAt'>> = {},
    writeOpts?: { skipWorkflowStatusSync?: boolean },
  ): string {
    const selected = this.getSelectedAttempt(task);
    const loadAttempts = (this.persistence as Partial<OrchestratorPersistence>).loadAttempts;
    const attempts =
      typeof loadAttempts === 'function' ? loadAttempts.call(this.persistence, task.id) : [];
    const current = selected ?? attempts[attempts.length - 1];

    if (current && !isOutcomeTerminalAttempt(current) && !isDiscardedAttempt(current)) {
      this.taskRepository.updateAttempt(current.id, { status: 'superseded' });
    }

    const upstreamAttemptIds = task.dependencies
      .map(depId => this.stateGetTask(depId)?.execution.selectedAttemptId)
      .filter((id): id is string => !!id);

    const freshAttempt = createAttempt(task.id, {
      status: 'pending',
      snapshotCommit: current?.commit,
      upstreamAttemptIds,
      supersedesAttemptId: current?.id,
      ...opts,
    });
    this.taskRepository.saveAttempt(freshAttempt);
    this.writeAndSync(task.id, { execution: { selectedAttemptId: freshAttempt.id } }, writeOpts);
    return freshAttempt.id;
  }

  prepareTaskForNewAttempt(taskId: string, reason: string): TaskState {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) {
      throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);
    }
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'closed') {
      throw new OrchestratorError(
        OrchestratorErrorCode.TASK_ALREADY_TERMINAL,
        `Task ${task.id} is terminal and cannot be prepared for a new attempt`,
      );
    }

    const selected = this.getSelectedAttempt(task);
    const loadAttempts = (this.persistence as Partial<OrchestratorPersistence>).loadAttempts;
    const attempts =
      typeof loadAttempts === 'function' ? loadAttempts.call(this.persistence, task.id) : [];
    const latest = attempts[attempts.length - 1];
    const activeAttempt = selected && isReplaceableAttemptStatus(selected.status)
      ? selected
      : latest && isReplaceableAttemptStatus(latest.status)
        ? latest
        : undefined;

    const upstreamAttemptIds = task.dependencies
      .map(depId => this.stateGetTask(depId)?.execution.selectedAttemptId)
      .filter((id): id is string => !!id);
    const freshAttempt = createAttempt(task.id, {
      status: 'pending',
      snapshotCommit: activeAttempt?.commit,
      upstreamAttemptIds,
      supersedesAttemptId: activeAttempt?.id,
    });

    const changes = this.withBumpedExecutionGeneration(task, buildTaskResetChanges('newAttempt', {
      execution: { selectedAttemptId: freshAttempt.id },
    }));

    let updated!: TaskState;
    this.taskRepository.runInTransaction(() => {
      if (activeAttempt) {
        this.taskRepository.updateAttempt(activeAttempt.id, { status: 'superseded' });
      }
      this.taskRepository.saveAttempt(freshAttempt);
      updated = this.writeResetAndSync(task, 'newAttempt', changes);
    });
    this.clearQueuedSchedulerEntries(task.id, task.execution.selectedAttemptId);
    this.persistence.logEvent?.(task.id, 'task.prepared_for_new_attempt', {
      reason,
      oldAttemptId: activeAttempt?.id,
      newAttemptId: freshAttempt.id,
    });
    this.messageBus.publish(TASK_DELTA_CHANNEL, this.buildUpdateDelta(task, updated, changes));
    return updated;
  }

  private updateSelectedAttempt(
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
  ): void {
    const attemptId = this.stateGetTask(taskId)?.execution.selectedAttemptId;
    if (!attemptId) return;
    this.taskRepository.updateAttempt(attemptId, changes);
  }

  // ── Commands ──────────────────────────────────────────────

  /**
   * Parse a plan definition and create tasks with dependencies.
   * Persists workflow and tasks, publishes deltas via MessageBus.
   */
  loadPlan(plan: PlanDefinition, opts?: { allowGraphMutation?: boolean }): void {
    const workflowId = nextWorkflowId();
    const localToScoped = buildPlanLocalToScopedIdMap(workflowId, plan.tasks);
    const workflowExternalDependencies = this.normalizePlanExternalDependencies([
      ...(plan.externalDependencies ?? []),
      ...plan.tasks.flatMap((task) => task.externalDependencies ?? []),
    ]);

    // ── Conflict check (read-only) ──────────────────────────
    if (!opts?.allowGraphMutation) {
      const newScopedIds = new Set(plan.tasks.map((t) => localToScoped.get(t.id)!));
      const existingTasks = this.stateMachine.getAllTasks();
      const overlapping = existingTasks.filter(
        (t) => newScopedIds.has(t.id) && !t.config.isMergeNode,
      );

      if (overlapping.length > 0) {
        const wfIds = new Set(overlapping.map((t) => t.config.workflowId).filter(Boolean) as string[]);
        const workflows = this.persistence.listWorkflows();
        const wfLookup = new Map(workflows.map((w) => [w.id, w.name]));
        const conflictingWorkflows = [...wfIds].map((id) => ({
          id,
          name: wfLookup.get(id) ?? 'unknown',
        }));
        const conflictingIds = [...new Set(overlapping.map((t) => t.id))];
        const wfSummary = conflictingWorkflows.map((w) => `"${w.name}" (${w.id})`).join(', ');

        throw new PlanConflictError(
          `Plan submission blocked: task IDs [${conflictingIds.join(', ')}] already exist ` +
          `in workflow ${wfSummary}.\n\n` +
          `Submitting this plan would modify the existing workflow's task graph. ` +
          `If this is intentional, set "allowGraphMutation": true in ` +
          `~/.invoker/config.json.`,
          conflictingIds,
          conflictingWorkflows,
        );
      }
    }

    // ── Pass 1: validate all tasks, build TaskState objects ──
    // No DB writes, no in-memory mutations. If anything throws,
    // zero side effects occur.
    const dependedOn = new Set<string>();
    for (const taskDef of plan.tasks) {
      for (const dep of taskDef.dependencies ?? []) {
        dependedOn.add(dep);
      }
    }

    const validatedTasks: TaskState[] = [];
    const resolvedRoutingByTaskId = new Map<string, ExecutorRoutingReason>();
    for (const taskDef of plan.tasks) {
      const resolvedRouting = resolveExecutorRouting(
        taskDef.id,
        taskDef.command,
        taskDef.poolId,
        this.defaultPoolId,
        this.executorRoutingRules,
        this.availablePoolIds,
      );
      const effectivePoolId = resolvedRouting.poolId;

      const scopedId = localToScoped.get(taskDef.id)!;
      resolvedRoutingByTaskId.set(
        scopedId,
        taskDef.dockerImage ? { type: 'dockerImage' } : resolvedRouting.reason,
      );
      const scopedDeps = (taskDef.dependencies ?? []).map((dep) => {
        const s = localToScoped.get(dep);
        if (!s) {
          throw new Error(`Task "${taskDef.id}" depends on unknown task id "${dep}" in this plan`);
        }
        return s;
      });
      const baseConfig = {
        workflowId,
        command: taskDef.command,
        prompt: taskDef.prompt,
        pivot: taskDef.pivot,
        experimentVariants: taskDef.experimentVariants,
        requiresManualApproval: taskDef.requiresManualApproval,
        featureBranch: taskDef.featureBranch,
        executionAgent: taskDef.executionAgent,
        executionModel: taskDef.executionModel,
        poolId: effectivePoolId,
      } as const;
      let taskConfig: TaskConfig;
      if (taskDef.dockerImage) {
        taskConfig = { ...baseConfig, runnerKind: 'docker' as const, dockerImage: taskDef.dockerImage };
      } else if (effectivePoolId) {
        taskConfig = { ...baseConfig, runnerKind: 'ssh' as const };
      } else {
        taskConfig = { ...baseConfig, runnerKind: 'worktree' as const };
      }
      const task = createTaskState(
        scopedId,
        taskDef.description,
        scopedDeps,
        taskConfig,
      );
      validatedTasks.push(task);
    }

    // Validate cross-workflow prerequisites exist before writing anything.
    const missingExternalDeps: string[] = [];
    for (const dep of workflowExternalDependencies) {
      if (!this.findExternalDependencyTask(dep.workflowId, dep.taskId)) {
        const depDisplayId = this.externalDependencyDisplayId(dep.workflowId, dep.taskId);
        missingExternalDeps.push(
          `workflow "${plan.name}" references missing external dependency "${depDisplayId}"`,
        );
      }
    }
    if (missingExternalDeps.length > 0) {
      throw new Error(
        `Plan submission blocked due to missing cross-workflow prerequisites:\n` +
          missingExternalDeps.map((s) => `- ${s}`).join('\n'),
      );
    }

    // Build merge node TaskState (still in validation pass — no writes yet)
    const leafIds = plan.tasks
      .filter((t) => !dependedOn.has(t.id))
      .map((t) => localToScoped.get(t.id)!);
    const mergeNodeId = `__merge__${workflowId}`;
    const mergeTask = createTaskState(
      mergeNodeId,
      descriptionForMergeNode(plan),
      leafIds,
      { workflowId, isMergeNode: true, runnerKind: 'merge' },
    );

    // ── Pass 2: all validation passed — persist everything ──
    this.activeWorkflowIds.add(workflowId);
    const createdAt = workflowTimestamp().toISOString();

    this.persistence.saveWorkflow({
      id: workflowId,
      name: plan.name,
      description: plan.description,
      visualProof: plan.visualProof,
      repoUrl: plan.repoUrl,
      intermediateRepoUrl: plan.intermediateRepoUrl,
      onFinish: plan.onFinish,
      baseBranch: plan.baseBranch,
      featureBranch: plan.featureBranch,
      mergeMode: plan.mergeMode,
      externalDependencies: workflowExternalDependencies.length > 0 ? workflowExternalDependencies : undefined,
      createdAt,
      updatedAt: createdAt,
    });

    const deltas: TaskDelta[] = [];
    for (const task of validatedTasks) {
      this.createAndSync(task);
      this.persistence.logEvent?.(task.id, 'task.created');
      this.persistence.logEvent?.(task.id, 'task.executor.routed', buildExecutorRoutedPayload(
        task.config.runnerKind ?? 'worktree',
        task.config.poolId,
        task.config.dockerImage ? { type: 'dockerImage' } : resolvedRoutingByTaskId.get(task.id) ?? { type: 'defaultWorktree' },
      ));
      deltas.push({ type: 'created', task });
    }

    this.createAndSync(mergeTask);
    this.persistence.logEvent?.(mergeTask.id, 'task.created');
    deltas.push({ type: 'created', task: mergeTask });

    for (const delta of deltas) {
      this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
    }

    this.reconcileMergeLeaves(workflowId);
  }

  /**
   * Start ready tasks up to the concurrency limit.
   * Returns the tasks that were started.
   */
  startExecution(): TaskState[] {
    this.refreshFromDb();
    this.pruneLaunchDeferrals();

    const activeAttempts = this.countActivePersistedAttempts();
    const readyTasks = this.getExecutableReadyTasks();
    this.logger.info('[orchestrator] startExecution', {
      ready: readyTasks.length,
      active: activeAttempts,
      maxConcurrency: this.maxConcurrency,
      readyIds: readyTasks.map((task) => task.id),
    });

    const launchPollNow = Date.now();
    const readyTaskIds = readyTasks
      .filter((task) => {
        // A task deferred for execution-pool capacity waits in line with a
        // heartbeat instead of being re-dispatched (and re-deferred) every poll.
        if (this.isLaunchParked(task.id, launchPollNow)) {
          this.emitLaunchWaitingHeartbeat(task.id, launchPollNow);
          return false;
        }
        return true;
      })
      .map((task) => task.id);

    return this.autoStartReadyTasks(readyTaskIds);
  }

  /**
   * Route a worker response through the pure parser, then apply
   * the parsed result via DB writes.
   */
  handleWorkerResponse(response: WorkResponse): TaskState[] {
    this.refreshFromDb();

    // Ignore responses for stale tasks — their processes are orphaned
    // and should not affect the graph.
    {
      const earlyTask = this.stateGetTask(response.actionId);
      if (earlyTask?.status === 'stale') {
        return [];
      }
      if (earlyTask) {
        const activeAttemptId = earlyTask.execution.selectedAttemptId;
        if (response.attemptId) {
          if (!activeAttemptId || response.attemptId !== activeAttemptId) {
            this.logger.warn('[worker-response] STALE_ATTEMPT_REJECTED', {
              taskId: earlyTask.id,
              responseAttemptId: response.attemptId,
              activeAttemptId: activeAttemptId ?? 'none',
              workerResponseStatus: response.status,
            });
            return [];
          }
        }
        const responseAttemptId = response.attemptId ?? activeAttemptId;
        const responseAttempt = this.loadAttemptById(responseAttemptId);
        if (isDiscardedAttempt(responseAttempt)) {
          this.logger.warn('[worker-response] SUPERSEDED_ATTEMPT_REJECTED', {
            taskId: earlyTask.id,
            responseAttemptId: responseAttemptId ?? 'none',
            activeAttemptId: activeAttemptId ?? 'none',
            workerResponseStatus: response.status,
          });
          return [];
        }
        const activeGeneration = this.getExecutionGeneration(earlyTask);
        if (
          response.executionGeneration !== undefined &&
          response.executionGeneration !== activeGeneration
        ) {
          this.logger.warn('[worker-response] STALE_GENERATION_REJECTED', {
            taskId: earlyTask.id,
            responseGeneration: response.executionGeneration,
            activeGeneration,
            workerResponseStatus: response.status,
          });
          return [];
        }
      }
      if (earlyTask) {
        if (!this.isExecutableResponseTask(earlyTask)) {
          this.logger.warn('[orchestrator] handleWorkerResponse: ignoring response for non-executable task', {
            workerResponseStatus: response.status,
            taskId: response.actionId,
            status: earlyTask.status,
            phase: earlyTask.execution.phase,
          });
          return [];
        }
      }
    }

    const parsed = this.responseHandler.parseResponse(response);
    if (!('type' in parsed)) {
      const parseErr = 'error' in parsed ? (parsed as { error: string }).error : 'unknown';
      const task = this.stateGetTask(response.actionId);

      if (!task) {
        this.logger.warn('[worker-response] PROTOCOL_FAILURE_UNKNOWN_TASK', {
          actionId: response.actionId,
          parseError: parseErr,
        });
        return [];
      }

      const canonicalTaskId = task.id;
      this.logger.warn('[worker-response] PROTOCOL_FAILURE', {
        taskId: canonicalTaskId,
        parseError: parseErr,
      });
      return this.finalizeFailedTask(
        canonicalTaskId,
        {
          exitCode: 1,
          error: 'Protocol error: ' + parseErr,
          protocolErrorCode: 'MALFORMED_RESPONSE',
          protocolErrorMessage: parseErr,
        },
        'task.protocol_failure',
      );
    }

    const taskId = parsed.taskId;
    const task = this.stateGetTask(taskId);
    if (!task) {
      this.logger.warn('[worker-response] task not in graph (stale response?)', { taskId });
      return [];
    }

    const canonicalTaskId = task.id;
    if (process.env.NODE_ENV !== 'test' && TRACE_WORKER_RESPONSE) {
      this.logger.info('[worker-response] write path', {
        parsedType: parsed.type,
        taskId: canonicalTaskId,
        graphStatusBefore: task.status,
        workerResponseStatus: response.status,
        executionGeneration: response.executionGeneration,
      });
    }

    switch (parsed.type) {
      case 'completed':
        return this.handleCompleted(canonicalTaskId, parsed);
      case 'review_ready':
        return this.handleReviewReady(canonicalTaskId, parsed);
      case 'failed':
        return this.handleFailed(canonicalTaskId, parsed);
      case 'needs_input':
        return this.handleNeedsInput(canonicalTaskId, parsed);
      case 'spawn_experiments':
        return this.handleSpawnExperiments(canonicalTaskId, parsed);
      case 'select_experiment':
        return this.handleSelectExperiment(canonicalTaskId, parsed);
      default:
        return [];
    }
  }

  /**
   * Resume a paused task with user input.
   */
  provideInput(taskId: string, input: string): void {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task || task.status !== 'needs_input') return;
    const id = task.id;

    const changes: TaskStateChanges = { status: 'running', execution: { inputPrompt: undefined } };
    const updated = this.writeAndSync(id, changes);
    if (task.execution.selectedAttemptId) {
      this.taskRepository.updateAttempt(task.execution.selectedAttemptId, { status: 'running' });
    }
    const delta: TaskDelta = this.buildUpdateDelta(task, updated, changes);
    this.persistence.logEvent?.(id, 'task.running', changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
  }

  escalateStalledToNeedsInput(taskId: string, prompt: string): void {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task || task.status !== 'failed') return;
    if (!isLivenessFailureClass(task.execution.failureClass)) return;
    const id = task.id;

    const changes: TaskStateChanges = {
      status: 'needs_input',
      execution: { inputPrompt: prompt, failureClass: undefined },
    };
    const updated = this.writeAndSync(id, changes);
    if (task.execution.selectedAttemptId) {
      this.taskRepository.updateAttempt(task.execution.selectedAttemptId, { status: 'needs_input' });
    }
    const delta: TaskDelta = this.buildUpdateDelta(task, updated, changes);
    this.persistence.logEvent?.(id, 'task.needs_input', changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
  }

  private setTaskApprovalStatus(
    taskId: string,
    status: 'awaiting_approval' | 'review_ready',
    eventName: 'task.awaiting_approval' | 'task.review_ready',
    additionalChanges?: TaskStateChanges,
    expectedLineage?: TaskLineageExpectation,
  ): void {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) return;
    if (!this.taskMatchesLineageExpectation(task, expectedLineage)) return;
    // Stale-write guard: lineage (id/attempt/generation) is preserved across a
    // same-attempt cancellation, so a late approval transition could resurrect a
    // cancelled/failed task. Only apply the transition while the task is still
    // executable.
    if (!this.isExecutableResponseTask(task)) return;
    const id = task.id;

    const additionalExecution = additionalChanges?.execution;
    const keepAgentSessionId = additionalExecution && 'agentSessionId' in additionalExecution
      ? additionalExecution.agentSessionId
      : task.execution.agentSessionId;
    const keepLastAgentSessionId = additionalExecution && 'lastAgentSessionId' in additionalExecution
      ? additionalExecution.lastAgentSessionId
      : task.execution.lastAgentSessionId;
    const keepAgentName = additionalExecution && 'agentName' in additionalExecution
      ? additionalExecution.agentName
      : task.execution.agentName;
    const keepLastAgentName = additionalExecution && 'lastAgentName' in additionalExecution
      ? additionalExecution.lastAgentName
      : task.execution.lastAgentName;

    const changes: TaskStateChanges = {
      status,
      config: additionalChanges?.config,
      execution: {
        ...additionalExecution,
        ...(keepAgentSessionId !== undefined ? { agentSessionId: keepAgentSessionId } : {}),
        ...(keepLastAgentSessionId !== undefined ? { lastAgentSessionId: keepLastAgentSessionId } : {}),
        ...(keepAgentName !== undefined ? { agentName: keepAgentName } : {}),
        ...(keepLastAgentName !== undefined ? { lastAgentName: keepLastAgentName } : {}),
        completedAt: new Date(),
      },
    };
    if (task.config.isMergeNode && changes.execution && 'workspacePath' in changes.execution) {
      mergeTrace(status === 'review_ready' ? 'GATE_WS_SET_TASK_REVIEW_READY' : 'GATE_WS_SET_TASK_AWAITING_APPROVAL', {
        taskId: id,
        workspacePath: changes.execution.workspacePath ?? null,
      });
      this.logger.info(
        `[merge-gate-workspace] setTask${status === 'review_ready' ? 'ReviewReady' : 'AwaitingApproval'}`,
        {
          mergeNode: id,
          workspacePath: changes.execution.workspacePath ?? 'NULL',
        },
      );
    }
    const updated = this.writeAndSync(id, changes);
    this.updateSelectedAttempt(id, {
      status: 'needs_input',
      completedAt: changes.execution?.completedAt,
      ...(changes.config?.summary !== undefined ? { summary: changes.config.summary } : {}),
      ...(changes.execution?.branch !== undefined ? { branch: changes.execution.branch } : {}),
      ...(changes.execution?.commit !== undefined ? { commit: changes.execution.commit } : {}),
      ...(changes.execution?.workspacePath !== undefined ? { workspacePath: changes.execution.workspacePath } : {}),
      ...(keepAgentSessionId !== undefined ? { agentSessionId: keepAgentSessionId } : {}),
    });
    const delta: TaskDelta = this.buildUpdateDelta(task, updated, changes);
    this.persistence.logEvent?.(id, eventName, changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);

    if (task.config.isMergeNode) {
      this.autoStartExternallyUnblockedReadyTasks();
      this.checkWorkflowCompletion();
    }
  }

  /**
   * Transition a running task directly to awaiting_approval.
   * Used for non-merge manual approvals and fix-approval flows.
   */
  setTaskAwaitingApproval(taskId: string, additionalChanges?: TaskStateChanges): void {
    this.setTaskApprovalStatus(taskId, 'awaiting_approval', 'task.awaiting_approval', additionalChanges);
  }

  /**
   * Transition a running merge gate directly to review_ready.
   * Used by merge-gate execution when output is ready for human review.
   */
  setTaskReviewReady(
    taskId: string,
    additionalChanges?: TaskStateChanges,
    expectedLineage?: TaskLineageExpectation,
  ): void {
    this.setTaskApprovalStatus(taskId, 'review_ready', 'task.review_ready', additionalChanges, expectedLineage);
  }

  setFixAwaitingApproval(
    taskId: string,
    originalError: string,
    expectedLineage?: TaskLineageExpectation,
  ): void {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);
    if (!this.taskMatchesLineageExpectation(task, expectedLineage)) return;
    const tid = task.id;
    if (task.status !== 'running' && task.status !== 'fixing_with_ai') {
      throw new Error(`Task ${tid} is not running or fixing with AI (status: ${task.status})`);
    }
    this.logger.info('[setFixAwaitingApproval]', {
      taskId: tid,
      agentSessionId: task.execution.agentSessionId,
    });
    if (task.config.isMergeNode) {
      this.logger.info('[merge-gate-workspace] setFixAwaitingApproval', {
        mergeNode: tid,
        workspacePath: task.execution.workspacePath ?? 'none',
        note: 'workspacePath unchanged by this call',
      });
      mergeTrace('GATE_WS_SET_FIX_AWAITING', {
        taskId: tid,
        workspacePath: task.execution.workspacePath ?? null,
      });
    }

    const changes: TaskStateChanges = {
      status: 'awaiting_approval',
      execution: {
        pendingFixError: originalError,
        isFixingWithAI: false,
        agentSessionId: task.execution.agentSessionId,
        lastAgentSessionId: task.execution.lastAgentSessionId ?? task.execution.agentSessionId,
        lastAgentName: task.execution.lastAgentName ?? task.execution.agentName,
      },
    };
    this.logger.info('[setFixAwaitingApproval] delta.changes.execution', {
      taskId: tid,
      execution: changes.execution,
    });
    const updated = this.writeAndSync(tid, changes);
    this.updateSelectedAttempt(tid, {
      status: 'needs_input',
      error: originalError,
      agentSessionId: task.execution.agentSessionId,
    });
    const delta: TaskDelta = this.buildUpdateDelta(task, updated, changes);
    this.persistence.logEvent?.(tid, 'task.awaiting_approval', changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
  }

  setBeforeApproveHook(fn: (task: TaskState) => Promise<void>): void {
    this.beforeApproveHook = fn;
  }

  /**
   * Completion invariant for review-backed merge gates: a merge node may only
   * reach `completed` once every current required artifact is `approved`.
   *
   * Without this, an approval minted for one state can be spent on another —
   * an auto-approve intent queued for a fix session drains behind that same
   * fix session's republish and lands on the freshly published, still-open
   * gate, reporting an unmerged stack as landed.
   */
  private assertReviewGateApprovable(task: TaskState): void {
    if (!task.config.isMergeNode) return;
    const unapproved = unapprovedRequiredReviewArtifacts(task);
    if (unapproved.length === 0) return;

    mergeTrace('APPROVE_SKIPPED_GATE_NOT_APPROVED', {
      taskId: task.id,
      workflowId: task.config.workflowId,
      status: task.status,
      pendingFixError: task.execution.pendingFixError !== undefined,
      unapproved: unapproved.map((artifact) => ({ id: artifact.id, status: artifact.status })),
    });
    this.logger.warn('[orchestrator.approve] refused: review gate not approved', {
      taskId: task.id,
      workflowId: task.config.workflowId,
      status: task.status,
      unapproved: unapproved.map((artifact) => `${artifact.id}:${artifact.status}`),
    });
    throw new OrchestratorError(
      OrchestratorErrorCode.REVIEW_GATE_NOT_APPROVED,
      `Cannot approve merge gate ${task.id}: ${unapproved.length} required review artifact(s) are not approved `
      + `(${unapproved.map((artifact) => `${artifact.id} is ${artifact.status}`).join(', ')}).`,
    );
  }

  /**
   * Approve a task awaiting approval. Fires beforeApproveHook (if set)
   * before transitioning state, so merge nodes get git-merged automatically.
   */
  async approve(taskId: string): Promise<TaskState[]> {
    mergeTrace('APPROVE_ENTER', { taskId });
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    mergeTrace('APPROVE_TASK_LOOKUP', { taskId, found: !!task, status: task?.status, isMergeNode: !!task?.config.isMergeNode, hasHook: !!this.beforeApproveHook });
    const isApprovalState = task?.status === 'awaiting_approval' || task?.status === 'review_ready';
    if (!task || !isApprovalState) {
      mergeTrace('APPROVE_SKIPPED_NOT_AWAITING', {
        taskId,
        found: !!task,
        status: task?.status ?? 'NOT_FOUND',
        pendingFixError: task?.execution.pendingFixError !== undefined,
      });
      this.logger.info('[orchestrator.approve] skipped', {
        taskId,
        reason: !task ? 'task not found' : 'unexpected status',
        status: task?.status,
      });
      return [];
    }

    this.assertReviewGateApprovable(task);

    if (this.beforeApproveHook) {
      mergeTrace('APPROVE_HOOK_FIRING', { taskId, workflowId: task.config.workflowId });
      await this.beforeApproveHook(task);
      mergeTrace('APPROVE_HOOK_DONE', { taskId });
    } else {
      mergeTrace('APPROVE_NO_HOOK', { taskId });
    }

    const changes: TaskStateChanges = {
      status: 'completed',
      execution: { completedAt: new Date(), fixSessionEntryStatus: undefined },
    };
    const updated = this.writeAndSync(taskId, changes);
    this.updateSelectedAttempt(taskId, {
      status: 'completed',
      completedAt: changes.execution?.completedAt,
    });
    const delta: TaskDelta = this.buildUpdateDelta(task, updated, changes);
    this.persistence.logEvent?.(taskId, 'task.completed', changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
    mergeTrace('APPROVE_DONE', { taskId });

    const workflowId = task.config.workflowId;
    if (workflowId) {
      const mergeNode = this.getMergeNode(workflowId);
      mergeTrace('APPROVE_MERGE_NODE_STATE', {
        taskId,
        workflowId,
        mergeNodeId: mergeNode?.id,
        mergeNodeStatus: mergeNode?.status,
        mergeNodeDeps: mergeNode?.dependencies,
        mergeNodeDepsStatuses: mergeNode?.dependencies.map(depId => {
          const dep = this.stateGetTask(depId);
          return { id: depId, status: dep?.status ?? 'NOT_FOUND' };
        }),
      });
    }

    const readyTaskIds = this.stateMachine.findNewlyReadyTasks(task.id);
    mergeTrace('APPROVE_READY_TASKS', { taskId: task.id, readyTaskIds });
    const started = this.autoStartReadyTasks(readyTaskIds);
    started.push(...this.autoStartUnblockedTasks());
    started.push(...this.autoStartExternallyUnblockedReadyTasks());
    mergeTrace('APPROVE_STARTED', { taskId: task.id, startedIds: started.map(t => t.id), startedStatuses: started.map(t => t.status) });
    this.checkWorkflowCompletion();
    return started;
  }

  async resumeTaskAfterFixApproval(taskId: string): Promise<TaskState[]> {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    const isApprovalState = task?.status === 'awaiting_approval' || task?.status === 'review_ready';
    if (!task || !isApprovalState || task.execution.pendingFixError === undefined) {
      return [];
    }

    const now = new Date();
    const changes: TaskStateChanges = {
      status: 'running',
      execution: { pendingFixError: undefined, fixSessionEntryStatus: undefined, startedAt: now, lastHeartbeatAt: now },
    };
    const updated = this.writeAndSync(taskId, changes);
    this.updateSelectedAttempt(taskId, {
      status: 'running',
      startedAt: now,
      lastHeartbeatAt: now,
    });
    const delta: TaskDelta = this.buildUpdateDelta(task, updated, changes);
    this.persistence.logEvent?.(taskId, 'task.running', changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
    return [this.stateGetTask(taskId)!];
  }

  /**
   * Reject a task awaiting approval. Fails it and blocks dependents.
   */
  reject(taskId: string, reason?: string): void {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task || (task.status !== 'awaiting_approval' && task.status !== 'review_ready')) return;

    const changes: TaskStateChanges = {
      status: 'failed',
      execution: { error: reason ?? 'Rejected', completedAt: new Date(), fixSessionEntryStatus: undefined },
    };
    const updated = this.writeAndSync(taskId, changes);
    this.updateSelectedAttempt(taskId, {
      status: 'failed',
      error: reason ?? 'Rejected',
      completedAt: changes.execution?.completedAt,
    });
    const delta: TaskDelta = this.buildUpdateDelta(task, updated, changes);
    this.persistence.logEvent?.(taskId, 'task.failed', changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);

    this.checkWorkflowCompletion();
  }

  selectExperiment(taskId: string, experimentId: string): TaskState[] {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task || !task.config.isReconciliation) return [];
    const reconId = task.id;

    const winner = this.stateGetTask(experimentId);
    const winnerId = winner?.id ?? experimentId;
    const previousSet = task.execution.selectedExperiments
      ?? (task.execution.selectedExperiment !== undefined
        ? [task.execution.selectedExperiment]
        : undefined);
    const canonicalize = (ids: readonly string[]) =>
      Array.from(new Set(ids)).slice().sort();
    const newCanon = canonicalize([winnerId]);
    const prevCanon = previousSet ? canonicalize(previousSet) : undefined;
    const sameAsPrev =
      prevCanon !== undefined &&
      prevCanon.length === newCanon.length &&
      prevCanon.every((id, i) => id === newCanon[i]);
    const isReSelection = previousSet !== undefined && !sameAsPrev;
    const allTasksBefore = this.stateMachine.getAllTasks();
    if (isReSelection) {
      const taskMapBefore = new Map(allTasksBefore.map((t) => [t.id, t]));
      const downstreamIds = getTransitiveDependents(reconId, taskMapBefore, () => false);
      for (const dsId of downstreamIds) {
        const dt = this.stateGetTask(dsId);
        if (!dt) continue;
        if (isActiveForInvalidation(dt.status)) {
          this.cancelTask(dsId);
        }
      }
    }

    const changes: TaskStateChanges = {
      status: 'completed',
      execution: {
        selectedExperiment: winnerId,
        completedAt: new Date(),
        branch: winner?.execution.branch,
        commit: winner?.execution.commit,
      },
    };
    const reconUpdated = this.writeAndSync(reconId, changes);
    this.updateSelectedAttempt(reconId, {
      status: 'completed',
      completedAt: changes.execution?.completedAt,
      branch: winner?.execution.branch,
      commit: winner?.execution.commit,
    });
    const delta: TaskDelta = this.buildUpdateDelta(task, reconUpdated, changes);
    this.persistence.logEvent?.(reconId, 'task.completed', changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);

    if (isReSelection) {
      const directDownstream = allTasksBefore
        .filter((t) => t.dependencies.includes(reconId))
        .map((t) => t.id);
      const reselectionAction = MUTATION_POLICIES.selectedExperiment.action;
      for (const dsId of directDownstream) {
        this.dispatchPostMutation(reselectionAction, dsId);
      }
    }
    const readyTaskIds = this.stateMachine.findNewlyReadyTasks(reconId);
    this.logger.info('[orchestrator] selectExperiment', {
      taskId: reconId,
      newlyReadyCount: readyTaskIds.length,
      readyTaskIds,
    });
    const started = this.autoStartReadyTasks(readyTaskIds);
    this.checkWorkflowCompletion();
    return started;
  }

  selectExperiments(
    taskId: string,
    experimentIds: string[],
    combinedBranch?: string,
    combinedCommit?: string,
  ): TaskState[] {
    if (experimentIds.length === 1) {
      return this.selectExperiment(taskId, experimentIds[0]);
    }

    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task || !task.config.isReconciliation) return [];
    const reconId = task.id;

    const previousSet = task.execution.selectedExperiments
      ?? (task.execution.selectedExperiment !== undefined
          ? [task.execution.selectedExperiment]
          : undefined);
    const canonicalize = (ids: readonly string[]) =>
      Array.from(new Set(ids)).slice().sort();
    const newCanon = canonicalize(experimentIds);
    const prevCanon = previousSet ? canonicalize(previousSet) : undefined;
    const sameAsPrev =
      prevCanon !== undefined &&
      prevCanon.length === newCanon.length &&
      prevCanon.every((id, i) => id === newCanon[i]);
    const isReSelection = previousSet !== undefined && !sameAsPrev;

    const allTasksBefore = this.stateMachine.getAllTasks();

    if (isReSelection) {
      const taskMapBefore = new Map(allTasksBefore.map((t) => [t.id, t]));
      const downstreamIds = getTransitiveDependents(reconId, taskMapBefore, () => false);
      for (const dsId of downstreamIds) {
        const dt = this.stateGetTask(dsId);
        if (!dt) continue;
        if (isActiveForInvalidation(dt.status)) {
          this.cancelTask(dsId);
        }
      }
    }

    const changes: TaskStateChanges = {
      status: 'completed',
      execution: {
        selectedExperiment: experimentIds[0],
        selectedExperiments: experimentIds,
        completedAt: new Date(),
        branch: combinedBranch,
        commit: combinedCommit,
      },
    };
    const reconUpdated = this.writeAndSync(reconId, changes);
    this.updateSelectedAttempt(reconId, {
      status: 'completed',
      completedAt: changes.execution?.completedAt,
      branch: combinedBranch,
      commit: combinedCommit,
    });
    const delta: TaskDelta = this.buildUpdateDelta(task, reconUpdated, changes);
    this.persistence.logEvent?.(reconId, 'task.completed', changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);

    if (isReSelection) {
      const directDownstreamAfter = this.stateMachine
        .getAllTasks()
        .filter((t) => t.dependencies.includes(reconId))
        .map((t) => t.id);
      const reselectionAction = MUTATION_POLICIES.selectedExperimentSet.action;
      for (const dsId of directDownstreamAfter) {
        if (this.stateGetTask(dsId)) {
          this.dispatchPostMutation(reselectionAction, dsId);
        }
      }
    }

    const readyTaskIds = this.stateMachine.findNewlyReadyTasks(reconId);
    this.logger.info('[orchestrator] selectExperiments', {
      taskId: reconId,
      newlyReadyCount: readyTaskIds.length,
      readyTaskIds,
    });
    const started = this.autoStartReadyTasks(readyTaskIds);
    this.checkWorkflowCompletion();
    return started;
  }

  restartTask(taskId: string): TaskState[] {
    return restartTaskImpl(this as unknown as LifecycleHost, taskId);
  }

  retryTask(taskId: string): TaskState[] {
    return retryTaskImpl(this as unknown as LifecycleHost, taskId);
  }

  retryWorkflow(workflowId: string): TaskState[] {
    return retryWorkflowImpl(this as unknown as LifecycleHost, workflowId);
  }

  recreateTask(taskId: string): TaskState[] {
    return recreateTaskImpl(this as unknown as LifecycleHost, taskId);
  }

  private applyRecreateReset(plan: InvalidationPlan, artifactReason: string): TaskState[] {
    return applyRecreateResetImpl(this as unknown as LifecycleHost, plan, artifactReason);
  }

  recreateDownstream(taskId: string): TaskState[] {
    return recreateDownstreamImpl(this as unknown as LifecycleHost, taskId);
  }

  private bumpWorkflowGeneration(workflowId: string): void {
    return bumpWorkflowGenerationImpl(this as unknown as LifecycleHost, workflowId);
  }

  recreateWorkflow(workflowId: string): TaskState[] {
    return recreateWorkflowImpl(this as unknown as LifecycleHost, workflowId);
  }

  async recreateWorkflowFromFreshBase(
    workflowId: string,
    options?: {
      refreshBase?: (
        workflowId: string,
      ) => Promise<{ commit?: string; branch?: string } | undefined | void>;
    },
  ): Promise<TaskState[]> {
    return recreateWorkflowFromFreshBaseImpl(this as unknown as MergeHost, workflowId, options);
  }

  getKnownFreshBaseCommit(workflowId: string): string | undefined {
    return getKnownFreshBaseCommitImpl(this as unknown as MergeHost, workflowId);
  }

  beginFixSession(
    taskId: string,
    opts: { savedError?: string; expectedLineage?: TaskLineageExpectation } = {},
  ): { savedError: string } {
    return beginFixSessionImpl(this as unknown as MergeHost, taskId, opts);
  }

  revertFixSession(
    taskId: string,
    opts: {
      savedError: string;
      fixError?: string;
      expectedLineage?: TaskLineageExpectation;
    },
  ): void {
    revertFixSessionImpl(this as unknown as MergeHost, taskId, opts);
  }

  reclaimStalledFixSession(
    taskId: string,
    opts: { reason: string; expectedLineage?: TaskLineageExpectation },
  ): 'reverted' | 'noop' {
    return reclaimStalledFixSessionImpl(this as unknown as MergeHost, taskId, opts);
  }

  private dispatchPostMutation(
    action: InvalidationAction,
    taskId: string,
  ): TaskState[] {
    return dispatchPostMutationImpl(this as unknown as LifecycleHost, action, taskId);
  }

  editTaskCommand(taskId: string, newCommand: string): TaskState[] {
    return editTaskCommandImpl(this as unknown as TaskEditHost, taskId, newCommand);
  }

  editTaskPrompt(taskId: string, newPrompt: string): TaskState[] {
    return editTaskPromptImpl(this as unknown as TaskEditHost, taskId, newPrompt);
  }

  editTaskType(taskId: string, runnerKind: string, poolMemberId?: string): TaskState[] {
    return editTaskTypeImpl(this as unknown as TaskEditHost, taskId, runnerKind, poolMemberId);
  }

  editTaskPool(taskId: string, poolId: string): TaskState[] {
    return editTaskPoolImpl(this as unknown as TaskEditHost, taskId, poolId);
  }

    editTaskModel(taskId: string, executionModel: string | null): TaskState[] {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);
    if (task.config.isMergeNode) throw new Error(`Cannot change execution model of merge node ${taskId}`);

    if (isActiveForInvalidation(task.status)) {
      this.cancelTask(taskId);
    }

    const modelChanges: TaskStateChanges = {
      config: { executionModel: executionModel?.trim() || undefined },
    };
    const modelBefore = this.stateGetTask(taskId)!;
    const modelUpdated = this.writeAndSync(taskId, modelChanges);
    const modelDelta: TaskDelta = this.buildUpdateDelta(modelBefore, modelUpdated, modelChanges);
    this.persistence.logEvent?.(taskId, 'task.updated', modelChanges);
    this.messageBus.publish(TASK_DELTA_CHANNEL, modelDelta);

    return this.dispatchPostMutation(MUTATION_POLICIES.executionModel.action, taskId);
  }

  editTaskAgent(taskId: string, agentName: string): TaskState[] {
    return editTaskAgentImpl(this as unknown as TaskEditHost, taskId, agentName);
  }

  editTaskMergeMode(
    taskId: string,
    mergeMode: 'manual' | 'automatic' | 'external_review',
  ): TaskState[] {
    return editTaskMergeModeImpl(this as unknown as TaskEditHost, taskId, mergeMode);
  }

  editTaskFixContext(
    taskId: string,
    patch: { fixPrompt?: string; fixContext?: string },
  ): TaskState[] {
    return editTaskFixContextImpl(this as unknown as TaskEditHost, taskId, patch);
  }

  /**
   * Update gate policy on one or more external dependencies for a task, then
   * immediately re-evaluate ready tasks that were blocked by external deps.
   *
   * Step 15 lock-in (`docs/architecture/task-invalidation-roadmap.md`,
   * chart row "Change external gate policy"): this is the engine's
   * ONLY intentionally non-invalidating execution-spec-adjacent
   * mutation. Per `MUTATION_POLICIES.externalGatePolicy`
   * (`invalidatesExecutionSpec: false`, `invalidateIfActive: false`,
   * `action: 'scheduleOnly'`):
   *
   *   - We do NOT bump `task.execution.generation`. Active and
   *     pending lineage survives the edit untouched.
   *   - We do NOT call `cancelTask` / `retryTask` / `recreateTask` /
   *     `applyInvalidation` with any retry/recreate route. Tasks
   *     that are running keep running on their existing execution
   *     lineage; the chart's "Change external gate policy" row is
   *     explicit that this "changes scheduling policy, not the task
   *     execution ABI".
   *   - We DO persist the updated gate-policy field on the task's
   *     external dependency entry.
   *   - We DO trigger a scheduling pass via
   *     `autoStartExternallyUnblockedReadyTasks` so any task
   *     previously blocked on the gate gets a fresh look.
   *
   * The orchestrator method is deliberately NOT routed through
   * `applyInvalidation('task', 'scheduleOnly', taskId, deps)` here
   * because the public method must remain synchronous for backward
   * compatibility (callers in app-layer-handoff-repro tests, the
   * api-server, and the headless `set gate-policy` verb invoke it
   * sync and immediately consume the returned `TaskState[]`).
   * `applyInvalidation` is `async`; routing through it would force
   * the public surface async. The chart's lock-in is instead
   * encoded in the policy table itself
   * (`MUTATION_POLICIES.externalGatePolicy.action === 'scheduleOnly'`)
   * and in `applyInvalidation`'s skip-cancel branch for that
   * action — so any future caller that DOES route through the
   * policy router (e.g. a hypothetical fork-class equivalent) gets
   * the same non-invalidating semantics as this method.
   */
  setWorkflowExternalGatePolicies(workflowId: string, updates: ExternalGatePolicyUpdate[]): TaskState[] {
    this.refreshFromDb();
    this.lastInvalidationPlan = planInvalidation({
      action: 'scheduleOnly',
      targetId: workflowId,
      tasks: this.stateMachine.getAllTasks(),
    });

    const workflow = this.persistence.loadWorkflow?.(workflowId)
      ?? this.persistence.listWorkflows().find((candidate) => candidate.id === workflowId);
    if (!workflow) {
      throw new OrchestratorError(OrchestratorErrorCode.WORKFLOW_NOT_FOUND, `Workflow ${workflowId} not found`);
    }
    const deps = workflow.externalDependencies;
    if (!deps || deps.length === 0) {
      throw new Error(`Workflow ${workflowId} has no external dependencies`);
    }
    if (!updates.length) return [];

    const keyOf = (workflowId: string, depTaskId?: string): string => {
      const normalizedTaskId = depTaskId?.trim() || '__merge__';
      return `${workflowId}::${normalizedTaskId}`;
    };

    const byKey = new Map<string, ExternalGatePolicyUpdate>();
    for (const update of updates) {
      if (update.gatePolicy !== 'completed' && update.gatePolicy !== 'review_ready') {
        throw new Error(`Invalid gatePolicy "${String(update.gatePolicy)}" for workflow ${workflowId}`);
      }
      byKey.set(keyOf(update.workflowId, update.taskId), update);
    }

    let changed = 0;
    const nextDeps = deps.map((dep): ExternalDependency => {
      const update = byKey.get(keyOf(dep.workflowId, dep.taskId));
      if (!update) return dep;
      const current = dep.gatePolicy ?? this.defaultExternalGatePolicy(dep.taskId);
      if (current === update.gatePolicy) return dep;
      changed += 1;
      return { ...dep, gatePolicy: update.gatePolicy };
    });

    if (changed === 0) return [];

    this.taskRepository.updateWorkflow(workflowId, { externalDependencies: nextDeps });
    const eventTask = this.getMergeNode(workflowId) ?? this.stateMachine.getAllTasks().find((task) => task.config.workflowId === workflowId);
    if (eventTask) this.persistence.logEvent?.(eventTask.id, 'workflow.external_dependency_policy_updated', {
      updates,
      changed,
    });

    // Re-evaluate and auto-start anything newly unblocked by this policy change.
    const started = this.autoStartExternallyUnblockedReadyTasks();
    this.checkWorkflowCompletion();
    return started;
  }

  setTaskExternalGatePolicies(taskId: string, updates: ExternalGatePolicyUpdate[]): TaskState[] {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);
    const workflowId = task.config.workflowId;
    if (!workflowId) {
      throw new Error(`Task ${taskId} has no workflowId`);
    }
    return this.setWorkflowExternalGatePolicies(workflowId, updates);
  }

  forkWorkflow(workflowId: string, opts?: { autoStart?: boolean }): ForkWorkflowResult {
    this.refreshWorkflowFromDb(workflowId);

    const sourceTasks = this.stateMachine
      .getAllTasks()
      .filter((t) => t.config.workflowId === workflowId);
    if (sourceTasks.length === 0) {
      throw new OrchestratorError(OrchestratorErrorCode.WORKFLOW_NOT_FOUND, `forkWorkflow: workflow ${workflowId} not found (no tasks)`);
    }

    this.cancelWorkflow(workflowId);

    this.refreshWorkflowFromDb(workflowId);
    const settledSourceTasks = this.stateMachine
      .getAllTasks()
      .filter((t) => t.config.workflowId === workflowId);

    const newWfId = nextWorkflowId();
    const sourceMeta = this.persistence.loadWorkflow?.(workflowId);
    const createdAt = workflowTimestamp().toISOString();
    const baseSaveWf: Parameters<OrchestratorPersistence['saveWorkflow']>[0] = {
      id: newWfId,
      name: sourceMeta && (sourceMeta as { name?: string }).name
        ? `${(sourceMeta as { name: string }).name} (fork of ${workflowId})`
        : `Fork of ${workflowId}`,
      createdAt,
      updatedAt: createdAt,
    };
    if (sourceMeta) {
      const m = sourceMeta as Record<string, unknown>;
      if (typeof m.description === 'string') baseSaveWf.description = m.description;
      if (typeof m.visualProof === 'boolean') baseSaveWf.visualProof = m.visualProof as boolean;
      if (typeof m.repoUrl === 'string') baseSaveWf.repoUrl = m.repoUrl;
      if (typeof m.intermediateRepoUrl === 'string') baseSaveWf.intermediateRepoUrl = m.intermediateRepoUrl;
      if (typeof m.onFinish === 'string') baseSaveWf.onFinish = m.onFinish;
      if (typeof m.baseBranch === 'string') baseSaveWf.baseBranch = m.baseBranch;
      if (typeof m.featureBranch === 'string') baseSaveWf.featureBranch = m.featureBranch;
      if (m.mergeMode === 'manual' || m.mergeMode === 'automatic' || m.mergeMode === 'external_review') {
        baseSaveWf.mergeMode = m.mergeMode;
      }
      if (Array.isArray(m.externalDependencies)) {
        baseSaveWf.externalDependencies = m.externalDependencies as ExternalDependency[];
      }
      if (Array.isArray(m.externalDependencyChanges)) {
        baseSaveWf.externalDependencyChanges = m.externalDependencyChanges as ExternalDependencyChange[];
      }
    }
    this.persistence.saveWorkflow(baseSaveWf);
    this.persistence.updateWorkflow?.(newWfId, { generation: 1, updatedAt: createdAt });

    const sourceMergeNode = settledSourceTasks.find((t) => t.config.isMergeNode);
    const sourceNonMerge = settledSourceTasks.filter((t) => !t.config.isMergeNode);

    const idRemap = new Map<string, string>();
    for (const t of sourceNonMerge) {
      const planLocalId = this.extractPlanLocalId(t.id, workflowId);
      idRemap.set(t.id, scopePlanTaskId(newWfId, planLocalId));
    }
    const newMergeId = `__merge__${newWfId}`;

    this.activeWorkflowIds.add(newWfId);

    const dependedOn = new Set<string>();
    for (const t of sourceNonMerge) {
      for (const dep of t.dependencies) {
        if (idRemap.has(dep)) dependedOn.add(dep);
      }
    }

    const createdNew: TaskState[] = [];
    for (const src of sourceNonMerge) {
      const newId = idRemap.get(src.id)!;
      const newDeps = src.dependencies.map((d) => idRemap.get(d) ?? d);
      const baseConfig = src.config;
      const remappedParent = baseConfig.parentTask && idRemap.has(baseConfig.parentTask)
        ? idRemap.get(baseConfig.parentTask)!
        : baseConfig.parentTask;
      const newConfig: TaskConfig = {
        ...baseConfig,
        workflowId: newWfId,
        parentTask: remappedParent,
        summary: undefined,
      };
      const newTask = createTaskState(newId, src.description, newDeps, newConfig);
      this.createAndSync(newTask);
      this.messageBus.publish(TASK_DELTA_CHANNEL, { type: 'created', task: newTask });
      this.persistence.logEvent?.(newId, 'task.forked_from', { sourceTaskId: src.id });
      createdNew.push(newTask);
    }

    const leafIds = sourceNonMerge
      .filter((t) => !dependedOn.has(t.id))
      .map((t) => idRemap.get(t.id)!);
    const mergeDescription = sourceMergeNode?.description
      ?? `Workflow gate (fork of ${workflowId})`;
    const newMerge = createTaskState(
      newMergeId,
      mergeDescription,
      leafIds,
      { workflowId: newWfId, isMergeNode: true, runnerKind: 'merge' },
    );
    this.createAndSync(newMerge);
    this.messageBus.publish(TASK_DELTA_CHANNEL, { type: 'created', task: newMerge });

    this.reconcileMergeLeaves(newWfId);

    // Forking invalidates anything that depended on the source
    // workflow; cascade against the source workflowId, not the fork.
    this.cascadeInvalidationToDownstream(workflowId);

    const autoStart = opts?.autoStart !== false;
    let started: TaskState[] = [];
    if (autoStart) {
      const readyIds = this.stateMachine
        .getReadyTasks()
        .map((t) => t.id)
        .filter((id) => this.stateGetTask(id)?.config.workflowId === newWfId);
      started = this.autoStartReadyTasks(readyIds);
    }

    return { forkedWorkflowId: newWfId, sourceWorkflowId: workflowId, started };
  }

  private extractPlanLocalId(scopedId: string, workflowId: string): string {
    const prefix = `${workflowId}/`;
    if (scopedId.startsWith(prefix)) {
      return scopedId.slice(prefix.length);
    }
    return scopedId;
  }

  /**
   * Replace a broken/failed task with a new subgraph.
   *
   * Marks the broken task as stale, creates replacement tasks,
   * forks downstream dependents to point at the replacement output,
   * and auto-starts ready replacement tasks.
   */
  replaceTask(taskId: string, replacementTasks: TaskReplacementDef[]): TaskState[] {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);
    if (task.status === 'running' || task.status === 'fixing_with_ai') throw new Error(`Cannot replace running task ${taskId}`);
    if (replacementTasks.length === 0) throw new Error('Must provide at least one replacement task');

    const wfId = task.config.workflowId;
    if (!wfId) throw new Error(`replaceTask: task ${taskId} has no workflowId`);

    if (this.isWorkflowLive(wfId)) {
      const fork = this.forkWorkflow(wfId, { autoStart: false });
      const planLocalId = this.extractPlanLocalId(task.id, wfId);
      const forkedTaskId = scopePlanTaskId(fork.forkedWorkflowId, planLocalId);
      const forkedTask = this.stateGetTask(forkedTaskId);
      if (!forkedTask) {
        throw new Error(
          `replaceTask: forked workflow ${fork.forkedWorkflowId} missing copy of ` +
            `task ${task.id} (expected ${forkedTaskId})`,
        );
      }
      const startedFromReplacement = this.replaceTaskInPlace(
        forkedTask,
        fork.forkedWorkflowId,
        replacementTasks,
      );
      const forkReadyIds = this.stateMachine
        .getReadyTasks()
        .map((t) => t.id)
        .filter(
          (id) =>
            this.stateGetTask(id)?.config.workflowId === fork.forkedWorkflowId &&
            !startedFromReplacement.some((s) => s.id === id),
        );
      return [...startedFromReplacement, ...this.autoStartReadyTasks(forkReadyIds)];
    }

    return this.replaceTaskInPlace(task, wfId, replacementTasks);
  }

  private replaceTaskInPlace(
    task: TaskState,
    wfId: string,
    replacementTasks: TaskReplacementDef[],
  ): TaskState[] {

    const replacementRawIds = new Set(replacementTasks.map((t) => t.id));
    const scopeLocal = (local: string) => scopePlanTaskId(wfId, local);

    // 1. Stale the broken task and all downstream (except merge node)
    const sourceId = task.id;
    const allTasks = this.stateMachine.getAllTasks();
    const taskMap = new Map(allTasks.map((t) => [t.id, t]));
    const descendantIds = getTransitiveDependents(
      sourceId,
      taskMap,
      (t) => !!t.config.isMergeNode,
    );
    this.invalidateLaunchArtifactsForTasks([sourceId, ...descendantIds], 'task replacement');
    for (const id of descendantIds) {
      const staleBefore = this.stateGetTask(id);
      if (!staleBefore) continue;
      const staleChanges: TaskStateChanges = { status: 'stale' };
      const staleUpdated = this.writeAndSync(id, staleChanges);
      this.updateSelectedAttempt(id, { status: 'superseded' });
      this.persistence.logEvent?.(id, 'task.stale', staleChanges);
      this.messageBus.publish(TASK_DELTA_CHANNEL, this.buildUpdateDelta(staleBefore, staleUpdated, staleChanges));
      this.clearQueuedSchedulerEntries(id, staleBefore.execution.selectedAttemptId);
    }
    const sourceBefore = this.stateGetTask(sourceId)!;
    const sourceChanges: TaskStateChanges = { status: 'stale' };
    const sourceUpdated = this.writeAndSync(sourceId, sourceChanges);
    this.updateSelectedAttempt(sourceId, { status: 'superseded' });
    this.persistence.logEvent?.(sourceId, 'task.stale', sourceChanges);
    this.messageBus.publish(TASK_DELTA_CHANNEL, this.buildUpdateDelta(sourceBefore, sourceUpdated, sourceChanges));
    this.clearQueuedSchedulerEntries(sourceId, sourceBefore.execution.selectedAttemptId);

    // 2. Create replacement tasks
    for (const rt of replacementTasks) {
      const hasInternalDeps =
        rt.dependencies?.length && rt.dependencies.some((d) => replacementRawIds.has(d));
      const scopedId = scopeLocal(rt.id);
      const deps = hasInternalDeps
        ? rt.dependencies!.map((d) => scopeLocal(d))
        : [...task.dependencies];
      const rtRunnerKind = normalizeRunnerKind(rt.runnerKind) ?? task.config.runnerKind ?? 'worktree';
      const rtBase = {
        workflowId: wfId,
        command: rt.command,
        prompt: rt.prompt,
        executionAgent: rt.executionAgent ?? task.config.executionAgent,
        executionModel: rt.executionModel ?? task.config.executionModel,
        poolId: task.config.poolId,
      } as const;
      // Replacement tasks inherit executor config from the parent task.
      // The switch narrows the config so TS accepts the correct variant.
      let rtConfig: TaskConfig;
      switch (rtRunnerKind) {
        case 'docker':
          rtConfig = {
            ...rtBase, runnerKind: 'docker',
            dockerImage: task.config.runnerKind === 'docker' ? task.config.dockerImage : undefined,
          };
          break;
        case 'ssh':
          rtConfig = ({
            ...rtBase, runnerKind: 'ssh',
            poolMemberId: task.config.runnerKind === 'ssh' ? (task.config as { poolMemberId?: string }).poolMemberId : undefined,
          } as unknown) as TaskConfig;
          break;
        default:
          rtConfig = { ...rtBase, runnerKind: 'worktree' as const };
          break;
      }
      const newTask = createTaskState(scopedId, rt.description, deps, rtConfig);
      this.createAndSync(newTask);
      this.messageBus.publish(TASK_DELTA_CHANNEL, { type: 'created', task: newTask });
    }

    // 3. Reconcile merge node deps from actual graph state
    this.reconcileMergeLeaves(wfId);

    // Auto-start ready replacement root tasks
    const rootIds = replacementTasks
      .filter((rt) => {
        const hasInternalDeps =
          rt.dependencies?.length && rt.dependencies.some((d) => replacementRawIds.has(d));
        return !hasInternalDeps;
      })
      .map((rt) => scopeLocal(rt.id));
    return this.autoStartReadyTasks(rootIds, 0, { bypassLocalDependencyReadiness: true });
  }

  deleteTask(taskId: string): TaskState[] {
    this.refreshFromDb();

    const task = this.stateGetTask(taskId);
    if (!task) throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task "${taskId}" not found`);
    if (task.config.isMergeNode) throw new Error(`Cannot delete merge task "${taskId}"`);

    const workflowId = task.config.workflowId;
    if (!workflowId) throw new Error(`deleteTask: task ${taskId} has no workflowId`);

    const workflowTasks = this.stateMachine
      .getAllTasks()
      .filter((candidate) => candidate.config.workflowId === workflowId);
    const remainingNonMergeTasks = workflowTasks.filter(
      (candidate) => candidate.id !== task.id && !candidate.config.isMergeNode,
    );
    if (remainingNonMergeTasks.length === 0) {
      throw new Error(`Cannot delete the last task in workflow "${workflowId}"; delete the workflow instead.`);
    }

    const directDependents = workflowTasks.filter(
      (candidate) =>
        candidate.id !== task.id &&
        !candidate.config.isMergeNode &&
        candidate.dependencies.includes(task.id),
    );
    const upstreamDeps = task.dependencies;
    const retargetDeltas: TaskDelta[] = [];

    const retargetDependencies = (dependencies: readonly string[]): string[] => {
      const next: string[] = [];
      const seen = new Set<string>();
      const add = (dependencyId: string) => {
        if (dependencyId === task.id || dependencyId.length === 0 || seen.has(dependencyId)) return;
        seen.add(dependencyId);
        next.push(dependencyId);
      };

      for (const dependencyId of dependencies) {
        if (dependencyId === task.id) {
          for (const upstreamId of upstreamDeps) add(upstreamId);
        } else {
          add(dependencyId);
        }
      }
      return next;
    };

    this.taskRepository.runInTransaction(() => {
      this.invalidateLaunchArtifactsForTasks([task.id], 'task deletion');

      for (const dependent of directDependents) {
        const dependencies = retargetDependencies(dependent.dependencies);
        const changes: TaskStateChanges = { dependencies };
        const updated = this.writeAndSync(dependent.id, changes);
        retargetDeltas.push(this.buildUpdateDelta(dependent, updated, changes));
      }

      this.deferredTaskIds.delete(task.id);
      this.clearQueuedSchedulerEntries(task.id, task.execution.selectedAttemptId);
      this.taskRepository.deleteTask(task.id);
      this.touchWorkflow(workflowId);
    });

    this.syncAllFromDb();

    for (const delta of retargetDeltas) {
      this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
    }
    this.messageBus.publish(TASK_DELTA_CHANNEL, this.buildRemoveDelta(task));
    this.reconcileMergeLeaves(workflowId);

    const readyIds = directDependents
      .map((dependent) => dependent.id)
      .filter((id) => this.stateGetTask(id));
    return this.autoStartReadyTasks(readyIds, Orchestrator.EXPEDITED_PRIORITY);
  }

  /**
   * Recompute the merge node's dependencies from the actual graph state.
   * Active (non-stale, non-merge) leaf tasks become the merge gate's deps.
   * No-ops if deps are already correct.
   */
  private reconcileMergeLeaves(workflowId: string): void {
    reconcileMergeLeavesImpl(this as unknown as GraphMutationHost, workflowId);
    assertMergeLeavesInvariantImpl(this as unknown as GraphMutationHost, workflowId);
  }

  /**
   * Returns true if the workflow has any non-merge task doing live work
   * (`pending`, `running`, `fixing_with_ai`, `needs_input`,
   * `awaiting_approval`, `review_ready`, or a `blocked` task still held by an
   * external cross-workflow gate).
   *
   * A task left `blocked` by a terminated/failed in-workflow upstream (with no
   * external gate) is treated as NOT live: it is inert until the upstream is
   * retried, so it must not keep an otherwise-dead workflow "live" and force
   * `replaceTask` to fork instead of mutating in place.
   *
   * The merge node is excluded because it stays `pending` for the whole
   * workflow lifetime — including it would make every workflow live
   * forever. Step 11 uses this check to gate topology-changing graph
   * mutations (`replaceTask`).
   */
  private isWorkflowLive(workflowId: string): boolean {
    const workflowTasks = this.stateMachine
      .getAllTasks()
      .filter((t) => t.config.workflowId === workflowId);
    const tasksById = new Map(workflowTasks.map((t) => [t.id, t]));
    return workflowTasks.some((t) => {
      if (t.config.isMergeNode) return false;
      if (!LIVE_TASK_STATUSES.has(t.status)) return false;
      // A task left `blocked` behind a terminated/failed in-workflow upstream
      // is inert: it cannot progress until that upstream is retried, so it does
      // not keep the workflow "live". A task blocked on an external
      // cross-workflow gate has all its in-workflow deps satisfied (no failed
      // path) and stays live. Deriving this from dependency status — instead of
      // a coarse workflow-scoped heuristic — is precise per task and survives
      // reloads, because task statuses are persisted.
      if (t.status === 'blocked' && hasFailedDependencyPath(t, tasksById)) {
        return false;
      }
      return true;
    });
  }

  private assertMergeLeavesInvariant(workflowId: string): void {
    assertMergeLeavesInvariantImpl(this as unknown as GraphMutationHost, workflowId);
    assertMergeExperimentDependenciesInvariantImpl(this as unknown as GraphMutationHost, workflowId);
  }

  /**
   * Load tasks from ALL workflows into the state machine.
   * Iterates over listWorkflows() -> loadTasks(wfId) for each.
   * The workflow FK is the single source of truth.
   */
  syncAllFromDb(): void {
    this.stateMachine.clear();
    this.activeWorkflowIds.clear();
    const snapshot = this.persistence.loadWorkflowTaskSnapshot?.();
    const workflows = snapshot?.workflows ?? this.persistence.listWorkflows();
    for (const wf of workflows) {
      this.activeWorkflowIds.add(wf.id);
      const tasks = snapshot?.tasksByWorkflowId.get(wf.id) ?? this.persistence.loadTasks(wf.id);
      for (const task of tasks) {
        this.stateMachine.restoreTask(task);
      }
    }
    for (const wf of workflows) {
      this.assertMergeLeavesInvariant(wf.id);
    }
  }

  /**
   * Load tasks from a single workflow. Kept for backward compatibility
   * (e.g. resuming a specific workflow).
   */
  syncFromDb(workflowId: string): void {
    this.activeWorkflowIds.add(workflowId);
    this.stateMachine.clear();
    for (const wfId of this.activeWorkflowIds) {
      const tasks = this.persistence.loadTasks(wfId);
      for (const task of tasks) {
        this.stateMachine.restoreTask(task);
      }
    }
    this.assertMergeLeavesInvariant(workflowId);
  }

  /**
   * Incrementally hydrate a workflow into the existing in-memory graph without
   * clearing already-loaded workflows. This is used for staged GUI startup so
   * first render can depend on one workflow and the rest can stream in later.
   */
  hydrateWorkflowFromDb(workflowId: string): void {
    this.refreshWorkflowFromDb(workflowId);
    this.assertMergeLeavesInvariant(workflowId);
  }

  /**
   * Resume a previously persisted workflow by restoring tasks
   * and auto-starting ready tasks.
   */
  private isRecoverableResumeTask(task: TaskState): boolean {
    if (task.status === 'running') return true;
    if ((task.status !== 'pending' && (task.status as string) !== 'queued') || !task.execution.selectedAttemptId) return false;
    if (task.execution.phase === 'launching') return true;

    return Boolean(
      task.execution.startedAt
      || task.execution.launchStartedAt
      || task.execution.launchCompletedAt
      || task.execution.lastHeartbeatAt
      || task.execution.workspacePath
      || task.execution.agentSessionId
      || task.execution.containerId
      || task.execution.error
      || task.execution.exitCode !== undefined
      || task.execution.inputPrompt
      || task.execution.pendingFixError,
    );
  }

  resumeWorkflow(workflowId: string): TaskState[] {
    this.syncFromDb(workflowId);
    const workflowTaskIds = new Set(this.persistence.loadTasks(workflowId).map((task) => task.id));
    const tasksToRecover = this.stateMachine
      .getAllTasks()
      .filter((task) => task.config.workflowId === workflowId || workflowTaskIds.has(task.id))
      .filter((task) => this.isRecoverableResumeTask(task));
    for (const task of tasksToRecover) {
      this.prepareTaskForNewAttempt(task.id, 'resume_workflow_recovery');
    }
    return this.startExecution();
  }

  /**
   * Remove a workflow from in-memory state and reload remaining workflows.
   * Called after the workflow has been deleted from the DB.
   * @deprecated Use deleteWorkflow() instead — it coordinates DB, scheduler, memory, and UI in one call.
   */
  removeWorkflow(workflowId: string): void {
    this.activeWorkflowIds.delete(workflowId);
    this.stateMachine.clear();
    for (const wfId of this.activeWorkflowIds) {
      const tasks = this.persistence.loadTasks(wfId);
      for (const task of tasks) {
        this.stateMachine.restoreTask(task);
      }
    }
  }

  /**
   * Remove all workflows from in-memory state.
   * Called after all workflows have been deleted from the DB.
   * @deprecated Use deleteAllWorkflows() instead — it coordinates DB, scheduler, memory, and UI in one call.
   */
  removeAllWorkflows(): void {
    this.activeWorkflowIds.clear();
    this.stateMachine.clear();
    this.scheduler.clearQueue();
  }

  /**
   * Delete a single workflow: DB first, then scheduler, memory, and publish removal deltas.
   * Follows the same DB→memory→publish pattern as writeAndSync().
   */
  private resolveDetachDefaultBranch(
    workflowId: string,
    workflow: { repoUrl?: string } | undefined,
  ): string {
    const repoUrl = workflow?.repoUrl?.trim();
    if (!repoUrl) {
      throw new Error(`Cannot detach workflow ${workflowId}: missing repo URL for default branch resolution.`);
    }
    return this.resolveRepoDefaultBranch(repoUrl);
  }

  deleteWorkflow(workflowId: string): void {
    this.syncAllFromDb();


    // 1. Detach direct dependents before the delete so they retarget to the
    // repo default branch instead of becoming permanently blocked on a missing
    // prerequisite.
    const directDependents = this.collectDirectDependentWorkflowIds(workflowId);
    const workflowMetadata = this.persistence.listWorkflows();
    const directDependentBaseBranches = new Map<string, string>();
    for (const dependentWorkflowId of directDependents) {
      const dependentWorkflow = this.persistence.loadWorkflow?.(dependentWorkflowId)
        ?? workflowMetadata.find((candidate) => candidate.id === dependentWorkflowId);
      directDependentBaseBranches.set(
        dependentWorkflowId,
        this.resolveDetachDefaultBranch(dependentWorkflowId, dependentWorkflow),
      );
    }
    for (const dependentWorkflowId of directDependents) {
      this.detachWorkflowInternal(
        dependentWorkflowId,
        workflowId,
        directDependentBaseBranches.get(dependentWorkflowId)!,
      );
    }

    // 2. Collect affected tasks before DB delete (needed for deltas and scheduler cleanup)
    const affectedTasks = this.stateMachine.getAllTasks().filter(
      (t) => t.config.workflowId === workflowId,
    );

    // 3. DB first — single source of truth
    this.persistence.deleteWorkflow?.(workflowId);

    // 4. Clean scheduler: free slots for all tasks in this workflow
    for (const task of affectedTasks) {
      this.clearQueuedSchedulerEntries(task.id, task.execution.selectedAttemptId);
    }

    // 5. Reload all surviving workflows from the DB so the cache reflects the
    // detach edits plus the workflow removal.
    this.syncAllFromDb();

    // 6. Publish removal deltas — drives UI cache cleanup via messageBus subscriber
    for (const task of affectedTasks) {
      this.messageBus.publish(TASK_DELTA_CHANNEL, this.buildRemoveDelta(task));
    }
  }

  detachWorkflow(workflowId: string, upstreamWorkflowId: string): void {
    this.syncAllFromDb();
    this.detachWorkflowInternal(workflowId, upstreamWorkflowId);
  }

  /**
   * Delete all workflows: DB first, then scheduler, memory, and publish removal deltas.
   * Follows the same DB→memory→publish pattern as writeAndSync().
   */
  deleteAllWorkflows(options?: DeleteAllWorkflowsOptions): void {
    const { publishRemovalDeltas = true } = options ?? {};

    // 1. Collect all tasks before clearing (needed for deltas)
    const allTasks = publishRemovalDeltas ? this.stateMachine.getAllTasks() : [];

    // 2. DB first
    this.persistence.deleteAllWorkflows?.();

    // 3. Clear scheduler
    this.scheduler.clearQueue();

    // 4. Clear memory
    this.activeWorkflowIds.clear();
    this.stateMachine.clear();

    // 5. Publish removal deltas (skipped when publishRemovalDeltas is false)
    for (const task of allTasks) {
      this.messageBus.publish(TASK_DELTA_CHANNEL, this.buildRemoveDelta(task));
    }
  }

  // ── Queries ───────────────────────────────────────────────

  /**
   * In tests only: resolve bare plan-local ids (e.g. `t1`) to `wf-…/t1` when exactly one loaded
   * workflow has that task. Production always uses fully-qualified ids from the graph.
   */
  private bareToScopedIfUnique(taskId: string): string | undefined {
    if (process.env.NODE_ENV !== 'test') return undefined;
    if (taskId.includes('/') || taskId.startsWith('__merge__')) return undefined;
    const sm = this.stateMachine;
    const wfs = this.getWorkflowIds();
    const hits: string[] = [];
    for (const wf of wfs) {
      const s = scopePlanTaskId(wf, taskId);
      if (sm.getTask(s)) hits.push(s);
    }
    return hits.length === 1 ? hits[0] : undefined;
  }

  private stateGetTask(taskId: string): TaskState | undefined {
    const sm = this.stateMachine;
    const t0 = sm.getTask(taskId);
    if (t0) return t0;
    const alt = this.bareToScopedIfUnique(taskId);
    return alt ? sm.getTask(alt) : undefined;
  }

  private taskMatchesLineageExpectation(task: TaskState, expected?: TaskLineageExpectation): boolean {
    if (!expected) return true;
    if (expected.taskId !== undefined && expected.taskId !== task.id) return false;
    if (expected.selectedAttemptId !== task.execution.selectedAttemptId) return false;
    if (expected.generation !== undefined && expected.generation !== (task.execution.generation ?? 0)) return false;
    return true;
  }

  getTask(taskId: string): TaskState | undefined {
    return this.stateGetTask(taskId);
  }

  recordTaskHeartbeat(
    taskId: string,
    options: { at?: Date; source?: TaskHeartbeatSource } = {},
  ): TaskState | undefined {
    const task = this.stateGetTask(taskId);
    if (!task) return undefined;

    const at = options.at ?? new Date();
    const source = options.source ?? 'executor';
    const changes: TaskStateChanges = {
      execution: {
        lastHeartbeatAt: at,
        heartbeatSource: source,
        ...(source === 'remote_workload' ? { remoteHeartbeatAt: at } : {}),
      },
    };
    const updated = this.writeAndSync(task.id, changes, { skipWorkflowStatusSync: true });
    this.messageBus.publish(TASK_DELTA_CHANNEL, this.buildUpdateDelta(task, updated, changes));
    return updated;
  }

  getAllTasks(): TaskState[] {
    return this.stateMachine.getAllTasks();
  }

  getLastInvalidationPlan(): InvalidationPlan | undefined {
    return this.lastInvalidationPlan;
  }

  getReadyTasks(): TaskState[] {
    return this.stateMachine.getReadyTasks();
  }

  getExecutableReadyTasks(): TaskState[] {
    const readyTasks = this.stateMachine
      .getReadyTasks()
      .filter((task) => this.getExternalDependencyBlocker(task) === undefined);
    const readyTasksById = new Map(readyTasks.map((task) => [task.id, task]));
    return getPendingLaunchQueueSnapshotImpl(
      this as unknown as SchedulerDomainHost,
      readyTasks.map((task) => ({
        taskId: task.id,
        attemptId: task.execution.selectedAttemptId,
        priority: this.loadAttemptById(task.execution.selectedAttemptId)?.queuePriority ?? 0,
      })),
    )
      .map((job) => readyTasksById.get(job.taskId))
      .filter((task): task is TaskState => task !== undefined);
  }

  /**
   * Find the terminal merge node for a given workflow.
   */
  getMergeNode(workflowId: string): TaskState | undefined {
    return getMergeNodeImpl(this as unknown as MergeHost, workflowId);
  }

  getWorkflowStatus(workflowId?: string): {
    total: number;
    completed: number;
    failed: number;
    closed: number;
    running: number;
    pending: number;
  } {
    this.refreshFromDb();
    let tasks = this.stateMachine.getAllTasks();
    if (workflowId) {
      tasks = tasks.filter((t) => t.config.workflowId === workflowId);
    }
    return {
      total: tasks.length,
      completed: tasks.filter((t) => t.status === 'completed').length,
      failed: tasks.filter((t) => t.status === 'failed').length,
      closed: tasks.filter((t) => t.status === 'closed').length,
      running: tasks.filter((t) => t.status === 'running' || t.status === 'fixing_with_ai').length,
      pending: tasks.filter((t) => t.status === 'pending').length,
    };
  }

  getWorkflowIds(): string[] {
    return Array.from(this.activeWorkflowIds);
  }

  /**
   * Cancel a task and cascade-cancel all downstream DAG dependents.
   * Returns cancelled task IDs and which were running (need process kill by caller).
   */
  cancelTask(taskId: string): { cancelled: string[]; runningCancelled: string[] } {
    return cancelTaskImpl(this as unknown as CancellationHost, taskId);
  }

  /**
   * Cancel all active tasks in a workflow.
   * Terminal tasks (completed/stale) are preserved as-is.
   */
  cancelWorkflow(workflowId: string): { cancelled: string[]; runningCancelled: string[] } {
    return cancelWorkflowImpl(this as unknown as CancellationHost, workflowId);
  }

  /**
   * Defer a running task back to pending when a resource limit is hit.
   * The task is re-enqueued when another task completes and frees a slot.
   */
  deferTask(
    taskId: string,
    reason?: {
      reason?: string;
      message?: string;
      attemptId?: string;
      phase?: string;
    },
  ): void {
    deferTaskImpl(this as unknown as CancellationHost, taskId, reason);
    if (reason?.reason === 'resource-limit') {
      this.recordLaunchDeferral(taskId);
    }
  }

  /**
   * Record (or extend) the launch backoff for a task deferred because its
   * execution pool had no member capacity. Attempts drive an exponential
   * schedule so a persistently starved task backs off toward the cap.
   */
  private recordLaunchDeferral(taskId: string): void {
    const attempts = (this.launchDeferrals.get(taskId)?.attempts ?? 0) + 1;
    const backoff = this.computeLaunchBackoffMs(attempts);
    // lastHeartbeatAt=0 forces a heartbeat on the first parked poll.
    this.launchDeferrals.set(taskId, { until: Date.now() + backoff, attempts, lastHeartbeatAt: 0 });
  }

  private computeLaunchBackoffMs(attempts: number): number {
    if (this.launchDeferralBackoffMs !== undefined) {
      return Math.max(0, this.launchDeferralBackoffMs);
    }
    const scaled = Orchestrator.LAUNCH_DEFERRAL_BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1);
    return Math.min(scaled, Orchestrator.LAUNCH_DEFERRAL_MAX_BACKOFF_MS);
  }

  /**
   * True when the task is parked for capacity and its backoff has not elapsed.
   * Gated on `deferredTaskIds` so any lifecycle transition that clears the
   * deferred set (retry / cancel / recreate / completion re-enqueue) releases
   * the park immediately, without a per-transition clear at every call site.
   */
  isLaunchParked(taskId: string, now: number = Date.now()): boolean {
    const deferral = this.launchDeferrals.get(taskId);
    return deferral !== undefined
      && this.deferredTaskIds.has(taskId)
      && deferral.until > now;
  }

  private pruneLaunchDeferrals(): void {
    if (this.launchDeferrals.size === 0) return;
    for (const taskId of [...this.launchDeferrals.keys()]) {
      if (!this.deferredTaskIds.has(taskId)) {
        this.launchDeferrals.delete(taskId);
      }
    }
  }

  /**
   * Emit a throttled `task.launch_waiting` heartbeat proving a parked task is
   * still alive and in line (replacing the abandon/re-dispatch churn as the
   * observable signal), carrying the retry attempt count and next retry time.
   */
  private emitLaunchWaitingHeartbeat(taskId: string, now: number): void {
    const deferral = this.launchDeferrals.get(taskId);
    if (!deferral) return;
    if (now - deferral.lastHeartbeatAt < Orchestrator.LAUNCH_DEFERRAL_HEARTBEAT_MS) return;
    deferral.lastHeartbeatAt = now;
    this.persistence.logEvent?.(taskId, 'task.launch_waiting', {
      attempts: deferral.attempts,
      nextRetryAt: new Date(deferral.until),
    });
  }

  getQueueStatus(options?: { refresh?: boolean }): {
    maxConcurrency: number;
    runningCount: number;
    activeExecutionCount: number;
    launchingCount: number;
    running: Array<{ taskId: string; attemptId?: string; description: string }>;
    queued: Array<{ taskId: string; priority: number; description: string }>;
  } {
    const refresh = options?.refresh !== false;
    const uiPoll = !refresh;
    if (uiPoll && this.queueStatusUiCache) {
      const age = Date.now() - this.queueStatusUiCache.at;
      if (age >= 0 && age < Orchestrator.QUEUE_STATUS_UI_CACHE_MS) {
        return this.queueStatusUiCache.value;
      }
    }
    if (refresh) {
      this.refreshFromDb();
    }
    // UI polls must stay cheap on the Electron main thread: no per-attempt
    // SQLite reads, no launch-order topo sort. Full path keeps exact semantics.
    const attemptCache = new Map<string, Attempt | undefined>();
    const loadAttemptCached = (attemptId: string | undefined): Attempt | undefined => {
      if (!attemptId) return undefined;
      if (attemptCache.has(attemptId)) return attemptCache.get(attemptId);
      const attempt = this.loadAttemptById(attemptId);
      attemptCache.set(attemptId, attempt);
      return attempt;
    };
    const summarizeDescription = (description: string): string => {
      if (!uiPoll || description.length <= 160) return description;
      return `${description.slice(0, 157)}...`;
    };
    const taskLivenessActive = (task: TaskState, nowMs: number): boolean => {
      if (isCrashPreservedExecution(task.execution)) return false;
      const raw = task.execution.lastHeartbeatAt
        ?? task.execution.startedAt
        ?? task.execution.launchStartedAt;
      if (!raw) return true;
      const ts = raw instanceof Date
        ? raw.getTime()
        : typeof raw === 'string'
          ? Date.parse(raw)
          : Number.NaN;
      if (!Number.isFinite(ts)) return true;
      return ts + ATTEMPT_LEASE_MS >= nowMs;
    };
    const tasks = this.stateMachine.getAllTasks();
    const now = Date.now();
    const activeAttempts = uiPoll
      ? tasks
        .filter((task) => {
          if (task.status === 'running' || task.status === 'fixing_with_ai') {
            return taskLivenessActive(task, now);
          }
          if (
            (task.status === 'pending' || (task.status as string) === 'queued')
            && task.execution.phase === 'launching'
            && !!task.execution.selectedAttemptId
          ) {
            return taskLivenessActive(task, now);
          }
          return false;
        })
        .map((task) => ({
          task,
          attemptId: task.execution.selectedAttemptId,
          attempt: undefined as Attempt | undefined,
        }))
      : tasks
        .filter((task) =>
          task.status === 'running'
          || task.status === 'fixing_with_ai'
          || ((task.status === 'pending' || (task.status as string) === 'queued') && !!task.execution.selectedAttemptId),
        )
        .map((task) => {
          const attemptId = task.execution.selectedAttemptId;
          const attempt = loadAttemptCached(attemptId);
          return { task, attemptId, attempt };
        })
        .filter(({ task, attempt }) => this.isTaskExecutionActive(task, attempt, now));
    const activeTaskIds = new Set(activeAttempts.map(({ task }) => task.id));
    const workflowBlockerCache = new Map<string, string | undefined>();
    const isExternallyBlocked = (task: TaskState): boolean => {
      const workflowId = task.config.workflowId;
      if (!workflowId) return false;
      if (!workflowBlockerCache.has(workflowId)) {
        workflowBlockerCache.set(workflowId, this.getWorkflowDependencyBlocker(workflowId));
      }
      return workflowBlockerCache.get(workflowId) !== undefined;
    };
    const readyCandidates = this.stateMachine
      .getReadyTasks()
      .filter((task) => task.status === 'pending' || (task.status as string) === 'queued')
      .filter((task) => !activeTaskIds.has(task.id))
      .filter((task) => !isExternallyBlocked(task));
    let queuedTasks: Array<{ taskId: string; priority: number; description: string }>;
    if (uiPoll) {
      queuedTasks = readyCandidates
        .map((task) => ({
          taskId: task.id,
          priority: 0,
          description: summarizeDescription(task.description),
        }))
        .sort((left, right) => left.taskId.localeCompare(right.taskId));
    } else {
      const queuedJobs = getPendingLaunchQueueSnapshotImpl(
        this as unknown as SchedulerDomainHost,
        readyCandidates.map((task) => ({
          taskId: task.id,
          attemptId: task.execution.selectedAttemptId,
          priority: loadAttemptCached(task.execution.selectedAttemptId)?.queuePriority ?? 0,
        })),
      );
      queuedTasks = queuedJobs
        .map((job) => {
          const task = this.stateGetTask(job.taskId);
          if (!task || (task.status !== 'pending' && (task.status as string) !== 'queued')) return undefined;
          if (activeTaskIds.has(task.id) || isExternallyBlocked(task)) return undefined;
          return {
            taskId: task.id,
            priority: job.priority,
            description: task.description,
          };
        })
        .filter((task): task is { taskId: string; priority: number; description: string } => task !== undefined);
    }
    const activeExecutionCount = activeAttempts.filter(({ task }) =>
      task.status === 'running' || task.status === 'fixing_with_ai',
    ).length;
    const value = {
      maxConcurrency: this.maxConcurrency,
      runningCount: activeAttempts.length,
      activeExecutionCount,
      launchingCount: activeAttempts.length - activeExecutionCount,
      running: activeAttempts.map(({ task, attemptId }) => ({
        taskId: task.id,
        attemptId,
        description: summarizeDescription(task.description),
      })),
      queued: queuedTasks.map((task) => ({
        taskId: task.taskId,
        priority: task.priority,
        description: summarizeDescription(task.description),
      })),
    };
    if (uiPoll) {
      this.queueStatusUiCache = { at: Date.now(), value };
    } else {
      this.queueStatusUiCache = null;
    }
    return value;
  }

  // ── Private: Response Handling ─────────────────────────────

  private handleCompleted(
    taskId: string,
    parsed: Extract<ParsedResponse, { type: 'completed' }>,
  ): TaskState[] {
    return handleCompletedImpl(this as unknown as TransitionHost, taskId, parsed);
  }

  /**
   * Marks a task as failed, writes to DB atomically (task + attempt), logs event,
   * publishes delta, checks for newly ready tasks, and returns newly started tasks.
   */
  private finalizeFailedTask(
    taskId: string,
    executionFields: {
      exitCode?: number;
      error?: string;
      agentName?: string;
      lastAgentName?: string;
      protocolErrorCode?: string;
      protocolErrorMessage?: string;
      mergeConflict?: { failedBranch: string; conflictFiles: string[] };
    },
    eventName: string,
  ): TaskState[] {
    return finalizeFailedTaskImpl(this as unknown as TransitionHost, taskId, executionFields, eventName);
  }

  private handleReviewReady(
    taskId: string,
    parsed: Extract<ParsedResponse, { type: 'review_ready' }>,
  ): TaskState[] {
    return handleReviewReadyImpl(this as unknown as TransitionHost, taskId, parsed);
  }

  private handleFailed(
    taskId: string,
    parsed: Extract<ParsedResponse, { type: 'failed' }>,
  ): TaskState[] {
    return handleFailedImpl(this as unknown as TransitionHost, taskId, parsed);
  }

  private handleNeedsInput(
    taskId: string,
    parsed: Extract<ParsedResponse, { type: 'needs_input' }>,
  ): TaskState[] {
    return handleNeedsInputImpl(this as unknown as TransitionHost, taskId, parsed);
  }

  private handleSpawnExperiments(
    taskId: string,
    parsed: Extract<ParsedResponse, { type: 'spawn_experiments' }>,
  ): TaskState[] {
    return handleSpawnExperimentsImpl(this as unknown as TransitionHost, taskId, parsed);
  }

  private handleSelectExperiment(
    taskId: string,
    parsed: Extract<ParsedResponse, { type: 'select_experiment' }>,
  ): TaskState[] {
    return handleSelectExperimentImpl(this as unknown as TransitionHost, taskId, parsed);
  }

  // ── Private: Graph Mutation Primitive ─────────────────────

  /**
   * Shared primitive for structural graph mutations (experiments, replacement).
   *
   * Order matters:
   *   1. Fork downstream FIRST (before creating new nodes, so new nodes
   *      aren't included in the descendant set)
   *   2. Apply source disposition (complete or stale)
   *   3. Create all new nodes
   */
  private applyGraphMutation(mutation: GraphMutation): TaskDelta[] {
    return applyGraphMutationImpl(this as unknown as GraphMutationHost, mutation);
  }

  // ── Private: Helpers ──────────────────────────────────────

  private checkExperimentCompletion(taskId: string): void {
    checkExperimentCompletionImpl(this as unknown as TransitionHost, taskId);
  }

  private checkWorkflowCompletion(): void {
    checkWorkflowCompletionImpl(this as unknown as TransitionHost);
  }

  private autoStartReadyTasks(taskIds: string[], priority: number = 0, opts?: LaunchReadinessOptions): TaskState[] {
    return autoStartReadyTasksImpl(this as unknown as SchedulerDomainHost, taskIds, priority, opts);
  }

  private enqueueIfNotScheduled(taskId: string, priority: number = 0, opts?: LaunchReadinessOptions): void {
    enqueueIfNotScheduledImpl(this as unknown as SchedulerDomainHost, taskId, priority, opts);
  }

  /**
   * Step 15 (`docs/architecture/task-invalidation-roadmap.md`,
   * chart row "Change external gate policy"): public scheduler
   * entrypoint that re-evaluates every task whose external
   * dependency blocker has cleared and enqueues any newly-runnable
   * tasks. Called internally by `setTaskExternalGatePolicies`
   * AFTER the gate-policy field is persisted; also wired to the
   * `'scheduleOnly'` action's `scheduleOnly` dep on
   * `InvalidationDeps` (`buildInvalidationDeps` in
   * `packages/app/src/workflow-actions.ts`) so future callers that
   * route a gate-policy edit through `applyInvalidation` get the
   * same chart-mandated unblock-pass without cancelling any
   * in-flight work.
   *
   * Also rehydrates already-blocked tasks whose external gate has
   * since cleared; review-ready merge runners use this path after
   * moving an upstream gate out of `running`.
   */
  autoStartExternallyUnblockedReadyTasks(): TaskState[] {
    return autoStartExternallyUnblockedReadyTasksImpl(this as unknown as SchedulerDomainHost);
  }

  private autoStartUnblockedTasks(): TaskState[] {
    return autoStartUnblockedTasksImpl(this as unknown as SchedulerDomainHost);
  }

  getTaskLaunchReadiness(taskId: string, opts?: LaunchReadinessOptions): TaskLaunchReadiness {
    return getTaskLaunchReadinessImpl(this as unknown as SchedulerDomainHost, taskId, opts);
  }

  private areLocalDependenciesSatisfied(task: TaskState): boolean {
    return areLocalDependenciesSatisfiedImpl(this as unknown as SchedulerDomainHost, task);
  }

  private getLocalDependencyBlocker(task: TaskState): string | undefined {
    return getLocalDependencyBlockerImpl(this as unknown as SchedulerDomainHost, task);
  }

  private externalDependencyDisplayId(workflowId: string, taskId?: string): string {
    const normalizedTaskId = taskId?.trim() || '__merge__';
    if (normalizedTaskId.includes('/')) return normalizedTaskId;
    if (normalizedTaskId === '__merge__') return `__merge__${workflowId}`;
    return `${workflowId}/${normalizedTaskId}`;
  }

  private defaultExternalGatePolicy(taskId?: string): 'completed' | 'review_ready' {
    const normalizedTaskId = taskId?.trim() || '__merge__';
    return normalizedTaskId === '__merge__' ? 'completed' : 'review_ready';
  }

  private normalizePlanExternalDependencies(
    deps: Array<{
      workflowId: string;
      taskId?: string;
      requiredStatus?: 'completed';
      gatePolicy?: 'completed' | 'review_ready';
    }>,
  ): ExternalDependency[] {
    const byKey = new Map<string, ExternalDependency>();
    for (const dep of deps) {
      const workflowId = dep.workflowId?.trim();
      if (!workflowId) continue;
      const taskId = dep.taskId?.trim() || '__merge__';
      const key = `${workflowId}::${taskId}`;
      const existing = byKey.get(key);
      const gatePolicy =
        existing?.gatePolicy === 'completed' || dep.gatePolicy === 'completed'
          ? 'completed'
          : dep.gatePolicy ?? this.defaultExternalGatePolicy(taskId);
      byKey.set(key, {
        workflowId,
        taskId,
        requiredStatus: dep.requiredStatus ?? 'completed',
        gatePolicy,
      });
    }
    return Array.from(byKey.values());
  }

  private findExternalDependencyTask(workflowId: string, taskId?: string): TaskState | undefined {
    const normalizedTaskId = taskId?.trim() || '__merge__';
    if (normalizedTaskId === '__merge__') {
      return this.getMergeNode(workflowId)
        ?? this.persistence.loadTasks(workflowId).find((t) => t.config.isMergeNode);
    }
    const tasks = this.persistence.loadTasks(workflowId);
    if (normalizedTaskId.includes('/')) {
      return tasks.find((t) => t.id === normalizedTaskId);
    }
    const scopedId = scopePlanTaskId(workflowId, normalizedTaskId);
    return tasks.find((t) => t.id === scopedId || t.id === normalizedTaskId);
  }

  private getWorkflowExternalDependencies(workflowId: string): ExternalDependency[] {
    const workflow = this.persistence.loadWorkflow?.(workflowId)
      ?? this.persistence.listWorkflows().find((candidate) => candidate.id === workflowId);
    return workflow?.externalDependencies ?? [];
  }

  private getWorkflowDependencyBlocker(workflowId: string): string | undefined {
    const deps = this.getWorkflowExternalDependencies(workflowId);
    if (!deps || deps.length === 0) return undefined;

    for (const dep of deps) {
      const prerequisite = this.findExternalDependencyTask(dep.workflowId, dep.taskId);
      const depDisplayId = this.externalDependencyDisplayId(dep.workflowId, dep.taskId);
      if (!prerequisite) {
        return `missing prerequisite ${depDisplayId}`;
      }
      const required = dep.requiredStatus ?? 'completed';
      const gatePolicy = dep.gatePolicy ?? this.defaultExternalGatePolicy(dep.taskId);
      const isMergeGateDep = (dep.taskId?.trim() || '__merge__') === '__merge__';
      const satisfied =
        prerequisite.status === required
        || (
          gatePolicy === 'review_ready'
          && isMergeGateDep
          && required === 'completed'
          && (prerequisite.status === 'review_ready' || prerequisite.status === 'awaiting_approval')
        );
      if (!satisfied) {
        return `waiting on ${depDisplayId} (${prerequisite.status})`;
      }
    }
    return undefined;
  }

  private getExternalDependencyBlocker(task: TaskState): string | undefined {
    const workflowId = task.config.workflowId;
    if (!workflowId) return undefined;
    return this.getWorkflowDependencyBlocker(workflowId);
  }

  private collectWorkflowDependencyEdges(): Map<string, Set<string>> {
    const edges = new Map<string, Set<string>>();
    for (const workflow of this.persistence.listWorkflows()) {
      for (const dep of workflow.externalDependencies ?? []) {
        let dependents = edges.get(dep.workflowId);
        if (!dependents) {
          dependents = new Set<string>();
          edges.set(dep.workflowId, dependents);
        }
        dependents.add(workflow.id);
      }
    }
    return edges;
  }

  private collectDirectDependentWorkflowIds(workflowId: string): string[] {
    return Array.from(this.collectWorkflowDependencyEdges().get(workflowId) ?? []);
  }

  private collectDownstreamWorkflowIds(rootWorkflowId: string): string[] {
    const edges = this.collectWorkflowDependencyEdges();
    const seen = new Set<string>();
    const queue = [rootWorkflowId];
    const descendants: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const dependentWorkflowId of edges.get(current) ?? []) {
        if (dependentWorkflowId === rootWorkflowId || seen.has(dependentWorkflowId)) continue;
        seen.add(dependentWorkflowId);
        descendants.push(dependentWorkflowId);
        queue.push(dependentWorkflowId);
      }
    }
    return descendants;
  }

  /**
   * Cascade an upstream invalidation to every transitive downstream
   * workflow. For each downstream workflow:
   *   1. Cancel any in-flight task (`cancelActiveBeforeInvalidation`).
   *   2. Reset every task in the workflow to `pending` (with bumped
   *      execution generation to supersede prior attempts) using the
   *      same shape as `detachWorkflowInternal`'s reset payload.
   *
   * The downstream's existing external-dependency gate
   * (`getExternalDependencyBlocker`) re-evaluates at scheduling time
   * and holds the now-pending tasks until the upstream re-completes,
   * so this method does not start anything itself.
   *
   * Wired by `applyInvalidation` (via the `cascadeDownstream` dep on
   * `InvalidationDeps`) so every invalidating action — `recreateTask`,
   * `retryTask`, `recreateWorkflow`, `retryWorkflow`,
   * `recreateWorkflowFromFreshBase`, `workflowFork` — propagates.
   * Non-invalidating actions (`scheduleOnly`, `fixApprove`,
   * `fixReject`, `none`) skip the cascade per `MUTATION_POLICIES`.
   */
  cascadeInvalidationToDownstream(workflowId: string): TaskState[] {
    this.refreshFromDb();
    const downstreamWorkflowIds = this.collectDownstreamWorkflowIds(workflowId);
    if (downstreamWorkflowIds.length === 0) return [];

    this.logger.info('[orchestrator] cascadeInvalidationToDownstream', {
      upstreamWorkflowId: workflowId,
      downstreamCount: downstreamWorkflowIds.length,
      downstreamWorkflowIds,
    });

    for (const dwfId of downstreamWorkflowIds) {
      this.cancelActiveBeforeInvalidation('workflow', dwfId);
    }

    const affectedTaskIds = downstreamWorkflowIds.flatMap((dwfId) =>
      this.stateMachine
        .getAllTasks()
        .filter((task) => task.config.workflowId === dwfId)
        .map((task) => task.id),
    );
    if (affectedTaskIds.length === 0) return [];

    const forceResetIds = new Set(affectedTaskIds);
    const { affectedIds } = this.resetSubgraphToPending(
      affectedTaskIds,
      'detach',
      Orchestrator.DETACH_RESET_CHANGES,
      { forceResetIds },
    );

    for (const taskId of affectedIds) {
      this.persistence.logEvent?.(taskId, 'task.invalidated_by_upstream', {
        upstreamWorkflowId: workflowId,
        downstreamWorkflowIds,
      });
    }

    return affectedIds
      .map((id) => this.stateGetTask(id))
      .filter((t): t is TaskState => !!t);
  }


  private detachWorkflowInternal(
    workflowId: string,
    upstreamWorkflowId: string,
    baseBranchAfterDetach?: string,
  ): void {
    if (workflowId === upstreamWorkflowId) {
      throw new Error(`Cannot detach workflow ${workflowId} from itself`);
    }

    const targetTasks = this.stateMachine.getAllTasks().filter(
      (task) => task.config.workflowId === workflowId,
    );
    if (targetTasks.length === 0) {
      throw new OrchestratorError(OrchestratorErrorCode.WORKFLOW_NOT_FOUND, `Workflow ${workflowId} not found`);
    }

    const targetWorkflow = this.persistence.loadWorkflow?.(workflowId)
      ?? this.persistence.listWorkflows().find((candidate) => candidate.id === workflowId);
    const deps = targetWorkflow?.externalDependencies ?? [];
    const removedDeps = deps.filter((dep) => dep.workflowId === upstreamWorkflowId);
    const nextDeps = deps.filter((dep) => dep.workflowId !== upstreamWorkflowId);
    const removedDependency = removedDeps.length > 0;

    if (!removedDependency) {
      throw new Error(
        `Workflow ${workflowId} does not depend on upstream workflow ${upstreamWorkflowId}`,
      );
    }

    const now = workflowTimestamp().toISOString();
    const existingChanges = targetWorkflow?.externalDependencyChanges ?? [];
    const dependencyChanges: ExternalDependencyChange[] = [...existingChanges];
    for (const dep of removedDeps) {
      const taskId = dep.taskId?.trim() || '__merge__';
      dependencyChanges.push({
        before: { ...dep, taskId },
        changedAt: now,
      });
    }

    // Preserve read-only provenance for the dependencies this detach removes.
    // Active `externalDependencies` are dropped above so scheduling no longer
    // waits on the upstream, but the lineage is recorded here so the UI can
    // distinguish a detached edge from a genuinely-independent workflow.
    // Dedup by upstream identity (workflowId + taskId + requiredStatus +
    // gatePolicy) so repeated detach attempts or sync/reload cycles never
    // append the same provenance entry twice.
    const existingProvenance = targetWorkflow?.detachedExternalDependencies ?? [];
    const provenanceKey = (dep: { workflowId: string; taskId?: string; requiredStatus: 'completed'; gatePolicy?: 'completed' | 'review_ready' }) =>
      `${dep.workflowId}/${dep.taskId?.trim() ?? ''}/${dep.requiredStatus}/${dep.gatePolicy ?? ''}`;
    const seenProvenance = new Set(existingProvenance.map(provenanceKey));
    const detachedProvenance: DetachedExternalDependency[] = [...existingProvenance];
    for (const dep of removedDeps) {
      const key = provenanceKey(dep);
      if (seenProvenance.has(key)) continue;
      seenProvenance.add(key);
      const entry: DetachedExternalDependency = {
        workflowId: dep.workflowId,
        ...(dep.taskId?.trim() ? { taskId: dep.taskId.trim() } : {}),
        requiredStatus: dep.requiredStatus,
        ...(dep.gatePolicy ? { gatePolicy: dep.gatePolicy } : {}),
        detachedAt: now,
      };
      detachedProvenance.push(entry);
    }

    const nextBaseBranch = baseBranchAfterDetach
      ?? this.resolveDetachDefaultBranch(workflowId, targetWorkflow);

    this.taskRepository.updateWorkflow(workflowId, {
      externalDependencies: nextDeps.length > 0 ? nextDeps : undefined,
      externalDependencyChanges: dependencyChanges,
      detachedExternalDependencies: detachedProvenance.length > 0 ? detachedProvenance : undefined,
      baseBranch: nextBaseBranch,
    });

    const eventTask = this.getMergeNode(workflowId) ?? targetTasks[0];
    this.persistence.logEvent?.(eventTask.id, 'workflow.external_dependency_changed', {
      workflowId,
      upstreamWorkflowId,
      action: 'removed',
      changes: dependencyChanges.slice(existingChanges.length),
    });
    this.persistence.logEvent?.(eventTask.id, 'task.external_dependency_changed', {
      workflowId,
      upstreamWorkflowId,
      action: 'removed',
    });

    const affectedWorkflowIds = [workflowId, ...this.collectDownstreamWorkflowIds(workflowId)];
    for (const affectedWorkflowId of affectedWorkflowIds) {
      this.cancelActiveBeforeInvalidation('workflow', affectedWorkflowId);
    }

    const affectedTaskIds = affectedWorkflowIds.flatMap((affectedWorkflowId) =>
      this.stateMachine
        .getAllTasks()
        .filter((task) => task.config.workflowId === affectedWorkflowId)
        .map((task) => task.id),
    );
    const forceResetIds = new Set(affectedTaskIds);
    const { affectedIds } = this.resetSubgraphToPending(
      affectedTaskIds,
      'detach',
      Orchestrator.DETACH_RESET_CHANGES,
      { forceResetIds },
    );

    for (const taskId of affectedIds) {
      this.persistence.logEvent?.(taskId, 'task.workflow_detached', {
        workflowId,
        upstreamWorkflowId,
        affectedWorkflowIds,
      });
    }
  }

  /** Drain the scheduler queue, starting tasks that fit the concurrency limit. */
  private drainScheduler(): TaskState[] {
    return drainSchedulerImpl(this as unknown as SchedulerDomainHost);
  }

  /**
   * Mark task launch as fully executing after executor.start() succeeds.
   *
   * Returns false when the attempt is stale or no longer executable; caller
   * should abort the launched process in that case.
   */
  markTaskRunningAfterLaunch(taskId: string, attemptId: string, launchedAt: Date = new Date()): boolean {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) {
      this.logger.info('[orchestrator] markTaskRunningAfterLaunch: reject', {
        taskId,
        attemptId,
        reason: 'not_found',
      });
      this.clearQueuedSchedulerEntries(taskId, attemptId);
      return false;
    }

    const selectedAttemptId = task.execution.selectedAttemptId;
    if (selectedAttemptId !== attemptId) {
      this.logger.info('[orchestrator] markTaskRunningAfterLaunch: reject', {
        taskId,
        attemptId,
        reason: 'attempt_mismatch',
        selectedAttemptId,
      });
      this.clearQueuedSchedulerEntries(taskId, attemptId);
      return false;
    }

    const existingAttempt = this.loadAttemptById(attemptId);
    if (!existingAttempt || isDiscardedAttempt(existingAttempt)) {
      this.logger.info('[orchestrator] markTaskRunningAfterLaunch: reject', {
        taskId,
        attemptId,
        reason: !existingAttempt ? 'attempt_missing' : 'attempt_superseded',
      });
      this.clearQueuedSchedulerEntries(taskId, attemptId);
      return false;
    }

    if (task.status !== 'running' && task.status !== 'pending' && (task.status as string) !== 'queued' && task.status !== 'fixing_with_ai') {
      this.logger.info('[orchestrator] markTaskRunningAfterLaunch: reject', {
        taskId,
        attemptId,
        reason: 'invalid_status',
        status: task.status,
      });
      this.clearQueuedSchedulerEntries(taskId, attemptId);
      return false;
    }

    if (task.status !== 'fixing_with_ai') {
      const baseExecution: TaskStateChanges['execution'] = {
        selectedAttemptId: attemptId,
        lastHeartbeatAt: launchedAt,
        phase: 'executing',
        launchStartedAt: task.execution.launchStartedAt ?? task.execution.startedAt ?? launchedAt,
        launchCompletedAt: launchedAt,
      };
      const changes: TaskStateChanges = (task.status === 'pending' || (task.status as string) === 'queued')
        ? {
            status: 'running',
            execution: {
              ...baseExecution,
              startedAt: launchedAt,
              generation: this.getExecutionGeneration(task),
            },
          }
        : { execution: baseExecution };

      const launchUpdated = this.writeAndSync(taskId, changes);
      this.persistence.logEvent?.(taskId, 'task.running', changes);
      this.messageBus.publish(TASK_DELTA_CHANNEL, this.buildUpdateDelta(task, launchUpdated, changes));
      this.logger.info('[orchestrator] markTaskRunningAfterLaunch: executing', {
        taskId,
        attemptId,
        previousStatus: task.status,
      });
    }

    try {
      this.taskRepository.updateAttempt(attemptId, {
        status: 'running',
        claimedAt: existingAttempt.claimedAt ?? launchedAt,
        startedAt: launchedAt,
        lastHeartbeatAt: launchedAt,
        leaseExpiresAt: nextLeaseExpiry(launchedAt),
      });
    } catch {
      // best effort — do not fail launch-state transition due to attempt sync
    }

    this.logger.info('[orchestrator] markTaskRunningAfterLaunch: ok', {
      taskId,
      attemptId,
    });
    return true;
  }
}
