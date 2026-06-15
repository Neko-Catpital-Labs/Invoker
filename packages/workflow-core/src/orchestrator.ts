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
import type { TaskState, TaskDelta, TaskStateChanges, TaskConfig, Attempt, ExternalDependency, ExternalDependencyChange, TaskStatus, TaskHeartbeatSource } from '@invoker/workflow-graph';
import type { RunnerKind } from '@invoker/workflow-graph';
import { createTaskState, createAttempt } from '@invoker/workflow-graph';
import type { WorkflowDerivedStatus } from '@invoker/workflow-graph';
import type { Logger, WorkResponse } from '@invoker/contracts';
import { ATTEMPT_LEASE_MS } from '@invoker/contracts';
import { normalizeRunnerKind } from '@invoker/workflow-graph';
import { parseMergeConflictError } from './merge-conflict-error.js';
import {
  buildExecutorRoutedPayload,
  buildHeavyweightRoutingRules,
  resolveExecutorRouting,
  type ExecutorRoutingReason,
  type ExecutorRoutingRule,
  type HeavyweightCommandRoutingPolicy,
} from './executor-routing.js';

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
import { buildPlanLocalToScopedIdMap, scopePlanTaskId } from './task-id-scope.js';
import type { TaskRepository } from './task-repository.js';
import {
  planInvalidation,
  withSchedulerEnqueueCandidates,
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
  if (process.env.NODE_ENV === 'test') return `wf-test-${workflowCounter}`;
  return `wf-${Date.now()}-${workflowCounter}`;
}

function workflowTimestamp(): Date {
  if (process.env.NODE_ENV === 'test' && process.env.INVOKER_TEST_FIXED_NOW) {
    return new Date(process.env.INVOKER_TEST_FIXED_NOW);
  }
  return new Date();
}
/** Recreate-class reset: fresh lineage, cleared attempt/session/container metadata. */
const RECREATE_RESET_CHANGES: TaskStateChanges = {
  status: 'pending',
  config: { summary: undefined },
  execution: {
    autoFixAttempts: 0,
    startedAt: undefined,
    completedAt: undefined,
    error: undefined,
    exitCode: undefined,
    commit: undefined,
    branch: undefined,
    workspacePath: undefined,
    lastHeartbeatAt: undefined,
    phase: undefined,
    launchStartedAt: undefined,
    launchCompletedAt: undefined,
    reviewUrl: undefined,
    reviewId: undefined,
    reviewStatus: undefined,
    reviewProviderId: undefined,
    agentSessionId: undefined,
    containerId: undefined,
  },
};

const FIX_FAILURE_PREFIX_RE = /^\[Fix with (?:Claude|Agent) failed\] [^\n]*\n\n/;
const TRACE_PERSIST_SYNC = process.env.INVOKER_TRACE_PERSIST_SYNC === '1';
const TRACE_WORKER_RESPONSE = process.env.INVOKER_TRACE_WORKER_RESPONSE === '1';
const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() { return noopLogger; },
};

function stripFixFailureWrapper(errorText: string): string {
  return errorText.replace(FIX_FAILURE_PREFIX_RE, '');
}

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
type LaunchReadinessOptions = { bypassLocalDependencyReadiness?: boolean };

export interface OrchestratorPersistence {
  saveWorkflow(workflow: {
    id: string;
    name: string;
    description?: string;
    visualProof?: boolean;
    status: WorkflowDerivedStatus;
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
  }): void;
  updateWorkflow?(workflowId: string, changes: { updatedAt?: string; baseBranch?: string; generation?: number; mergeMode?: 'manual' | 'automatic' | 'external_review'; externalDependencies?: ExternalDependency[]; externalDependencyChanges?: ExternalDependencyChange[] }): void;
  saveTask(workflowId: string, task: TaskState): void;
  updateTask(taskId: string, changes: TaskStateChanges): void;
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
  listWorkflows(): Array<{
    id: string;
    name: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    baseBranch?: string;
    onFinish?: string;
    mergeMode?: 'manual' | 'automatic' | 'external_review';
    externalDependencies?: ExternalDependency[];
    externalDependencyChanges?: ExternalDependencyChange[];
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
      baseBranch?: string;
      onFinish?: string;
      mergeMode?: 'manual' | 'automatic' | 'external_review';
      externalDependencies?: ExternalDependency[];
      externalDependencyChanges?: ExternalDependencyChange[];
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
  } | undefined;
  /** Delete a single workflow and its tasks from the DB. */
  deleteWorkflow?(workflowId: string): void;
  /** Delete all workflows and tasks from the DB. */
  deleteAllWorkflows?(): void;
  /**
   * Optional launch-handoff outbox sink. When provided AND
   * `OrchestratorConfig.launchOutboxMode` is `'observe'` or `'active'`,
   * `drainScheduler` writes a `task_launch_dispatch` row alongside the
   * legacy claim path. The orchestrator does not take a hard dependency
   * on this method; it is observer-only in Phase A. See
   * `docs/incidents/2026-05-22-launch-handoff-architecture-proposal.md`.
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
  /** Default auto-fix retry budget for older tasks missing persisted per-task config. */
  defaultAutoFixRetries?: number;
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
  /**
   * Launch-handoff outbox mode. When set to `'observe'` or `'active'` (and
   * the persistence layer implements `enqueueLaunchDispatch`),
   * `drainScheduler` writes a durable `task_launch_dispatch` row alongside
   * the existing claim path and emits a `task.dispatch_enqueued` event.
   *
   * Default `'disabled'` preserves existing behaviour. See
   * `docs/incidents/2026-05-22-launch-handoff-architecture-proposal.md`.
   */
  launchOutboxMode?: 'disabled' | 'observe' | 'active';
}

// ── Orchestrator ────────────────────────────────────────────

export interface TaskLineageExpectation {
  taskId?: string;
  selectedAttemptId?: string;
  generation?: number;
}

export class Orchestrator {
  private static readonly EXPEDITED_PRIORITY = 100;

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
  private readonly defaultAutoFixRetries: number;
  private readonly deferRunningUntilLaunch: boolean;
  private readonly launchOutboxMode: 'disabled' | 'observe' | 'active';

  private activeWorkflowIds = new Set<string>();
  private deferredTaskIds = new Set<string>();
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

  private static readonly DETACH_RESET_CHANGES: TaskStateChanges = {
    status: 'pending',
    config: { summary: undefined },
    execution: {
      autoFixAttempts: 0,
      blockedBy: undefined,
      startedAt: undefined,
      completedAt: undefined,
      error: undefined,
      exitCode: undefined,
      commit: undefined,
      branch: undefined,
      workspacePath: undefined,
      pendingFixError: undefined,
      inputPrompt: undefined,
      lastHeartbeatAt: undefined,
      phase: undefined,
      launchStartedAt: undefined,
      launchCompletedAt: undefined,
      isFixingWithAI: false,
      reviewUrl: undefined,
      reviewId: undefined,
      reviewStatus: undefined,
      reviewProviderId: undefined,
      fixedIntegrationSha: undefined,
      fixedIntegrationRecordedAt: undefined,
      fixedIntegrationSource: undefined,
      agentSessionId: undefined,
      containerId: undefined,
    },
  };

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
    this.defaultAutoFixRetries = Math.min(Math.max(0, Math.floor(config.defaultAutoFixRetries ?? 0)), 10);
    this.deferRunningUntilLaunch = config.deferRunningUntilLaunch ?? false;
    this.launchOutboxMode = config.launchOutboxMode ?? 'disabled';

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

  /**
   * Build an 'updated' TaskDelta with task-state continuity metadata.
   * `before` is the task state before the mutation, `after` is the state
   * returned by writeAndSync.
   */
  private buildUpdateDelta(before: TaskState, after: TaskState, changes: TaskStateChanges): TaskDelta {
    return {
      type: 'updated',
      taskId: after.id,
      changes,
      taskStateVersion: after.taskStateVersion,
      previousTaskStateVersion: before.taskStateVersion,
    };
  }

  /**
   * Build a 'removed' TaskDelta with the task's last known task-state version.
   */
  private buildRemoveDelta(task: TaskState): TaskDelta {
    return {
      type: 'removed',
      taskId: task.id,
      previousTaskStateVersion: task.taskStateVersion,
    };
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
    const allTasks = this.stateMachine.getAllTasks();
    const taskMap = new Map(allTasks.map((t) => [t.id, t]));
    const seen = new Set<string>();
    const ids: string[] = [];

    for (const rootId of rootTaskIds) {
      if (!taskMap.has(rootId)) continue;
      if (!seen.has(rootId)) {
        seen.add(rootId);
        ids.push(rootId);
      }
      const descendantIds = getTransitiveDependents(rootId, taskMap, () => false);
      for (const id of descendantIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
      }
    }

    return ids;
  }

  private invalidateLaunchArtifactsForTasks(
    taskIds: readonly string[],
    reason: string,
    now: Date = new Date(),
  ): void {
    const ids = Array.from(new Set(taskIds.filter((id) => typeof id === 'string' && id.length > 0)));
    if (ids.length === 0) return;

    const invalidatedAt = now.toISOString();
    const invalidatedDispatches =
      this.persistence.abandonLaunchDispatchesForTasks?.(ids, reason, invalidatedAt) ?? [];
    const releasedLeases =
      this.persistence.releaseExecutionResourceLeasesForTasks?.(ids, reason, invalidatedAt) ?? [];

    for (const row of invalidatedDispatches) {
      this.persistence.logEvent?.(row.taskId, 'task.launch_dispatch_invalidated', {
        dispatchId: row.id,
        attemptId: row.attemptId,
        workflowId: row.workflowId,
        previousState: row.state,
        generation: row.generation,
        reason,
        invalidatedAt,
      });
    }

    for (const row of releasedLeases) {
      if (!row.taskId) continue;
      this.persistence.logEvent?.(row.taskId, 'task.execution_resource_lease_released', {
        resourceKey: row.resourceKey,
        resourceType: row.resourceType,
        holderId: row.holderId,
        reason,
        invalidatedAt,
      });
    }
  }

  /**
   * Reset root tasks and all downstream dependents to pending using the
   * provided reset payload. Returns the affected IDs and currently-ready IDs.
   */
  private resetSubgraphToPending(
    rootTaskIds: string[],
    resetChanges: TaskStateChanges,
    opts?: { forceResetIds?: Set<string> },
  ): { affectedIds: string[]; readyIds: string[] } {
    const forceResetIds = opts?.forceResetIds ?? new Set<string>();
    const affectedIds = this.collectSubgraphTaskIds(rootTaskIds);
    const affectedSet = new Set(affectedIds);
    const workflowsToSync = new Set<string>();
    const pendingTaskDeltas: TaskDelta[] = [];

    this.taskRepository.runInTransaction(() => {
      this.invalidateLaunchArtifactsForTasks(affectedIds, 'task subgraph reset to pending');

      for (const id of affectedIds) {
        const current = this.stateGetTask(id);
        if (!current) continue;
        if (current.config.workflowId) {
          workflowsToSync.add(current.config.workflowId);
        }

        const selectedAttempt = this.getSelectedAttempt(current);
        const shouldReset =
          forceResetIds.has(id)
          || current.status !== 'pending'
          || this.isAttemptLeaseActive(selectedAttempt);
        this.deferredTaskIds.delete(id);
        if (!shouldReset) {
          this.clearQueuedSchedulerEntries(id, current.execution.selectedAttemptId);
          continue;
        }

        const changesWithGeneration = this.withBumpedExecutionGeneration(current, resetChanges);
        const updated = this.writeAndSync(id, changesWithGeneration, { skipWorkflowStatusSync: true });
        const priorAttemptId = current.execution.selectedAttemptId;
        this.replaceSelectedAttempt(current, {}, { skipWorkflowStatusSync: true });
        this.persistence.logEvent?.(id, 'task.pending', changesWithGeneration);
        pendingTaskDeltas.push(this.buildUpdateDelta(current, updated, changesWithGeneration));

        this.clearQueuedSchedulerEntries(id, priorAttemptId);
      }

      for (const workflowId of workflowsToSync) {
        this.touchWorkflow(workflowId);
      }
    });

    for (const delta of pendingTaskDeltas) {
      this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
    }

    const readyIds = this.stateMachine
      .getReadyTasks()
      .map((t) => t.id)
      .filter((id) => affectedSet.has(id));
    return { affectedIds, readyIds };
  }

  /**
   * Cancel-first invariant defense-in-depth (Step 18 of
   * `docs/architecture/task-invalidation-roadmap.md`, Hard Invariant
   * from `docs/architecture/task-invalidation-chart.md`).
   *
   * Marks any actively-running task in the targeted scope as `failed`
   * with an explicit cancel marker BEFORE the caller resets state.
   * This guarantees the chart's "interrupt and cancel all in-flight
   * work in the affected scope" rule for direct callers of the
   * orchestrator primitives — notably the `commandService.retryTask`
   * / `recreateTask` / `retryWorkflow` / `recreateWorkflow` /
   * `recreateWorkflowFromFreshBase` lifecycle commands wired in
   * Step 17, which bypass the upstream `applyInvalidation` cancel.
   *
   * Calls via `applyInvalidation` already cancel via `cancelInFlight`
   * (executor kill + orchestrator-side `cancelTask`/`cancelWorkflow`),
   * so this helper is a defense-in-depth no-op there: by the time the
   * primitive runs the targeted scope has no active tasks and the
   * `isActive` filter below skips them all.
   *
   * Implementation notes:
   *   - Only `running` / `fixing_with_ai` tasks are touched. Pending /
   *     blocked / failed / completed / etc. tasks are left alone so
   *     the subsequent reset path (`resetSubgraphToPending` /
   *     `recreateWorkflow` / `replaceSelectedAttempt`) sees the
   *     expected lineage.
   *   - The selected attempt's status is intentionally NOT mutated
   *     here — the subsequent reset's `replaceSelectedAttempt` sees
   *     it as still `running` and marks it `superseded`, preserving
   *     the existing attempt-supersession contract that retry/recreate
   *     primitives (and their tests) rely on.
   *   - Deferred-set / queued scheduler entries are cleared per
   *     cancelled task so the slot frees up for the upcoming reset.
   */
  private cancelActiveBeforeInvalidation(
    scope: 'task' | 'workflow',
    id: string,
  ): string[] {
    let candidates: TaskState[];
    if (scope === 'task') {
      const root = this.stateGetTask(id);
      if (!root) return [];
      const allTasks = this.stateMachine.getAllTasks();
      const taskMap = new Map(allTasks.map((t) => [t.id, t]));
      const descendantIds = getTransitiveDependents(
        id,
        taskMap,
        (t) => t.status === 'completed' || t.status === 'stale',
      );
      candidates = [
        root,
        ...descendantIds
          .map((d) => taskMap.get(d))
          .filter((t): t is TaskState => !!t),
      ];
    } else {
      candidates = this.stateMachine
        .getAllTasks()
        .filter((t) => t.config.workflowId === id);
    }

    return this.cancelActiveCandidates(candidates, scope);
  }

  /** Mark every actively-running task in `candidates` as `failed` with a cancel marker, freeing its scheduler slot. */
  private cancelActiveCandidates(
    candidates: readonly TaskState[],
    scope: 'task' | 'workflow',
  ): string[] {
    const cancelled: string[] = [];
    for (const t of candidates) {
      if (!isActiveForInvalidation(t.status)) continue;
      const error = `Cancelled before ${scope}-scope invalidation`;
      const completedAt = new Date();
      const changes: TaskStateChanges = {
        status: 'failed',
        execution: { error, completedAt },
      };
      const updated = this.writeAndSync(t.id, changes);
      this.persistence.logEvent?.(t.id, 'task.cancelled', changes);
      this.messageBus.publish(TASK_DELTA_CHANNEL, this.buildUpdateDelta(t, updated, changes));
      this.deferredTaskIds.delete(t.id);
      this.clearQueuedSchedulerEntries(t.id, t.execution.selectedAttemptId);
      cancelled.push(t.id);
    }
    return cancelled;
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

  private isAttemptLeaseActive(attempt: Attempt | undefined, now: number = Date.now()): boolean {
    if (!attempt) return false;
    if (isDiscardedAttempt(attempt)) return false;
    if (attempt.status !== 'claimed' && attempt.status !== 'running') return false;
    if (!attempt.leaseExpiresAt) return true;
    return attempt.leaseExpiresAt.getTime() >= now;
  }

  private isTaskExecutionActive(
    task: TaskState,
    attempt: Attempt | undefined,
    now: number = Date.now(),
  ): boolean {
    if (attempt && this.isAttemptLeaseActive(attempt, now)) {
      return task.status === 'pending' || task.status === 'running' || task.status === 'fixing_with_ai';
    }

    return task.status === 'running' || task.status === 'fixing_with_ai';
  }

  private isExecutableResponseTask(task: TaskState): boolean {
    return task.status === 'running'
      || task.status === 'fixing_with_ai'
      || (
        task.status === 'pending'
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

    const changes = this.withBumpedExecutionGeneration(task, {
      status: 'pending',
      execution: {
        selectedAttemptId: freshAttempt.id,
        phase: undefined,
        startedAt: undefined,
        completedAt: undefined,
        launchStartedAt: undefined,
        launchCompletedAt: undefined,
        lastHeartbeatAt: undefined,
        error: undefined,
        exitCode: undefined,
        branch: undefined,
        commit: undefined,
        inputPrompt: undefined,
        pendingFixError: undefined,
        agentSessionId: undefined,
        workspacePath: undefined,
        containerId: undefined,
        isFixingWithAI: false,
      },
    });

    let updated!: TaskState;
    this.taskRepository.runInTransaction(() => {
      if (activeAttempt) {
        this.taskRepository.updateAttempt(activeAttempt.id, { status: 'superseded' });
      }
      this.taskRepository.saveAttempt(freshAttempt);
      updated = this.writeAndSync(task.id, changes);
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
      status: 'pending',
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

    const activeAttempts = this.countActivePersistedAttempts();
    const readyTasks = this.stateMachine
      .getReadyTasks()
      .filter((task) => this.getExternalDependencyBlocker(task) === undefined);
    this.logger.info('[orchestrator] startExecution', {
      ready: readyTasks.length,
      active: activeAttempts,
      maxConcurrency: this.maxConcurrency,
      readyIds: readyTasks.map((task) => task.id),
    });
    const started: TaskState[] = [];

    for (const task of readyTasks) {
      this.enqueueIfNotScheduled(task.id);
    }

    return this.drainScheduler();
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
          !response.attemptId &&
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

  private setTaskApprovalStatus(
    taskId: string,
    status: 'awaiting_approval' | 'review_ready',
    eventName: 'task.awaiting_approval' | 'task.review_ready',
    additionalChanges?: TaskStateChanges,
  ): void {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) return;
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
  setTaskReviewReady(taskId: string, additionalChanges?: TaskStateChanges): void {
    this.setTaskApprovalStatus(taskId, 'review_ready', 'task.review_ready', additionalChanges);
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

    if (this.beforeApproveHook) {
      mergeTrace('APPROVE_HOOK_FIRING', { taskId, workflowId: task.config.workflowId });
      await this.beforeApproveHook(task);
      mergeTrace('APPROVE_HOOK_DONE', { taskId });
    } else {
      mergeTrace('APPROVE_NO_HOOK', { taskId });
    }

    const changes: TaskStateChanges = {
      status: 'completed',
      execution: { completedAt: new Date() },
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
      execution: { pendingFixError: undefined, startedAt: now, lastHeartbeatAt: now },
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
      execution: { error: reason ?? 'Rejected', completedAt: new Date() },
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
    this.logger.warn(
      '[orchestrator] restartTask is deprecated. Routing to recreateTask. Use retryTask() for lineage-preserving reset or recreateTask() for fresh-lineage reset explicitly.',
      { taskId },
    );
    return this.recreateTask(taskId);
  }

  retryTask(taskId: string): TaskState[] {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);
    const id = task.id;

    // Step 18 (`docs/architecture/task-invalidation-roadmap.md`,
    // Hard Invariant): cancel any active attempt on this task or its
    // downstream subgraph BEFORE the reset writes pending state.
    // Defense-in-depth for direct callers (CommandService.retryTask
    // wired in Step 17) that bypass `applyInvalidation`'s upstream
    // cancel; a no-op when invoked through `applyInvalidation`.
    this.cancelActiveBeforeInvalidation('task', id);
    let plan = planInvalidation({
      action: 'retryTask',
      targetId: id,
      tasks: this.stateMachine.getAllTasks(),
    });
    this.lastInvalidationPlan = plan;

    const prevStatus = task.status;
    this.logger.info('[orchestrator] retryTask', { taskId: id, previousStatus: prevStatus });
    if (task.config.isMergeNode) {
      this.logger.info('[merge-gate-workspace] retryTask before reset', {
        mergeNode: id,
        workspacePath: task.execution.workspacePath ?? 'none',
        note: 'retryTask does not clear workspacePath',
      });
      mergeTrace('GATE_WS_RETRY_TASK_MERGE', {
        taskId: id,
        workspacePathBefore: task.execution.workspacePath ?? null,
      });
    }

    const resetChanges: TaskStateChanges = {
      status: 'pending',
      config: { summary: undefined },
      execution: {
        autoFixAttempts: 0,
        startedAt: undefined,
        completedAt: undefined,
        error: undefined,
        exitCode: undefined,
        pendingFixError: undefined,
        commit: undefined,
        lastHeartbeatAt: undefined,
        launchStartedAt: undefined,
        launchCompletedAt: undefined,
        phase: undefined,
        isFixingWithAI: false,
        agentSessionId: undefined,
        containerId: undefined,
      },
    };
    const t0 = this.stateGetTask(id)!;
    this.logger.info('[agent-session-trace] retryTask: before writeAndSync', {
      taskId: id,
      agentSessionId: t0.execution.agentSessionId ?? 'null',
      note: 'reset clears agentSessionId/containerId; branch/workspacePath unchanged',
    });
    const { affectedIds } = this.resetSubgraphToPending([id], resetChanges, {
      forceResetIds: new Set([id]),
    });
    plan = withSchedulerEnqueueCandidates(plan, affectedIds);
    this.lastInvalidationPlan = plan;
    const afterRt = this.stateGetTask(id)!;
    this.logger.info('[agent-session-trace] retryTask: after writeAndSync', {
      taskId: id,
      agentSessionId: afterRt.execution.agentSessionId ?? 'null',
    });
    if (afterRt.config.isMergeNode) {
      this.logger.info('[merge-gate-workspace] retryTask after reset', {
        mergeNode: id,
        workspacePath: afterRt.execution.workspacePath ?? 'none',
      });
      mergeTrace('GATE_WS_RETRY_TASK_MERGE_AFTER', {
        taskId: id,
        workspacePathAfter: afterRt.execution.workspacePath ?? null,
      });
    }
    if (affectedIds.length > 1) {
      this.logger.info('[orchestrator] retryTask invalidated downstream tasks', {
        taskId: id,
        invalidatedCount: affectedIds.length - 1,
      });
    }

    const readyTasks = this.stateMachine.getReadyTasks();
    const isReady = readyTasks.some((t) => t.id === id);
    this.logger.info('[orchestrator] retryTask ready check', { taskId: id, ready: isReady });
    if (isReady) {
      const started = this.autoStartReadyTasks([id], Orchestrator.EXPEDITED_PRIORITY);
      if (started.some((t) => t.id === id)) return started;

      const current = this.stateGetTask(id);
      if (current) {
        const blocker = this.getExternalDependencyBlocker(current);
        if (blocker !== undefined) {
          const blockedChanges: TaskStateChanges = {
            status: 'blocked',
            execution: { blockedBy: blocker },
          };
          const blockedUpdated = this.writeAndSync(id, blockedChanges);
          const blockedDelta: TaskDelta = this.buildUpdateDelta(current, blockedUpdated, blockedChanges);
          this.persistence.logEvent?.(id, 'task.blocked', blockedChanges);
          this.messageBus.publish(TASK_DELTA_CHANNEL, blockedDelta);
          return [this.stateGetTask(id)!];
        }
      }
    }

    return [this.stateGetTask(id)!];
  }

  /**
   * Incremental retry: reset only failed/stuck tasks to pending, preserve completed.
   * Merge nodes are always reset (they depend on all leaf tasks).
   * After reset, startExecution() finds newly-ready tasks via getReadyNodes().
   */
  retryWorkflow(workflowId: string): TaskState[] {
    const retryStartMs = Date.now();
    this.refreshWorkflowFromDb(workflowId);
    const afterRefreshMs = Date.now();

    let allTasks = this.stateMachine.getAllTasks().filter(
      (t) => t.config.workflowId === workflowId,
    );
    if (allTasks.length === 0) throw new Error(`No tasks found for workflow ${workflowId}`);

    // Step 18 cancel-first invariant: interrupt any active task in
    // the workflow scope BEFORE the retry reset. Defense-in-depth
    // for direct callers (CommandService.retryWorkflow wired in
    // Step 17); a no-op when invoked through `applyInvalidation`.
    // Re-snapshot tasks afterwards so the retry filter (which
    // includes 'failed' in `retryStatuses`) re-picks any newly
    // cancelled tasks for reset to pending.
    this.cancelActiveBeforeInvalidation('workflow', workflowId);
    allTasks = this.stateMachine.getAllTasks().filter(
      (t) => t.config.workflowId === workflowId,
    );

    const retryStatuses: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
      'failed',
      'needs_input',
      'blocked',
      'stale',
      'fixing_with_ai',
      'awaiting_approval',
      'review_ready',
    ]);
    let plan = planInvalidation({
      action: 'retryWorkflow',
      targetId: workflowId,
      tasks: this.stateMachine.getAllTasks(),
      retryStatuses,
    });
    this.lastInvalidationPlan = plan;

    const resetChanges: TaskStateChanges = {
      status: 'pending',
      config: { summary: undefined },
      execution: {
        autoFixAttempts: 0,
        startedAt: undefined,
        completedAt: undefined,
        error: undefined,
        exitCode: undefined,
        pendingFixError: undefined,
        phase: undefined,
        launchStartedAt: undefined,
        launchCompletedAt: undefined,
        isFixingWithAI: false,
        // Preserve branch/commit/workspacePath — they contain valid work context
        // Only clear error-related and timing fields
      },
    };

    const retryRootIds = allTasks
      .filter((task) => retryStatuses.has(task.status))
      .map((task) => task.id);
    const { affectedIds } = this.resetSubgraphToPending(retryRootIds, resetChanges);
    plan = withSchedulerEnqueueCandidates(plan, affectedIds);
    this.lastInvalidationPlan = plan;
    const afterResetMs = Date.now();

    this.logger.info('[orchestrator] retryWorkflow invalidation', {
      workflowId,
      roots: retryRootIds,
      affected: affectedIds.length,
    });
    this.logger.info('[orchestrator] retryWorkflow reset summary', {
      workflowId,
      resetCount: affectedIds.length,
      totalTasks: allTasks.length,
      rootCount: retryRootIds.length,
      note: 'preserved completed outside invalidated subgraphs',
    });

    const readyIds = this.stateMachine
      .getReadyTasks()
      .map((t) => t.id)
      .filter((id) => {
        const task = this.stateGetTask(id);
        return !!task
          && task.config.workflowId === workflowId;
      });
    const started = this.autoStartReadyTasks(readyIds, Orchestrator.EXPEDITED_PRIORITY);
    const retryEndMs = Date.now();
    this.logger.info('[orchestrator] retryWorkflow timing', {
      workflowId,
      refreshMs: afterRefreshMs - retryStartMs,
      resetMs: afterResetMs - afterRefreshMs,
      enqueueDrainMs: retryEndMs - afterResetMs,
      totalMs: retryEndMs - retryStartMs,
      started: started.length,
    });
    return started;
  }

  /**
   * Task-scoped recreate: reset the target task and all downstream dependents
   * to pending with recreate-style execution clearing, then auto-start newly
   * ready tasks within that affected subgraph.
   */
  recreateTask(taskId: string): TaskState[] {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);

    const rootId = task.id;

    // Step 18 cancel-first invariant: interrupt active attempts on
    // this task / downstream subgraph BEFORE the recreate reset.
    // Defense-in-depth for direct callers (CommandService.recreateTask
    // wired in Step 17); a no-op when invoked through `applyInvalidation`.
    this.cancelActiveBeforeInvalidation('task', rootId);
    const plan = planInvalidation({
      action: 'recreateTask',
      targetId: rootId,
      tasks: this.stateMachine.getAllTasks(),
    });
    this.lastInvalidationPlan = plan;
    this.logger.info('[orchestrator] recreateTask reset', {
      taskId: rootId,
      resetCount: plan.affectedTaskIds.length,
    });
    return this.applyRecreateReset(plan, 'task recreation reset');
  }

  /**
   * Shared tail of the recreate-class mutations: apply `RECREATE_RESET_CHANGES`
   * to every task in `plan.affectedTaskIds`, then auto-start the ones that
   * become ready.
   */
  private applyRecreateReset(plan: InvalidationPlan, artifactReason: string): TaskState[] {
    const toResetIds = plan.affectedTaskIds;
    const toResetSet = new Set(toResetIds);
    this.invalidateLaunchArtifactsForTasks(toResetIds, artifactReason);

    for (const id of toResetIds) {
      const current = this.stateGetTask(id);
      if (!current) continue;
      const changesWithGeneration = this.withBumpedExecutionGeneration(current, RECREATE_RESET_CHANGES);
      const recreateUpdated = this.writeAndSync(id, changesWithGeneration);
      const priorAttemptId = current.execution.selectedAttemptId;
      this.replaceSelectedAttempt(current);
      this.persistence.logEvent?.(id, 'task.pending', changesWithGeneration);
      this.messageBus.publish(TASK_DELTA_CHANNEL, this.buildUpdateDelta(current, recreateUpdated, changesWithGeneration));

      this.deferredTaskIds.delete(id);
      this.clearQueuedSchedulerEntries(id, priorAttemptId);
    }

    const readyIds = this.stateMachine
      .getReadyTasks()
      .map((t) => t.id)
      .filter((id) => toResetSet.has(id));
    this.lastInvalidationPlan = withSchedulerEnqueueCandidates(plan, readyIds);
    return this.autoStartReadyTasks(readyIds, Orchestrator.EXPEDITED_PRIORITY);
  }

  /**
   * Reset a task's transitive downstream dependents to pending (recreate-style)
   * and auto-start the ones that become ready, leaving the task itself untouched.
   * Calling it on a leaf is a no-op.
   */
  recreateDownstream(taskId: string): TaskState[] {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);

    const rootId = task.id;

    const plan = planInvalidation({
      action: 'recreateDownstream',
      targetId: rootId,
      tasks: this.stateMachine.getAllTasks(),
    });
    this.lastInvalidationPlan = plan;
    const toResetIds = plan.affectedTaskIds;

    if (toResetIds.length === 0) {
      this.logger.info('[orchestrator] recreateDownstream no-op (leaf)', { taskId: rootId });
      return [];
    }

    // Cancel only descendants so the preserved target's active attempt is never interrupted.
    const descendants = toResetIds
      .map((id) => this.stateGetTask(id))
      .filter((t): t is TaskState => !!t);
    this.cancelActiveCandidates(descendants, 'task');

    this.logger.info('[orchestrator] recreateDownstream reset', {
      taskId: rootId,
      resetCount: toResetIds.length,
    });
    return this.applyRecreateReset(plan, 'downstream recreation reset');
  }

  /**
   * Reset ALL tasks in a workflow to pending and auto-start ready ones.
   * Used when a rebase conflicts and the entire DAG needs to re-execute.
   */
  recreateWorkflow(workflowId: string): TaskState[] {
    this.refreshFromDb();

    const allTasks = this.stateMachine.getAllTasks().filter(
      (t) => t.config.workflowId === workflowId,
    );
    if (allTasks.length === 0) throw new Error(`No tasks found for workflow ${workflowId}`);

    // Step 18 cancel-first invariant: interrupt any active task in
    // the workflow scope BEFORE the recreate reset. Defense-in-depth
    // for direct callers (CommandService.recreateWorkflow and
    // recreateWorkflowFromFreshBase wired in Step 17); a no-op when
    // invoked through `applyInvalidation`.
    this.cancelActiveBeforeInvalidation('workflow', workflowId);
    let plan = planInvalidation({
      action: 'recreateWorkflow',
      targetId: workflowId,
      tasks: this.stateMachine.getAllTasks(),
    });
    this.lastInvalidationPlan = plan;

    const resetChanges: TaskStateChanges = {
      ...RECREATE_RESET_CHANGES,
      config: { summary: undefined, poolMemberId: undefined },
    };

    this.logger.info('[orchestrator] recreateWorkflow reset', {
      workflowId,
      resetCount: allTasks.length,
    });
    this.logger.info(
      '[agent-session-trace] recreateWorkflow: resetChanges.execution clears agentSessionId/containerId (DB NULL before next run)',
    );
    this.invalidateLaunchArtifactsForTasks(
      allTasks.map((task) => task.id),
      'workflow recreation reset',
    );
    for (const task of allTasks) {
      const prevSess = task.execution.agentSessionId ?? null;
      const prevCt = task.execution.containerId ?? null;
      if (task.config.isMergeNode) {
        this.logger.info('[merge-gate-workspace] recreateWorkflow', {
          mergeNode: task.id,
          workspacePath: task.execution.workspacePath ?? 'NULL',
          note: 'will clear workspace_path',
        });
        mergeTrace('GATE_WS_RESTART_WORKFLOW_MERGE', {
          taskId: task.id,
          workspacePathBefore: task.execution.workspacePath ?? null,
        });
      }
      this.logger.info('[orchestrator] recreateWorkflow task reset', {
        taskId: task.id,
        previousStatus: task.status,
        branch: task.execution.branch ?? 'none',
        commit: task.execution.commit?.slice(0, 7) ?? 'none',
      });
      this.logger.info('[agent-session-trace] recreateWorkflow: before writeAndSync', {
        taskId: task.id,
        agentSessionId: prevSess ?? 'null',
        containerId: prevCt ?? 'null',
      });
      const changesWithGeneration = this.withBumpedExecutionGeneration(task, resetChanges);
      const after = this.writeAndSync(task.id, changesWithGeneration);
      const priorAttemptId = task.execution.selectedAttemptId;
      this.replaceSelectedAttempt(task);
    this.logger.info('[agent-session-trace] recreateWorkflow: after writeAndSync', {
      taskId: task.id,
      agentSessionId: after.execution.agentSessionId ?? 'null',
      containerId: after.execution.containerId ?? 'null',
    });
      const delta: TaskDelta = this.buildUpdateDelta(task, after, changesWithGeneration);
      this.persistence.logEvent?.(task.id, 'task.pending', changesWithGeneration);
      this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
      this.clearQueuedSchedulerEntries(task.id, priorAttemptId);
    }

    const readyIds = this.stateMachine
      .getReadyTasks()
      .map((t) => t.id)
      .filter((id) => this.stateGetTask(id)?.config.workflowId === workflowId);
    plan = withSchedulerEnqueueCandidates(plan, readyIds);
    this.lastInvalidationPlan = plan;
    return this.autoStartReadyTasks(readyIds, Orchestrator.EXPEDITED_PRIORITY);
  }

  /**
   * Workflow-scope **fresh-base** recreate (Step 12 of
   * `docs/architecture/task-invalidation-roadmap.md`, Decision Table
   * row "Rebase and retry" + "Repo/base invalidation inconsistency"
   * in `docs/architecture/task-invalidation-chart.md`).
   *
   * This is strictly stronger than `recreateWorkflow`:
   *
   *   recreateWorkflow                 — full reset; preserves the
   *                                      workflow's currently-known
   *                                      upstream base.
   *   recreateWorkflowFromFreshBase    — full reset PLUS refreshes
   *                                      the upstream base (HEAD of
   *                                      `baseBranch`) before reset.
   *
   * The chart's "Repo/base invalidation inconsistency" section called
   * this distinction out as previously hidden: today the only
   * primitive carrying the fresh-base semantic is the composite
   * `rebaseAndRetry()` flow in `packages/app/src/workflow-actions.ts`
   * (`preparePoolForRebaseRetry → bumpGenerationAndRecreate →
   * recreateWorkflow`). Step 12 promotes the fresh-base step to a
   * first-class orchestrator method so the three workflow-scope
   * paths (`retryWorkflow`, `recreateWorkflow`,
   * `recreateWorkflowFromFreshBase`) are individually testable and
   * routed through `applyInvalidation` from
   * `packages/workflow-core/src/invalidation-policy.ts`.
   *
   * The orchestrator deliberately does NOT touch git itself: the
   * `refreshBase` callback (wired by the app layer to
   * `taskExecutor.preparePoolForRebaseRetry`) is what actually
   * refreshes the pool mirror and removes managed branches. The
   * orchestrator only:
   *
   *   1. awaits the optional `refreshBase` callback, and
   *   2. records any returned `commit` in `knownFreshBaseCommits` and
   *      any returned `branch` in persistence (`baseBranch`) so the
   *      effect of the refresh is observable from orchestrator state.
   *   3. delegates the actual reset to `recreateWorkflow` so all
   *      lineage-discard behavior (workspace path, branch, commit,
   *      agent session, container, merge gate workspace, etc.) stays
   *      single-sourced.
   *
   * Cancel-first invariant (`docs/architecture/task-invalidation-chart.md`
   * → "Hard Invariant"): the chart requires every retry/recreate
   * route to interrupt and cancel any in-flight work in the affected
   * scope BEFORE authoritative reset. Two layers cooperate:
   *
   *   1. `applyInvalidation`'s `cancelInFlight` dep (built by
   *      `buildCancelInFlight` in
   *      `packages/app/src/workflow-actions.ts`) calls
   *      `Orchestrator.cancelWorkflow` and awaits
   *      `taskExecutor.killActiveExecution` for each running attempt.
   *   2. `recreateWorkflow` (delegated to below) additionally invokes
   *      `cancelActiveBeforeInvalidation('workflow', …)` so direct
   *      callers (`CommandService.recreateWorkflowFromFreshBase`
   *      wired in Step 17) that bypass `applyInvalidation` still
   *      observe the invariant. The helper is idempotent — already
   *      cancelled tasks are skipped, so layer (2) is a no-op when
   *      layer (1) ran first. See Step 18 of
   *      `docs/architecture/task-invalidation-roadmap.md`.
   */
  async recreateWorkflowFromFreshBase(
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
          this.knownFreshBaseCommits.set(workflowId, fresh.commit);
          this.logger.info('[orchestrator] recreateWorkflowFromFreshBase fresh base commit', {
            workflowId,
            freshBaseCommit: fresh.commit.slice(0, 12),
          });
        }
        if (typeof fresh.branch === 'string' && fresh.branch.length > 0 && this.persistence.updateWorkflow) {
          this.persistence.updateWorkflow(workflowId, { baseBranch: fresh.branch });
          this.logger.info('[orchestrator] recreateWorkflowFromFreshBase fresh base branch', {
            workflowId,
            freshBaseBranch: fresh.branch,
          });
        }
      }
    }
    return this.recreateWorkflow(workflowId);
  }

  /**
   * Most recently observed upstream base commit for `workflowId`,
   * recorded by `recreateWorkflowFromFreshBase` when its `refreshBase`
   * callback returns a SHA. Returns `undefined` when no fresh-base
   * recreate has run for the workflow yet.
   *
   * This is the orchestrator-side observable for the chart's
   * `recreateWorkflowFromFreshBase` semantic — see the comment on
   * `knownFreshBaseCommits` for why this lives on the orchestrator
   * rather than the executor pool. Tests assert on this getter to
   * prove the fresh-base step actually advanced.
   */
  getKnownFreshBaseCommit(workflowId: string): string | undefined {
    return this.knownFreshBaseCommits.get(workflowId);
  }

  /**
   * Transition a failed task to fixing_with_ai before an async conflict resolution.
   * Clears terminal failure fields on the row so SQLite does not show stale error/exit/completed.
   * Returns the saved error string so the caller can revert on failure.
   */
  beginConflictResolution(taskId: string, expectedLineage?: TaskLineageExpectation): { savedError: string } {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);
    if (!this.taskMatchesLineageExpectation(task, expectedLineage)) {
      this.logger.info('[beginConflictResolution] discarded stale start', {
        taskId,
        selectedAttemptId: task.execution.selectedAttemptId,
        generation: task.execution.generation ?? 0,
        expectedLineage,
      });
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
    const changesWithGeneration = this.withBumpedExecutionGeneration(task, changes);
    const conflictUpdated = this.writeAndSync(taskId, changesWithGeneration);
    const attemptId = this.replaceSelectedAttempt(task);
    this.taskRepository.updateAttempt(attemptId, {
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
    const delta: TaskDelta = this.buildUpdateDelta(task, conflictUpdated, changesWithGeneration);
    this.persistence.logEvent?.(id, 'task.fixing_with_ai', changesWithGeneration);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);

    return { savedError };
  }

  /**
   * Begin an AI fix session from either a failed task or an external review
   * gate state. Review-gate CI failures use this path because the merge task
   * may still be review_ready/awaiting_approval while the PR checks are red.
   */
  beginAutoFixSession(
    taskId: string,
    opts: { savedError?: string; expectedLineage?: TaskLineageExpectation } = {},
  ): { savedError: string } {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);
    if (!this.taskMatchesLineageExpectation(task, opts.expectedLineage)) {
      this.logger.info('[beginAutoFixSession] discarded stale start', {
        taskId,
        selectedAttemptId: task.execution.selectedAttemptId,
        generation: task.execution.generation ?? 0,
        expectedLineage: opts.expectedLineage,
      });
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
    const changesWithGeneration = this.withBumpedExecutionGeneration(task, changes);
    const updated = this.writeAndSync(id, changesWithGeneration);
    const attemptId = this.replaceSelectedAttempt(task);
    this.taskRepository.updateAttempt(attemptId, {
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
    const delta: TaskDelta = this.buildUpdateDelta(task, updated, changesWithGeneration);
    this.persistence.logEvent?.(id, 'task.fixing_with_ai', changesWithGeneration);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
    return { savedError };
  }

  /**
   * Revert a conflict resolution attempt: restore the task to failed
   * with its original error and re-parsed mergeConflict field.
   */
  revertConflictResolution(
    taskId: string,
    savedError: string,
    fixError?: string,
    expectedLineage?: TaskLineageExpectation,
  ): void {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) {
      throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);
    }
    if (!this.taskMatchesLineageExpectation(task, expectedLineage)) return;
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
    const revertUpdated = this.writeAndSync(taskId, changes);
    this.updateSelectedAttempt(taskId, {
      status: 'failed',
      error: displayError,
      mergeConflict,
      completedAt,
    });
    const delta: TaskDelta = this.buildUpdateDelta(task, revertUpdated, changes);
    this.persistence.logEvent?.(id, 'task.failed', changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
  }

  /**
   * Sync dispatch for an edit primitive's post-cancel reset stage.
   *
   * Each `editTask*` method shares the same shape: validate, optional
   * cancel-first when the task is active, persist the new spec, then
   * apply the post-edit invalidation primitive (`recreateTask` or
   * `retryTask`) selected by `MUTATION_POLICIES`. Routing the final
   * dispatch through this helper keeps the action source-of-truth in
   * the policy table rather than hard-coded literals at each site, so
   * a chart change (e.g. flipping `command` from `recreateTask` to
   * `retryTask`) propagates without touching `editTask*` bodies.
   *
   * Sync by design: the public `editTask*` API is sync and most
   * callers (api-server, headless, tests) consume the returned
   * `TaskState[]` synchronously. The async `applyInvalidation`
   * pipeline is reserved for the higher-level CommandService /
   * facade routing where cross-workflow cascade fires.
   */
  private dispatchPostMutation(
    action: InvalidationAction,
    taskId: string,
  ): TaskState[] {
    switch (action) {
      case 'recreateTask':
        return this.recreateTask(taskId);
      case 'retryTask':
        return this.retryTask(taskId);
      default:
        throw new Error(
          `dispatchPostMutation: unsupported action '${action}' for orchestrator edit primitives`,
        );
    }
  }

  editTaskCommand(taskId: string, newCommand: string): TaskState[] {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);
    if (task.config.isMergeNode) throw new Error(`Cannot edit merge node ${taskId}`);

    if (isActiveForInvalidation(task.status)) {
      this.cancelTask(taskId);
    }

    const cmdChanges: TaskStateChanges = { config: { command: newCommand } };
    const cmdBefore = this.stateGetTask(taskId)!;
    const cmdUpdated = this.writeAndSync(taskId, cmdChanges);
    const cmdDelta: TaskDelta = this.buildUpdateDelta(cmdBefore, cmdUpdated, cmdChanges);
    this.persistence.logEvent?.(taskId, 'task.updated', cmdChanges);
    this.messageBus.publish(TASK_DELTA_CHANNEL, cmdDelta);

    return this.dispatchPostMutation(MUTATION_POLICIES.command.action, taskId);
  }

    editTaskPrompt(taskId: string, newPrompt: string): TaskState[] {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);
    if (task.config.isMergeNode) throw new Error(`Cannot edit merge node ${taskId}`);

    if (isActiveForInvalidation(task.status)) {
      this.cancelTask(taskId);
    }

    const promptChanges: TaskStateChanges = { config: { prompt: newPrompt } };
    const promptBefore = this.stateGetTask(taskId)!;
    const promptUpdated = this.writeAndSync(taskId, promptChanges);
    const promptDelta: TaskDelta = this.buildUpdateDelta(promptBefore, promptUpdated, promptChanges);
    this.persistence.logEvent?.(taskId, 'task.updated', promptChanges);
    this.messageBus.publish(TASK_DELTA_CHANNEL, promptDelta);

    return this.dispatchPostMutation(MUTATION_POLICIES.prompt.action, taskId);
  }

    editTaskType(taskId: string, runnerKind: string, poolMemberId?: string): TaskState[] {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);
    if (task.config.isMergeNode) throw new Error(`Cannot change executor type of merge node ${taskId}`);

    const effectiveType = normalizeRunnerKind(runnerKind) ?? runnerKind;

    // SSH requires repoUrl on the workflow to clone onto the remote host
    if (effectiveType === 'ssh' && task.config.workflowId && this.persistence.loadWorkflow) {
      const wf = this.persistence.loadWorkflow(task.config.workflowId);
      if (!wf?.repoUrl) {
        throw new Error(
          `Cannot switch task "${taskId}" to SSH: workflow has no repoUrl. ` +
          `Add repoUrl to the plan YAML.`,
        );
      }
    }

    const oldRunnerKind = task.config.runnerKind;
    const oldPoolMemberId =
      oldRunnerKind === 'ssh' ? (task.config as { poolMemberId?: string }).poolMemberId : undefined;
    const newPoolMemberId = effectiveType === 'ssh' ? poolMemberId : undefined;
    const hostKey = (et: string | undefined, rid: string | undefined): string =>
      et === 'ssh' ? `ssh:${rid ?? ''}` : 'local';
    const hostChanged =
      hostKey(oldRunnerKind, oldPoolMemberId) !==
      hostKey(effectiveType, newPoolMemberId);

    if (isActiveForInvalidation(task.status)) {
      this.cancelTask(taskId);
    }

    const configPatch: Record<string, unknown> = { runnerKind: effectiveType };
    if (effectiveType === 'ssh') {
      configPatch.poolMemberId = poolMemberId;
    } else {
      configPatch.poolMemberId = undefined;
    }
    const typeChanges: TaskStateChanges = { config: configPatch };
    const typeBefore = this.stateGetTask(taskId)!;
    const typeUpdated = this.writeAndSync(taskId, typeChanges);
    const typeDelta: TaskDelta = this.buildUpdateDelta(typeBefore, typeUpdated, typeChanges);
    this.persistence.logEvent?.(taskId, 'task.updated', typeChanges);
    this.messageBus.publish(TASK_DELTA_CHANNEL, typeDelta);

    const typeAction = hostChanged
      ? MUTATION_POLICIES.poolMemberId.action
      : MUTATION_POLICIES.runnerKind.action;
    return this.dispatchPostMutation(typeAction, taskId);
  }

    editTaskPool(taskId: string, poolId: string): TaskState[] {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);
    if (task.config.isMergeNode) throw new Error(`Cannot change executor pool of merge node ${taskId}`);
    if (!poolId || !this.availablePoolIds.has(poolId)) {
      throw new Error(
        `Cannot switch task "${taskId}" to poolId="${poolId}": pool is not defined in executionPools. ` +
        `Available: [${[...this.availablePoolIds].join(', ')}]`,
      );
    }

    if (isActiveForInvalidation(task.status)) {
      this.cancelTask(taskId);
    }

    const poolChanges: TaskStateChanges = {
      config: {
        poolId,
        runnerKind: undefined,
        poolMemberId: undefined,
      } as TaskStateChanges['config'],
    };
    const poolBefore = this.stateGetTask(taskId)!;
    const poolUpdated = this.writeAndSync(taskId, poolChanges);
    const poolDelta: TaskDelta = this.buildUpdateDelta(poolBefore, poolUpdated, poolChanges);
    this.persistence.logEvent?.(taskId, 'task.updated', poolChanges);
    this.messageBus.publish(TASK_DELTA_CHANNEL, poolDelta);

    return this.dispatchPostMutation(MUTATION_POLICIES.poolMemberId.action, taskId);
  }

    editTaskAgent(taskId: string, agentName: string): TaskState[] {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);
    if (task.config.isMergeNode) throw new Error(`Cannot change execution agent of merge node ${taskId}`);

    if (isActiveForInvalidation(task.status)) {
      this.cancelTask(taskId);
    }

    const agentChanges: TaskStateChanges = { config: { executionAgent: agentName } };
    const agentBefore = this.stateGetTask(taskId)!;
    const agentUpdated = this.writeAndSync(taskId, agentChanges);
    const agentDelta: TaskDelta = this.buildUpdateDelta(agentBefore, agentUpdated, agentChanges);
    this.persistence.logEvent?.(taskId, 'task.updated', agentChanges);
    this.messageBus.publish(TASK_DELTA_CHANNEL, agentDelta);

    return this.dispatchPostMutation(MUTATION_POLICIES.executionAgent.action, taskId);
  }

  /**
   * Edit the merge mode of a workflow's merge node — **retry-class**
   * invalidation route per Step 9 of
   * `docs/architecture/task-invalidation-roadmap.md` and the Decision
   * Table row "Change merge mode" in
   * `docs/architecture/task-invalidation-chart.md`
   * (`MUTATION_POLICIES.mergeMode` → `retryTask` / task scope, scoped
   * to the merge node).
   *
   * Why retry-class (not recreate-class). The chart classifies a
   * merge-mode change as a merge-node-only execution-policy change:
   * the merge node's merge strategy (`manual` / `automatic` /
   * `external_review`) flips, but downstream branch/workspace lineage
   * and the upstream leaf results that feed the merge node are still
   * authoritative. The "Why" column reads "Merge execution policy
   * changed". `applyInvalidation('task','retryTask', mergeNodeId, deps)`
   * is wired to today's `Orchestrator.restartTask` via
   * `buildInvalidationDeps` (the compatibility seam Step 1 introduced;
   * Step 13 will rename `restartTask` → `retryTask` to close the matrix).
   *
   * Why this lives on the orchestrator (Step 9 migration). Prior to
   * Step 9 the merge-mode mutation surface was an app-layer-only
   * special case in `setWorkflowMergeMode` that restarted the merge
   * node *only* when it was already terminal or waiting
   * (`completed` / `awaiting_approval` / `review_ready`). Per the
   * chart's "Merge-mode inconsistency" section that left no general
   * active invalidation rule for an in-flight merge node — a `running`
   * merge node would silently keep using the old mode. Step 9 lifts
   * the routing into a proper orchestrator policy seam (this method)
   * so the Hard Invariant (cancel-first) and the retry-class reset
   * are enforced uniformly across all merge-node states; the app
   * wrapper becomes a thin delegate (mirrors Steps 2–6).
   *
   * Sequence (mirrors `applyInvalidation`'s contract for the
   * synchronous orchestrator-internal seam — see
   * `invalidation-policy.ts` and the Step 5/7/8 retry-class precedents):
   *   1. **Same-mode no-op.** If the workflow's persisted `mergeMode`
   *      already matches the requested value the method returns `[]`
   *      without canceling, persisting, or bumping the merge node's
   *      execution generation. This prevents a no-op rewrite from
   *      invalidating valid in-flight merge work.
   *   2. **Cancel-first (Hard Invariant).** If the merge node is
   *      actively executing or waiting on external review
   *      (`running` / `fixing_with_ai` / `awaiting_approval` /
   *      `review_ready`) we interrupt it via `cancelTask` BEFORE any
   *      authoritative state is reset. The chart's "Merge-mode
   *      inconsistency" section explicitly flags external-review
   *      waits and in-flight merge runs as scope that the new model
   *      must invalidate consistently. Inactive states
   *      (`pending` / `completed` / `failed` / `needs_input` /
   *      `blocked`) skip the cancel — there is no in-flight work to
   *      interrupt and `cancelTask` would otherwise mark a `pending`
   *      merge node as `failed`.
   *   3. **Persist new mode.** `persistence.updateWorkflow` writes the
   *      new `mergeMode` so the retried merge attempt picks up the
   *      new policy when it next runs.
   *   4. **Retry-class reset.** Delegate to `restartTask`, which is
   *      the current `retryTask` compatibility wire (Step 13 will
   *      rename it). `restartTask` resets the merge node to `pending`,
   *      clears volatile attempt state (`agentSessionId` /
   *      `containerId` / `error` / `exitCode` / `startedAt` /
   *      `completedAt`), and bumps execution generation exactly once
   *      via `withBumpedExecutionGeneration`. Crucially it does NOT
   *      clear `branch` / `workspacePath` — that lineage (the merge
   *      node's accumulated workspace) is the artifact the chart
   *      preserves for retry-class merge-mode mutations.
   *
   * Public surface: `(taskId, mergeMode)` returning `TaskState[]` of
   * newly-started tasks. `taskId` MUST be the merge node id
   * (`__merge__<workflowId>`); the workflow id is read from
   * `task.config.workflowId`. Throws if the task does not exist or is
   * not a merge node — keeping merge-mode mutation scoped to the
   * single execution policy slot the chart classifies. Backward-
   * compatible callers continue to use the workflow-scoped
   * `setWorkflowMergeMode` wrapper which translates `workflowId →
   * mergeNodeId` and delegates here.
   */
  editTaskMergeMode(
    taskId: string,
    mergeMode: 'manual' | 'automatic' | 'external_review',
  ): TaskState[] {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);
    if (!task.config.isMergeNode) {
      throw new Error(`Task ${taskId} is not a merge node`);
    }
    const workflowId = task.config.workflowId;
    if (!workflowId) {
      throw new Error(`Merge node ${taskId} has no workflowId`);
    }

    // Step 9 same-mode no-op: skip cancel + persist + retry when the
    // requested mode already matches what's persisted on the workflow.
    // Without this guard a UI/CLI re-affirm would needlessly cancel
    // active merge work and bump the merge node's execution generation.
    const wf = this.persistence.loadWorkflow?.(workflowId);
    if (wf && wf.mergeMode === mergeMode) {
      return [];
    }

    // Step 9 cancel-first (chart Hard Invariant): when the merge node
    // is actively executing or waiting on external review, interrupt
    // it BEFORE we mutate the workflow's mergeMode and reset merge
    // state. Stale merge work (an in-flight merge run, a merge fix
    // session, or an external review wait) cannot survive a policy
    // change because the merge attempt's execution input — the merge
    // mode — just changed. Inactive statuses
    // (`pending`/`completed`/`failed`/`needs_input`/`blocked`) skip
    // cancel: there is no in-flight work to interrupt and
    // `cancelTask` would otherwise mark a `pending` merge node as
    // `failed`.
    if (isActiveForInvalidation(task.status)) {
      this.cancelTask(taskId);
    }

    // Persist new mode on the workflow record so the retried merge
    // attempt picks up the new policy when restartTask reschedules it.
    this.persistence.updateWorkflow?.(workflowId, { mergeMode });

    // Retry-class reset via the policy table — `restartTask` is the
    // current `retryTask` compatibility wire. Routing through
    // `MUTATION_POLICIES.mergeMode` keeps merge-mode dispatch
    // table-driven so a chart change propagates without touching this
    // method body.
    return this.dispatchPostMutation(MUTATION_POLICIES.mergeMode.action, taskId);
  }

  /**
   * Edit a task's fix-session prompt and/or context — **retry-class**
   * invalidation route per Step 10 of
   * `docs/architecture/task-invalidation-roadmap.md` and the Decision
   * Table row "Change fix prompt or fix context while `fixing_with_ai`"
   * in `docs/architecture/task-invalidation-chart.md`
   * (`MUTATION_POLICIES.fixContext` → `retryTask` / task scope).
   *
   * Why this is a migration, not a new policy. Prior to Step 10 the
   * fix-session mutation surface had **no general policy** at all —
   * the chart's "Behavior Today" column flags this row as
   * "only command edit has explicit handling today; no general
   * fix-context mutation policy" and the chart's "Fix-session
   * inconsistency" subsection calls out the bespoke
   * `beginConflictResolution` / `revertConflictResolution` rollback
   * as "one special active invalidation mechanism, not a general
   * one". Step 10 lifts that bespoke fix-session handling into a
   * proper orchestrator policy seam (`Orchestrator.editTaskFixContext`)
   * so cancel-first + retry-class reset are enforced uniformly across
   * `failed` and `fixing_with_ai` task states; the app wrapper
   * (`setTaskFixContext`) becomes a thin async delegate (mirrors
   * Steps 2–9).
   *
   * "Retry from reverted failed state" semantics. The chart's
   * `Target Action` column for this row reads
   * `retryTask` from reverted failed state — i.e. when the user
   * changes `fixPrompt`/`fixContext` mid-fix-session the in-flight
   * AI fix attempt is dropped, the task lineage falls back to its
   * `failed` baseline (volatile fix-attempt state — `agentSessionId`,
   * `containerId`, transient `error`/`exitCode`/timing fields —
   * cleared by `restartTask`), and a fresh fix attempt is scheduled
   * with the new prompt/context. Branch / workspacePath lineage
   * survives because this is the same failed task being retried
   * through the fix loop, not a new task topology.
   *
   * Sequence (mirrors `applyInvalidation`'s contract for the
   * synchronous orchestrator-internal seam — see
   * `invalidation-policy.ts` and the Step 9 `editTaskMergeMode`
   * precedent):
   *   1. **Same-content no-op.** If neither `fixPrompt` nor
   *      `fixContext` is changing (omitted keys count as "no
   *      change"), return `[]` without canceling, persisting, or
   *      bumping execution generation. Without this guard a UI/CLI
   *      re-affirm of identical fix context would needlessly cancel
   *      an active fix session and bump the task's execution
   *      generation.
   *   2. **Cancel-first (Hard Invariant).** When the task is
   *      actively running an AI fix (`fixing_with_ai`) interrupt it
   *      via `cancelTask` BEFORE the new fix prompt/context is
   *      persisted or `restartTask` resets the task. A failed task
   *      (the inactive fix-loop state) skips cancel — there is no
   *      in-flight fix attempt to interrupt and `cancelTask` would
   *      otherwise treat the failed task as already settled.
   *   3. **Persist new fix prompt/context.** `writeAndSync` updates
   *      `config.fixPrompt` / `config.fixContext` (only the keys
   *      present in the patch) and emits a `task.updated` delta so
   *      the retried fix attempt picks up the new prompt/context.
   *   4. **Retry-class reset.** Delegate to `restartTask` (today's
   *      `retryTask` compatibility wire — see
   *      `MUTATION_POLICIES.fixContext` and `buildInvalidationDeps`).
   *      It resets the task to `pending`, clears volatile attempt
   *      state (`agentSessionId`, `containerId`, transient
   *      `error`/`exitCode`/timing fields), and bumps execution
   *      generation exactly once via
   *      `withBumpedExecutionGeneration`, preserving branch /
   *      workspacePath lineage. This is the chart's "retry from
   *      reverted failed state" baseline.
   *
   * Patch shape: `{ fixPrompt?, fixContext? }`. Either or both keys
   * may be present. Omitted keys leave the existing config field
   * untouched — same-content detection treats missing keys as "no
   * change" so a `fix-prompt`-only edit does not clobber an
   * existing `fixContext`.
   *
   * Active states accepted: `failed`, `fixing_with_ai`. Other states
   * throw — the chart scopes this mutation to the fix loop.
   *
   * NOTE: `restartTask` is intentionally used here (not
   * `recreateTask`) because Step 10 is retry-class — fix
   * prompt/context changes do NOT change the task's execution-defining
   * spec (`command` / `prompt` / `executionAgent` / `runnerKind` /
   * `poolMemberId`); they only redirect the AI fix attempt that
   * runs against an already-failed task lineage.
   */
  editTaskFixContext(
    taskId: string,
    patch: { fixPrompt?: string; fixContext?: string },
  ): TaskState[] {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);
    if (task.config.isMergeNode) {
      throw new Error(`Cannot edit fix context of merge node ${taskId}`);
    }
    if (task.status !== 'failed' && task.status !== 'fixing_with_ai') {
      throw new Error(
        `Cannot edit fix context for task "${taskId}" in status "${task.status}" ` +
          `(expected: failed | fixing_with_ai)`,
      );
    }

    // Step 10 same-content no-op: skip cancel + persist + retry when
    // neither key in the patch differs from the persisted config.
    // Omitted keys count as "no change" so a prompt-only edit does
    // not require the caller to also re-supply the existing context.
    const hasPromptKey = Object.prototype.hasOwnProperty.call(patch, 'fixPrompt');
    const hasContextKey = Object.prototype.hasOwnProperty.call(patch, 'fixContext');
    const promptMatches = !hasPromptKey || patch.fixPrompt === task.config.fixPrompt;
    const contextMatches = !hasContextKey || patch.fixContext === task.config.fixContext;
    if (promptMatches && contextMatches) {
      return [];
    }

    // Step 10 cancel-first (chart Hard Invariant): when the task is
    // actively running an AI fix attempt (`fixing_with_ai`) interrupt
    // it BEFORE we persist the new fix prompt/context and reset the
    // task via `restartTask`. The in-flight fix attempt's execution
    // input — the prompt/context — just changed, so it cannot
    // survive. A failed task (the inactive fix-loop state) skips
    // cancel: there is no in-flight fix attempt to interrupt.
    if (task.status === 'fixing_with_ai') {
      this.cancelTask(taskId);
    }

    const configPatch: Record<string, unknown> = {};
    if (hasPromptKey) configPatch.fixPrompt = patch.fixPrompt;
    if (hasContextKey) configPatch.fixContext = patch.fixContext;
    const fixContextChanges: TaskStateChanges = { config: configPatch };
    const fixBefore = this.stateGetTask(taskId)!;
    const fixUpdated = this.writeAndSync(taskId, fixContextChanges);
    const fixContextDelta: TaskDelta = this.buildUpdateDelta(fixBefore, fixUpdated, fixContextChanges);
    this.persistence.logEvent?.(taskId, 'task.updated', fixContextChanges);
    this.messageBus.publish(TASK_DELTA_CHANNEL, fixContextDelta);

    // Retry-class reset via the policy table — `restartTask` is the
    // current `retryTask` compatibility wire. Routing through
    // `MUTATION_POLICIES.fixContext` keeps fix-context dispatch
    // table-driven so a chart change propagates without touching this
    // method body.
    return this.dispatchPostMutation(MUTATION_POLICIES.fixContext.action, taskId);
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
      status: 'running',
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
   * Returns true if the workflow has any non-merge task in a live status
   * (`pending`, `running`, `fixing_with_ai`, `needs_input`,
   * `awaiting_approval`, `review_ready`, `blocked`).
   *
   * The merge node is excluded because it stays `pending` for the whole
   * workflow lifetime — including it would make every workflow live
   * forever. Step 11 uses this check to gate topology-changing graph
   * mutations (`replaceTask`).
   */
  private isWorkflowLive(workflowId: string): boolean {
    const tasks = this.stateMachine
      .getAllTasks()
      .filter((t) => t.config.workflowId === workflowId && !t.config.isMergeNode);
    return tasks.some((t) => LIVE_TASK_STATUSES.has(t.status));
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
    if (task.status !== 'pending' || !task.execution.selectedAttemptId) return false;
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
  deleteWorkflow(workflowId: string): void {
    this.syncAllFromDb();

    const deletedWorkflow = this.persistence.loadWorkflow?.(workflowId);

    // 1. Detach direct dependents before the delete so they inherit the
    // deleted workflow's parent branch instead of becoming permanently blocked
    // on a missing prerequisite.
    const directDependents = this.collectDirectDependentWorkflowIds(workflowId);
    for (const dependentWorkflowId of directDependents) {
      this.detachWorkflowInternal(dependentWorkflowId, workflowId, {
        upstreamWorkflow: deletedWorkflow,
      });
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
    this.detachWorkflowInternal(workflowId, upstreamWorkflowId, {
      upstreamWorkflow: this.persistence.loadWorkflow?.(upstreamWorkflowId),
    });
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

  getAutoFixRetryBudget(taskId: string): number {
    return this.defaultAutoFixRetries;
  }

  private isRuntimeAutoFixEligibleTask(task: TaskState): boolean {
    if (task.config.isReconciliation) return false;
    if (task.config.parentTask) return false;
    return true;
  }

  shouldAutoFix(taskId: string): boolean {
    const task = this.stateGetTask(taskId);
    if (!task) return false;
    if (task.status !== 'failed') return false;
    if (!this.isRuntimeAutoFixEligibleTask(task)) return false;
    const max = this.getAutoFixRetryBudget(taskId);
    if (max <= 0) return false;
    return (task.execution.autoFixAttempts ?? 0) < max;
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

  /**
   * Find the terminal merge node for a given workflow.
   */
  getMergeNode(workflowId: string): TaskState | undefined {
    return this.stateMachine.getAllTasks().find(
      (t) => t.config.workflowId === workflowId && t.config.isMergeNode,
    );
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
    this.refreshFromDb();

    const task = this.stateGetTask(taskId);
    if (!task) throw new OrchestratorError('TASK_NOT_FOUND', `Task "${taskId}" not found`);

    const terminal = new Set(['completed', 'closed', 'stale']);
    if (terminal.has(task.status)) {
      throw new OrchestratorError('TASK_ALREADY_TERMINAL', `Task "${taskId}" is already ${task.status}`);
    }

    // Find all transitive dependents, skipping completed/stale
    const rootId = task.id;
    const upstreamLabel =
      rootId.includes('/') && !rootId.startsWith('__merge__')
        ? rootId.slice(rootId.indexOf('/') + 1)
        : rootId;

    const allTasks = this.stateMachine.getAllTasks();
    const taskMap = new Map(allTasks.map((t) => [t.id, t]));
    const descendantIds = getTransitiveDependents(
      rootId,
      taskMap,
      (t) => t.status === 'completed' || t.status === 'stale',
    );

    const toCancelIds = [rootId, ...descendantIds];
    const cancelled: string[] = [];
    const runningCancelled: string[] = [];
    this.invalidateLaunchArtifactsForTasks(toCancelIds, 'task cancellation');

    for (const id of toCancelIds) {
      const t = this.stateGetTask(id);
      if (!t || t.status === 'completed' || t.status === 'stale') continue;

      const wasRunning = t.status === 'running' || t.status === 'fixing_with_ai';

      // Free scheduler slot and deferred set
      this.deferredTaskIds.delete(id);
      if (wasRunning) {
        runningCancelled.push(id);
      }
      this.clearQueuedSchedulerEntries(id, t.execution.selectedAttemptId);

      // Mark as failed
      const errorMsg =
        id === rootId
          ? 'Terminated by user'
          : `Terminated: upstream task "${upstreamLabel}" was terminated`;
      const changes: TaskStateChanges = {
        status: 'failed',
        execution: { error: errorMsg, completedAt: new Date() },
      };
      const cancelUpdated = this.writeAndSync(id, changes);
      this.updateSelectedAttempt(id, {
        status: 'failed',
        error: errorMsg,
        completedAt: changes.execution?.completedAt,
      });
      const delta: TaskDelta = this.buildUpdateDelta(t, cancelUpdated, changes);
      this.persistence.logEvent?.(id, 'task.cancelled', changes);
      this.messageBus.publish(TASK_DELTA_CHANNEL, delta);

      cancelled.push(id);
    }

    this.checkWorkflowCompletion();
    return { cancelled, runningCancelled };
  }

  /**
   * Cancel all active tasks in a workflow.
   * Terminal tasks (completed/stale) are preserved as-is.
   */
  cancelWorkflow(workflowId: string): { cancelled: string[]; runningCancelled: string[] } {
    this.refreshWorkflowFromDb(workflowId);

    const allTasks = this.stateMachine.getAllTasks().filter(
      (t) => t.config.workflowId === workflowId,
    );
    if (allTasks.length === 0) {
      throw new OrchestratorError('WORKFLOW_NOT_FOUND', `No tasks found for workflow ${workflowId}`);
    }

    const cancellable = new Set([
      'pending',
      'running',
      'fixing_with_ai',
      'blocked',
      'needs_input',
      'review_ready',
      'awaiting_approval',
    ]);

    const cancelled: string[] = [];
    const runningCancelled: string[] = [];
    this.invalidateLaunchArtifactsForTasks(
      allTasks.filter((task) => cancellable.has(task.status)).map((task) => task.id),
      'workflow cancellation',
    );

    for (const task of allTasks) {
      if (!cancellable.has(task.status)) continue;

      const id = task.id;
      const wasRunning = task.status === 'running' || task.status === 'fixing_with_ai';

      this.deferredTaskIds.delete(id);
      if (wasRunning) {
        runningCancelled.push(id);
      }
      this.clearQueuedSchedulerEntries(id, task.execution.selectedAttemptId);

      const changes: TaskStateChanges = {
        status: 'failed',
        execution: {
          error: 'Cancelled by user (workflow)',
          completedAt: new Date(),
        },
      };
      const wfCancelUpdated = this.writeAndSync(id, changes);
      this.updateSelectedAttempt(id, {
        status: 'failed',
        error: 'Cancelled by user (workflow)',
        completedAt: changes.execution?.completedAt,
      });
      this.persistence.logEvent?.(id, 'task.cancelled', changes);
      this.messageBus.publish(TASK_DELTA_CHANNEL, this.buildUpdateDelta(task, wfCancelUpdated, changes));
      cancelled.push(id);
    }

    this.checkWorkflowCompletion();
    return { cancelled, runningCancelled };
  }

  /**
   * Defer a running task back to pending when a resource limit is hit.
   * The task is re-enqueued when another task completes and frees a slot.
   */
  deferTask(taskId: string): void {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) return;
    const id = task.id;
    this.invalidateLaunchArtifactsForTasks([id], 'task deferred');

    // Transition running → pending. A deferred launch must not retain the
    // launch-claimed phase; otherwise it can be mistaken for an actively
    // dispatchable launch with no executor owner.
    const changes: TaskStateChanges = {
      status: 'pending',
      execution: {
        startedAt: undefined,
        lastHeartbeatAt: undefined,
        phase: undefined,
        launchStartedAt: undefined,
        launchCompletedAt: undefined,
      },
    };
    const deferUpdated = this.writeAndSync(id, changes);
    const delta: TaskDelta = this.buildUpdateDelta(task, deferUpdated, changes);
    this.persistence.logEvent?.(id, 'task.deferred', changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);

    // Remove any queued re-dispatch for this task; persisted attempt state now
    // owns active-slot truth.
    this.clearQueuedSchedulerEntries(id, task.execution.selectedAttemptId);

    this.replaceSelectedAttempt(task);

    // Park in deferred set — re-enqueued when a task completes
    this.deferredTaskIds.add(id);

    // Let other ready tasks fill the freed slot
    this.drainScheduler();
  }

  /**
   * Get detailed queue status with task metadata for display.
   */
  getQueueStatus(): {
    maxConcurrency: number;
    runningCount: number;
    running: Array<{ taskId: string; attemptId?: string; description: string }>;
    queued: Array<{ taskId: string; priority: number; description: string }>;
  } {
    this.refreshFromDb();
    const tasks = this.stateMachine.getAllTasks();
    const now = Date.now();
    const activeAttempts = tasks
      .map((task) => {
        const attemptId = task.execution.selectedAttemptId;
        const attempt = this.loadAttemptById(attemptId);
        return { task, attemptId, attempt };
      })
      .filter(({ task, attempt }) => this.isTaskExecutionActive(task, attempt, now));
    const activeTaskIds = new Set(activeAttempts.map(({ task }) => task.id));
    const queuedTasks = this.stateMachine
      .getReadyTasks()
      .filter((task) => task.status === 'pending')
      .filter((task) => !activeTaskIds.has(task.id))
      .filter((task) => this.getExternalDependencyBlocker(task) === undefined)
      .map((task) => {
        const attempt = task.execution.selectedAttemptId
          ? this.loadAttemptById(task.execution.selectedAttemptId)
          : undefined;
        return {
          taskId: task.id,
          priority: attempt?.queuePriority ?? 0,
          description: task.description,
          createdAt: attempt?.createdAt?.getTime() ?? task.createdAt.getTime(),
        };
      })
      .sort((a, b) => (b.priority - a.priority) || (a.createdAt - b.createdAt));

    return {
      maxConcurrency: this.maxConcurrency,
      runningCount: activeAttempts.length,
      running: activeAttempts.map(({ task, attemptId }) => ({
        taskId: task.id,
        attemptId,
        description: task.description,
      })),
      queued: queuedTasks.map((task) => ({
        taskId: task.taskId,
        priority: task.priority,
        description: task.description,
      })),
    };
  }

  // ── Private: Response Handling ─────────────────────────────

  private handleCompleted(
    taskId: string,
    parsed: Extract<ParsedResponse, { type: 'completed' }>,
  ): TaskState[] {
    const task = this.stateGetTask(taskId);
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
    const completedUpdated = this.writeAndSync(taskId, changes);
    const delta: TaskDelta = this.buildUpdateDelta(task!, completedUpdated, changes);
    const eventName = needsApproval ? 'task.awaiting_approval' : 'task.completed';
    this.persistence.logEvent?.(taskId, eventName, changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);

    // Dual-write: update current selected attempt to completed (best-effort)
    try {
      const currentAttemptId = this.stateGetTask(taskId)?.execution.selectedAttemptId;
      const currentAttempt = currentAttemptId ? this.persistence.loadAttempt(currentAttemptId) : undefined;
      if (currentAttempt && currentAttempt.status === 'running') {
        this.taskRepository.updateAttempt(currentAttempt.id, {
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

    this.checkExperimentCompletion(taskId);

    const readyTaskIds = this.stateMachine.findNewlyReadyTasks(taskId);
    this.logger.info('[orchestrator] handleCompleted', {
      taskId,
      newlyReadyCount: readyTaskIds.length,
      readyTaskIds,
    });
    const started = this.autoStartReadyTasks(readyTaskIds);
    started.push(...this.autoStartUnblockedTasks());
    started.push(...this.autoStartExternallyUnblockedReadyTasks());

    // Re-enqueue deferred tasks now that a slot freed up
    if (this.deferredTaskIds.size > 0) {
      for (const id of this.deferredTaskIds) {
        const t = this.stateGetTask(id);
        if (t && t.status === 'pending') {
          const attemptId = this.ensureCurrentPendingAttempt(t);
          this.scheduler.enqueue({ taskId: id, attemptId, priority: 0 });
        }
      }
      this.deferredTaskIds.clear();
      started.push(...this.drainScheduler());
    }

    this.checkWorkflowCompletion();
    return started;
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
    const existing = this.stateGetTask(taskId);
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
    this.taskRepository.failTaskAndAttempt(taskId, changes, {
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
    this.stateMachine.restoreTask(updated);

    const delta: TaskDelta = this.buildUpdateDelta(existing, updated, changes);
    this.persistence.logEvent?.(taskId, eventName, changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);

    this.checkExperimentCompletion(taskId);

    const readyTaskIds = this.stateMachine.findNewlyReadyTasks(taskId);
    this.logger.info('[orchestrator] finalizeFailedTask', {
      taskId,
      eventName,
      newlyReadyCount: readyTaskIds.length,
      readyTaskIds,
    });
    const started = this.autoStartReadyTasks(readyTaskIds);
    started.push(...this.autoStartUnblockedTasks());
    started.push(...this.autoStartExternallyUnblockedReadyTasks());

    // Re-enqueue deferred tasks now that a slot freed up
    if (this.deferredTaskIds.size > 0) {
      for (const id of this.deferredTaskIds) {
        const t = this.stateGetTask(id);
        if (t && t.status === 'pending') {
          const attemptId = this.ensureCurrentPendingAttempt(t);
          this.scheduler.enqueue({ taskId: id, attemptId, priority: 0 });
        }
      }
      this.deferredTaskIds.clear();
      started.push(...this.drainScheduler());
    }

    this.checkWorkflowCompletion();
    return started;
  }

  private handleReviewReady(
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
      },
    };
    this.setTaskApprovalStatus(taskId, 'review_ready', 'task.review_ready', changes);

    const started = this.autoStartUnblockedTasks();
    started.push(...this.autoStartExternallyUnblockedReadyTasks());
    this.checkWorkflowCompletion();
    return started;
  }

  private handleFailed(
    taskId: string,
    parsed: Extract<ParsedResponse, { type: 'failed' }>,
  ): TaskState[] {
    const mergeConflict = parseMergeConflictError(parsed.error);
    return this.finalizeFailedTask(
      taskId,
      {
        exitCode: parsed.exitCode,
        error: parsed.error,
        agentName: parsed.agentName,
        lastAgentName: parsed.agentName,
        mergeConflict,
      },
      'task.failed',
    );
  }

  private handleNeedsInput(
    taskId: string,
    parsed: Extract<ParsedResponse, { type: 'needs_input' }>,
  ): TaskState[] {
    const changes: TaskStateChanges = {
      status: 'needs_input',
      execution: { inputPrompt: parsed.prompt },
    };
    const needsInputBefore = this.stateGetTask(taskId)!;
    const needsInputUpdated = this.writeAndSync(taskId, changes);
    const currentAttemptId = needsInputUpdated.execution.selectedAttemptId;
    if (currentAttemptId) {
      this.taskRepository.updateAttempt(currentAttemptId, { status: 'needs_input' });
    }
    const delta: TaskDelta = this.buildUpdateDelta(needsInputBefore, needsInputUpdated, changes);
    this.persistence.logEvent?.(taskId, 'task.needs_input', changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
    return [];
  }

  private handleSpawnExperiments(
    taskId: string,
    parsed: Extract<ParsedResponse, { type: 'spawn_experiments' }>,
  ): TaskState[] {
    const parentTask = this.stateGetTask(taskId);
    const wfId = parentTask?.config.workflowId;
    if (!wfId) {
      this.logger.warn('[orchestrator] handleSpawnExperiments: missing workflowId; skipping', {
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
      wfId && typeof this.persistence.loadWorkflow === 'function'
        ? this.persistence.loadWorkflow(wfId)
        : undefined;
    const pivotBranch =
      wf && typeof (wf as { baseBranch?: string }).baseBranch === 'string'
        ? (wf as { baseBranch: string }).baseBranch.trim()
        : '';
    const sourceChanges =
      pivotBranch !== '' ? { execution: { branch: pivotBranch } } : undefined;

    this.applyGraphMutation({
      sourceNodeId: taskId,
      sourceDisposition: 'complete',
      sourceChanges,
      newNodes,
      outputNodeId: reconciliationId,
    });

    const readyIds = experimentTasks.map((t) => t.id);
    return this.autoStartReadyTasks(readyIds);
  }

  private handleSelectExperiment(
    taskId: string,
    parsed: Extract<ParsedResponse, { type: 'select_experiment' }>,
  ): TaskState[] {
    return this.selectExperiment(taskId, parsed.experimentId);
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
    for (const recon of this.stateMachine.getAllTasks()) {
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
        const dep = this.stateGetTask(depId);
        return dep && (dep.status === 'completed' || dep.status === 'failed');
      });

      if (allReported) {
        const experimentResults = recon.dependencies.map((depId) => {
          const dep = this.stateGetTask(depId)!;
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
        const reconUpdated = this.writeAndSync(recon.id, reconChanges);
        const delta: TaskDelta = this.buildUpdateDelta(recon, reconUpdated, reconChanges);
        this.persistence.logEvent?.(recon.id, 'task.experiment_results_recorded', reconChanges);
        this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
      }
    }
  }

  private checkWorkflowCompletion(): void {
    for (const wfId of this.activeWorkflowIds) {
      this.touchWorkflow(wfId);
    }
  }

  private autoStartReadyTasks(taskIds: string[], priority: number = 0, opts?: LaunchReadinessOptions): TaskState[] {
    for (const taskId of taskIds) {
      let task = this.stateGetTask(taskId);
      if (!task) continue;
      if (this.getExternalDependencyBlocker(task) !== undefined) continue;

      // Unblock: if a blocked task's deps are all complete, it's genuinely ready
      if (task.status === 'blocked') {
        this.logger.info('[orchestrator] autoStartReadyTasks: unblocking blocked task', {
          taskId,
        });
        this.replaceSelectedAttempt(task, { status: 'pending' });
        this.writeAndSync(taskId, {
          status: 'pending',
          execution: {
            startedAt: undefined,
            completedAt: undefined,
            lastHeartbeatAt: undefined,
            launchStartedAt: undefined,
            launchCompletedAt: undefined,
            phase: undefined,
          },
        });
        task = this.stateGetTask(taskId);
        if (!task) continue;
      }

      this.enqueueIfNotScheduled(taskId, priority, opts);
    }

    return this.drainScheduler();
  }

  private enqueueIfNotScheduled(taskId: string, priority: number = 0, opts?: LaunchReadinessOptions): void {
    const task = this.stateGetTask(taskId);
    if (!task) return;
    if (this.getExternalDependencyBlocker(task) !== undefined) return;

    const attemptId = this.ensureCurrentPendingAttempt(task);
    const currentAttempt = this.loadAttemptById(attemptId);
    if ((currentAttempt?.queuePriority ?? 0) !== priority) {
      this.taskRepository.updateAttempt(attemptId, { queuePriority: priority });
    }
    // A task can be force-set back to blocked/pending by recovery logic while
    // still carrying a stale selectedAttemptId from an older run. Only skip
    // re-enqueue when the task is actually active.
    if (
      (task.status === 'running' || task.status === 'fixing_with_ai') &&
      task.execution.selectedAttemptId === attemptId &&
      this.isAttemptLeaseActive(currentAttempt)
    ) {
      return;
    }
    const queuedJob = this.scheduler
      .getQueuedJobs()
      .find((job) => job.attemptId === attemptId || job.taskId === taskId);
    if (queuedJob) {
      const shouldReplaceQueuedJob =
        priority > queuedJob.priority ||
        (opts?.bypassLocalDependencyReadiness === true && !queuedJob.bypassLocalDependencyReadiness);
      if (shouldReplaceQueuedJob) {
        this.scheduler.removeJob(queuedJob.attemptId ?? queuedJob.taskId);
        this.scheduler.enqueue({
          taskId,
          attemptId,
          priority: Math.max(priority, queuedJob.priority),
          ...(opts?.bypassLocalDependencyReadiness ? { bypassLocalDependencyReadiness: true } : {}),
        });
      }
      return;
    }
    this.scheduler.enqueue({
      taskId,
      attemptId,
      priority,
      ...(opts?.bypassLocalDependencyReadiness ? { bypassLocalDependencyReadiness: true } : {}),
    });
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
    const started = this.autoStartUnblockedTasks();
    const readyTasks = this.stateMachine
      .getReadyTasks()
      .filter((task) => this.getExternalDependencyBlocker(task) === undefined);

    for (const task of readyTasks) {
      this.enqueueIfNotScheduled(task.id);
    }
    started.push(...this.drainScheduler());
    return started;
  }

  private autoStartUnblockedTasks(): TaskState[] {
    for (const task of this.stateMachine.getAllTasks()) {
      if (task.status !== 'blocked') continue;
      if (!this.areLocalDependenciesSatisfied(task)) continue;
      if (this.getExternalDependencyBlocker(task) !== undefined) continue;

      this.replaceSelectedAttempt(task, { status: 'pending' });
      this.writeAndSync(task.id, {
        status: 'pending',
        execution: {
          blockedBy: undefined,
          startedAt: undefined,
          completedAt: undefined,
          lastHeartbeatAt: undefined,
          launchStartedAt: undefined,
          launchCompletedAt: undefined,
          phase: undefined,
        },
      });
      this.enqueueIfNotScheduled(task.id);
    }
    return this.drainScheduler();
  }

  getTaskLaunchReadiness(taskId: string, opts?: LaunchReadinessOptions): TaskLaunchReadiness {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) {
      return { ready: false, reason: `task ${taskId} not found` };
    }
    if (task.status !== 'pending') {
      return { ready: false, reason: `task status is ${task.status}`, task };
    }

    if (!opts?.bypassLocalDependencyReadiness) {
      const localBlocker = this.getLocalDependencyBlocker(task);
      if (localBlocker) {
        return { ready: false, reason: localBlocker, task };
      }
    }

    const externalBlocker = this.getExternalDependencyBlocker(task);
    if (externalBlocker) {
      return { ready: false, reason: externalBlocker, task };
    }

    return { ready: true, task };
  }

  private areLocalDependenciesSatisfied(task: TaskState): boolean {
    return this.getLocalDependencyBlocker(task) === undefined;
  }

  private getLocalDependencyBlocker(task: TaskState): string | undefined {
    for (const depId of task.dependencies) {
      const dep = this.stateGetTask(depId);
      if (!dep) return `missing dependency ${depId}`;
      const satisfied = task.config?.isReconciliation
        ? dep.status === 'completed' || dep.status === 'failed' || dep.status === 'closed' || dep.status === 'stale'
        : dep.status === 'completed' || dep.status === 'stale';
      if (!satisfied) {
        return `waiting on ${depId} (${dep.status})`;
      }
    }
    return undefined;
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
      return this.getMergeNode(workflowId);
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
    opts?: {
      upstreamWorkflow?: {
        baseBranch?: string;
        featureBranch?: string;
      };
    },
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
    this.taskRepository.updateWorkflow(workflowId, {
      externalDependencies: nextDeps.length > 0 ? nextDeps : undefined,
      externalDependencyChanges: dependencyChanges,
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

    const upstreamFeatureBranch = opts?.upstreamWorkflow?.featureBranch?.trim();
    const upstreamBaseBranch = opts?.upstreamWorkflow?.baseBranch?.trim();
    const targetBaseBranch = targetWorkflow?.baseBranch?.trim();
    if (
      upstreamFeatureBranch
      && upstreamBaseBranch
      && targetBaseBranch
      && targetBaseBranch === upstreamFeatureBranch
    ) {
      this.taskRepository.updateWorkflow(workflowId, { baseBranch: upstreamBaseBranch });
    }

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
    const started: TaskState[] = [];
    const activeAttempts = this.countActivePersistedAttempts();
    let availableSlots = Math.max(0, this.maxConcurrency - activeAttempts);
    this.logger.info('[orchestrator] drainScheduler: begin', {
      active: activeAttempts,
      maxConcurrency: this.maxConcurrency,
      availableSlots,
    });
    let job = availableSlots > 0 ? this.scheduler.takeNext() : null;
    while (job && availableSlots > 0) {
      const readiness = this.getTaskLaunchReadiness(job.taskId, {
        bypassLocalDependencyReadiness: job.bypassLocalDependencyReadiness,
      });
      this.logger.info('[orchestrator] drainScheduler: dequeued', {
        taskId: job.taskId,
        actualStatus: readiness.task?.status ?? 'NOT_FOUND',
      });
      if (!readiness.ready) {
        this.logger.info('[orchestrator] drainScheduler: skipping non-ready task', {
          taskId: job.taskId,
          reason: readiness.reason,
        });
        job = this.scheduler.takeNext();
        continue;
      }
      const task = readiness.task;

      const now = new Date();
      let attemptId = job.attemptId ?? this.ensureCurrentPendingAttempt(task);
      let currentAttempt = this.loadAttemptById(attemptId);
      if (!currentAttempt || isDiscardedAttempt(currentAttempt)) {
        attemptId = this.ensureCurrentPendingAttempt(task);
        currentAttempt = this.loadAttemptById(attemptId);
      }
      if (!currentAttempt || isDiscardedAttempt(currentAttempt)) {
        this.logger.info('[orchestrator] drainScheduler: skipping non-runnable attempt', {
          taskId: job.taskId,
          attemptId,
          attemptStatus: currentAttempt?.status ?? 'missing',
        });
        job = this.scheduler.takeNext();
        continue;
      }
      let launchAttemptId = attemptId;
      const selectedTask = this.stateGetTask(job.taskId) ?? task;
      if (selectedTask.execution.selectedAttemptId !== attemptId) {
        this.writeAndSync(job.taskId, { execution: { selectedAttemptId: attemptId } });
      }
      let claimSucceeded = false;
      const claimPatch = this.deferRunningUntilLaunch
        ? {
            status: 'claimed' as const,
            claimedAt: now,
            lastHeartbeatAt: now,
            leaseExpiresAt: nextLeaseExpiry(now),
          }
        : {
            status: 'running' as const,
            claimedAt: currentAttempt?.claimedAt ?? now,
            startedAt: now,
            lastHeartbeatAt: now,
            leaseExpiresAt: nextLeaseExpiry(now),
          };
      claimSucceeded = this.taskRepository.claimAttemptForLaunch?.(attemptId, claimPatch, now)
        ?? !this.isAttemptLeaseActive(currentAttempt, now.getTime());
      if (claimSucceeded && !this.taskRepository.claimAttemptForLaunch) {
        this.taskRepository.updateAttempt(attemptId, claimPatch);
      }
      if (!claimSucceeded) {
        this.logger.info('[orchestrator] drainScheduler: skipping already-claimed attempt', {
          taskId: job.taskId,
          attemptId,
        });
        job = availableSlots > 0 ? this.scheduler.takeNext() : null;
        continue;
      }

      const changes: TaskStateChanges = this.deferRunningUntilLaunch
        ? {
            status: 'pending',
            execution: {
              selectedAttemptId: launchAttemptId,
              generation: this.getExecutionGeneration(task),
              lastHeartbeatAt: now,
              phase: 'launching',
              launchStartedAt: now,
              launchCompletedAt: undefined,
            },
          }
        : {
            status: 'running',
            execution: {
              selectedAttemptId: launchAttemptId,
              generation: this.getExecutionGeneration(task),
              startedAt: now,
              lastHeartbeatAt: now,
              phase: 'launching',
              launchStartedAt: now,
              launchCompletedAt: undefined,
            },
          };
      const updated = this.writeAndSync(job.taskId, changes);
      this.persistence.logEvent?.(
        job.taskId,
        this.deferRunningUntilLaunch ? 'task.launch_claimed' : 'task.running',
        changes,
      );
      if (
        this.launchOutboxMode !== 'disabled'
        && typeof this.persistence.enqueueLaunchDispatch === 'function'
        && task.config.workflowId
      ) {
        try {
          const dispatch = this.persistence.enqueueLaunchDispatch({
            taskId: job.taskId,
            attemptId: launchAttemptId,
            workflowId: task.config.workflowId,
            generation: this.getExecutionGeneration(task),
          });
          this.persistence.logEvent?.(job.taskId, 'task.dispatch_enqueued', {
            ...changes,
            dispatchId: dispatch.id,
            attemptId: launchAttemptId,
            workflowId: task.config.workflowId,
            generation: this.getExecutionGeneration(task),
            state: dispatch.state,
            priority: dispatch.priority,
          });
          this.logger.info('[orchestrator] drainScheduler: launch dispatch enqueued', {
            taskId: job.taskId,
            attemptId: launchAttemptId,
            workflowId: task.config.workflowId,
            generation: this.getExecutionGeneration(task),
            dispatchId: dispatch.id,
            state: dispatch.state,
            priority: dispatch.priority,
          });
        } catch (err) {
          this.logger.warn('[orchestrator] drainScheduler: enqueueLaunchDispatch failed', {
            taskId: job.taskId,
            attemptId: launchAttemptId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      this.messageBus.publish(TASK_DELTA_CHANNEL, this.buildUpdateDelta(task, updated, changes));
      started.push(updated);
      this.logger.info('[orchestrator] drainScheduler: started', {
        taskId: job.taskId,
        attemptId: launchAttemptId,
        phase: 'launching',
        generation: changes.execution?.generation ?? 'unknown',
      });

      availableSlots -= 1;
      job = availableSlots > 0 ? this.scheduler.takeNext() : null;
    }
    return started;
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

    if (task.status !== 'running' && task.status !== 'pending' && task.status !== 'fixing_with_ai') {
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
      const changes: TaskStateChanges = task.status === 'pending'
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
