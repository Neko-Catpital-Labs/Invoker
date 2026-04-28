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
import type { TaskState, TaskDelta, TaskStateChanges, TaskConfig, Attempt, ExternalDependency, TaskStatus } from '@invoker/workflow-graph';
import type { ExecutorType } from '@invoker/workflow-graph';
import { createTaskState, createAttempt } from '@invoker/workflow-graph';
import type { Logger, WorkResponse } from '@invoker/contracts';
import { normalizeExecutorType } from '@invoker/workflow-graph';

const MERGE_TRACE_LOG = resolve(homedir(), '.invoker', 'merge-trace.log');
function mergeTrace(tag: string, data: Record<string, unknown>): void {
  try {
    mkdirSync(resolve(homedir(), '.invoker'), { recursive: true });
    appendFileSync(MERGE_TRACE_LOG, `${new Date().toISOString()} [merge-trace:orchestrator] ${tag} ${JSON.stringify(data)}\n`);
  } catch { /* best effort */ }
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

// ── Channel Constants ───────────────────────────────────────

const TASK_DELTA_CHANNEL = 'task.delta';
let workflowCounter = 0;

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
const FIX_FAILURE_PREFIX_RE = /^\[Fix with (?:Claude|Agent) failed\] [^\n]*\n\n/;
const ATTEMPT_LEASE_MS = 20 * 60 * 1000;
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

export interface OrchestratorPersistence {
  saveWorkflow(workflow: {
    id: string;
    name: string;
    description?: string;
    visualProof?: boolean;
    status: 'running' | 'completed' | 'failed';
    createdAt: string;
    updatedAt: string;
    repoUrl?: string;
    onFinish?: string;
    baseBranch?: string;
    featureBranch?: string;
    mergeMode?: 'manual' | 'automatic' | 'external_review';
  }): void;
  updateWorkflow?(workflowId: string, changes: { status?: string; updatedAt?: string; baseBranch?: string; generation?: number; mergeMode?: 'manual' | 'automatic' | 'external_review' }): void;
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
    generation?: number;
  }>;
  loadTasks(workflowId: string): TaskState[];
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
    baseBranch?: string;
    mergeMode?: 'manual' | 'automatic' | 'external_review';
  } | undefined;
  /** Delete a single workflow and its tasks from the DB. */
  deleteWorkflow?(workflowId: string): void;
  /** Delete all workflows and tasks from the DB. */
  deleteAllWorkflows?(): void;
}

export interface OrchestratorMessageBus {
  publish<T>(channel: string, message: T): void;
}

// ── Public Types ────────────────────────────────────────────

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
  tasks: Array<{
    id: string;
    description: string;
    command?: string;
    prompt?: string;
    dependencies?: string[];
    externalDependencies?: Array<{
      workflowId: string;
      taskId: string;
      requiredStatus?: 'completed';
      gatePolicy?: 'completed' | 'review_ready';
    }>;
    pivot?: boolean;
    experimentVariants?: Array<{ id: string; description: string; prompt?: string; command?: string }>;
    requiresManualApproval?: boolean;
    featureBranch?: string;
    executorType?: string;
    dockerImage?: string;
    remoteTargetId?: string;
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
  executorType?: ExecutorType;
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
  executorType?: ExecutorType;
  executionAgent?: string;
}

export interface ExternalGatePolicyUpdate {
  workflowId: string;
  taskId?: string;
  gatePolicy: 'completed' | 'review_ready';
}

/**
 * A single routing rule that validates task execution environment against command patterns.
 * When a rule matches a task command, the orchestrator validates that the task's
 * executorType and remoteTargetId conform to the rule's requirements.
 */
export interface ExecutorRoutingRule {
  /** Substring to match against the task command. */
  pattern?: string;
  /** Regular expression matched against the task command; compiled with new RegExp(regex). */
  regex?: string;
  /** Required executor type for matching commands (e.g. "ssh", "docker", "worktree"). */
  executorType: string;
  /** Required remote target ID for matching commands; must correspond to an entry in remoteTargets. */
  remoteTargetId: string;
}

export interface CommandRoutingMatcher {
  pattern?: string;
  regex?: string;
}

export interface HeavyweightCommandRoutingPolicy {
  enabled?: boolean;
  executorType?: string;
  remoteTargetId: string;
  matchers?: CommandRoutingMatcher[];
}

const DEFAULT_HEAVYWEIGHT_COMMAND_MATCHERS: CommandRoutingMatcher[] = [
  { regex: '\\bpnpm(?:\\s|$)' },
];

function findMatchingCommandRoutingMatcher(
  command: string,
  matchers: CommandRoutingMatcher[],
): CommandRoutingMatcher | undefined {
  for (const matcher of matchers) {
    const patternMatch = matcher.pattern !== undefined && command.includes(matcher.pattern);
    const regexMatch = matcher.regex !== undefined && new RegExp(matcher.regex).test(command);
    if (patternMatch || regexMatch) {
      return matcher;
    }
  }
  return undefined;
}

function resolveHeavyweightCommandRouting(
  taskId: string,
  command: string | undefined,
  planExecutorType: string | undefined,
  planRemoteTargetId: string | undefined,
  policy: HeavyweightCommandRoutingPolicy | undefined,
  availableRemoteTargetIds: Set<string>,
): { executorType?: string; remoteTargetId?: string } | undefined {
  if (!command || !policy || policy.enabled === false) {
    return undefined;
  }

  const matchers = policy.matchers?.length ? policy.matchers : DEFAULT_HEAVYWEIGHT_COMMAND_MATCHERS;
  const matched = findMatchingCommandRoutingMatcher(command, matchers);
  if (!matched) {
    return undefined;
  }

  const policyExecutorType = normalizeExecutorType(policy.executorType) ?? 'ssh';
  if (policyExecutorType !== 'ssh') {
    throw new Error(
      `Task "${taskId}" with command "${command}" matched heavyweight command routing, ` +
      `but config executorType="${policyExecutorType}" is unsupported. Expected "ssh".`,
    );
  }

  if (availableRemoteTargetIds.size > 0 && !availableRemoteTargetIds.has(policy.remoteTargetId)) {
    throw new Error(
      `Task "${taskId}" with command "${command}" matched heavyweight command routing, ` +
      `but config remoteTargetId="${policy.remoteTargetId}" is not defined in remoteTargets.`,
    );
  }

  if (availableRemoteTargetIds.size === 0) {
    throw new Error(
      `Task "${taskId}" with command "${command}" matched heavyweight command routing, ` +
      `but no remoteTargets are configured.`,
    );
  }

  const normalizedPlanType = normalizeExecutorType(planExecutorType) ?? 'worktree';
  if (planExecutorType !== undefined && normalizedPlanType !== policyExecutorType) {
    throw new Error(
      `Task "${taskId}" with command "${command}" matched heavyweight command routing and must use ` +
      `executorType="${policyExecutorType}", but plan declares executorType="${normalizedPlanType}"`,
    );
  }

  if (planRemoteTargetId !== undefined && planRemoteTargetId !== policy.remoteTargetId) {
    throw new Error(
      `Task "${taskId}" with command "${command}" matched heavyweight command routing and must use ` +
      `remoteTargetId="${policy.remoteTargetId}", but plan declares remoteTargetId="${planRemoteTargetId}"`,
    );
  }

  return {
    executorType: policyExecutorType,
    remoteTargetId: policy.remoteTargetId,
  };
}

/**
 * Finds the first executor routing rule that matches the given command.
 * A rule matches when `pattern` is a substring of `command`, `regex` compiles and tests
 * true against `command`, or both (either is sufficient).
 * Returns the matching rule or undefined if no rule matches.
 */
export function findMatchingExecutorRoutingRule(
  command: string,
  rules: ExecutorRoutingRule[],
): ExecutorRoutingRule | undefined {
  for (const rule of rules) {
    const patternMatch = rule.pattern !== undefined && command.includes(rule.pattern);
    const regexMatch = rule.regex !== undefined && new RegExp(rule.regex).test(command);
    if (patternMatch || regexMatch) {
      return rule;
    }
  }
  return undefined;
}

/**
 * Validates that a task's routing conforms to executor routing rules.
 * Returns immediately if the task has no command or no rules are configured.
 * When a rule matches the task command, throws if the task's executorType or remoteTargetId
 * do not match the rule's requirements.
 */
export function assertExecutorRoutingConforms(
  taskId: string,
  command: string | undefined,
  planExecutorType: string | undefined,
  planRemoteTargetId: string | undefined,
  rules: ExecutorRoutingRule[],
): void {
  if (!command || rules.length === 0) {
    return;
  }

  const matchingRule = findMatchingExecutorRoutingRule(command, rules);
  if (!matchingRule) {
    return;
  }

  // Normalize both plan and rule executorType the same way createTaskState does
  const normalizedPlanType = normalizeExecutorType(planExecutorType) ?? 'worktree';
  const normalizedRuleType = normalizeExecutorType(matchingRule.executorType) ?? matchingRule.executorType;

  if (normalizedPlanType !== normalizedRuleType) {
    throw new Error(
      `Task "${taskId}" with command "${command}" requires executorType="${normalizedRuleType}" ` +
      `but plan declares executorType="${normalizedPlanType}"`
    );
  }

  if (planRemoteTargetId !== matchingRule.remoteTargetId) {
    throw new Error(
      `Task "${taskId}" with command "${command}" requires remoteTargetId="${matchingRule.remoteTargetId}" ` +
      `but plan declares remoteTargetId="${planRemoteTargetId ?? '(undefined)'}"`
    );
  }
}

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
  /** Optional callback for fire-and-forget task dispatch when tasks enter running/launching. */
  taskDispatcher?: (tasks: TaskState[]) => void;
  maxConcurrency?: number;
  /** Default auto-fix retry budget for older tasks missing persisted per-task config. */
  defaultAutoFixRetries?: number;
  /**
   * Rules that validate task execution environment against command patterns.
   * When loading a plan, the orchestrator validates that tasks with commands matching
   * a rule have the required executorType and remoteTargetId specified in the plan.
   */
  executorRoutingRules?: ExecutorRoutingRule[];
  /** Config-owned routing for heavyweight commands (for example `pnpm ...`). */
  heavyweightCommandRouting?: HeavyweightCommandRoutingPolicy;
  /** Valid SSH remote target IDs available at plan submission time. */
  availableRemoteTargetIds?: string[];
  /**
   * When true, keep tasks persisted as `pending` until the executor confirms
   * startup success, then transition to `running`.
   *
   * Default false preserves existing behavior (transition to `running` at
   * scheduler dequeue time).
   */
  deferRunningUntilLaunch?: boolean;
}

// ── Orchestrator ────────────────────────────────────────────

export class Orchestrator {
  private static readonly EXPEDITED_PRIORITY = 100;

  private readonly stateMachine: TaskStateMachine;
  private readonly responseHandler: ResponseHandler;
  private readonly scheduler: TaskScheduler;
  private readonly persistence: OrchestratorPersistence;
  private readonly messageBus: OrchestratorMessageBus;
  private readonly logger: Logger;
  private readonly taskRepository: TaskRepository;
  private readonly taskDispatcher?: (tasks: TaskState[]) => void;
  private readonly maxConcurrency: number;
  private readonly executorRoutingRules: ExecutorRoutingRule[];
  private readonly heavyweightCommandRouting?: HeavyweightCommandRoutingPolicy;
  private readonly availableRemoteTargetIds: Set<string>;
  private readonly defaultAutoFixRetries: number;
  private readonly deferRunningUntilLaunch: boolean;

  private activeWorkflowIds = new Set<string>();
  private deferredTaskIds = new Set<string>();
  private beforeApproveHook?: (task: TaskState) => Promise<void>;

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

  constructor(config: OrchestratorConfig) {
    this.maxConcurrency = config.maxConcurrency ?? 3;
    this.persistence = config.persistence;
    this.messageBus = config.messageBus;
    this.logger = config.logger ?? noopLogger;
    this.taskRepository = config.taskRepository ?? taskRepositoryFromPersistence(config.persistence);
    this.taskDispatcher = config.taskDispatcher;
    this.executorRoutingRules = config.executorRoutingRules ?? [];
    this.heavyweightCommandRouting = config.heavyweightCommandRouting;
    this.availableRemoteTargetIds = new Set(config.availableRemoteTargetIds ?? []);
    this.defaultAutoFixRetries = Math.min(Math.max(0, Math.floor(config.defaultAutoFixRetries ?? 0)), 10);
    this.deferRunningUntilLaunch = config.deferRunningUntilLaunch ?? false;

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
      throw new Error(`writeAndSync: task ${taskId} not found in graph`);
    }
    const id = existing.id;
    this.taskRepository.updateTask(id, changes);
    const updated: TaskState = {
      ...existing,
      ...(changes.status !== undefined ? { status: changes.status } : {}),
      ...(changes.dependencies !== undefined ? { dependencies: changes.dependencies } : {}),
      // Type assertion: spread widens the discriminated union but the runtime
      // value preserves the correct executorType discriminant from existing.config.
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
      this.syncWorkflowStatus(existing.config.workflowId);
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

  private syncWorkflowStatus(workflowId: string): void {
    if (!this.persistence.updateWorkflow) return;

    const tasks = this.stateMachine.getAllTasks().filter((task) => task.config.workflowId === workflowId);
    if (tasks.length === 0) return;

    const settled = tasks.every(
      (task) =>
        task.status === 'completed' ||
        task.status === 'failed' ||
        task.status === 'needs_input' ||
        task.status === 'review_ready' ||
        task.status === 'awaiting_approval' ||
        task.status === 'blocked' ||
        task.status === 'stale',
    );

    const hasPendingInput = tasks.some(
      (task) =>
        task.status === 'needs_input' ||
        task.status === 'awaiting_approval' ||
        task.status === 'review_ready',
    );

    let status = 'running';
    if (settled && !hasPendingInput) {
      const allSucceeded = tasks.every((task) => task.status === 'completed' || task.status === 'stale');
      status = allSucceeded ? 'completed' : 'failed';
    }

    this.persistence.updateWorkflow(workflowId, {
      status,
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
      for (const id of affectedIds) {
        const current = this.stateGetTask(id);
        if (!current) continue;
        if (current.config.workflowId) {
          workflowsToSync.add(current.config.workflowId);
        }

        const shouldReset = forceResetIds.has(id) || current.status !== 'pending';
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
        this.syncWorkflowStatus(workflowId);
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
      return task.status === 'running' || task.status === 'fixing_with_ai';
    }

    return task.status === 'running' || task.status === 'fixing_with_ai';
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
    if (selected && (selected.status === 'pending' || selected.status === 'claimed' || selected.status === 'running' || selected.status === 'needs_input')) {
      return selected.id;
    }

    const loadAttempts = (this.persistence as Partial<OrchestratorPersistence>).loadAttempts;
    const attempts =
      typeof loadAttempts === 'function' ? loadAttempts.call(this.persistence, task.id) : [];
    const current = attempts[attempts.length - 1];
    if (current && (current.status === 'pending' || current.status === 'claimed' || current.status === 'running' || current.status === 'needs_input')) {
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
    if (current && current.status !== 'completed' && current.status !== 'failed' && current.status !== 'superseded') {
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

    if (current && current.status !== 'completed' && current.status !== 'failed' && current.status !== 'superseded') {
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
    for (const taskDef of plan.tasks) {
      const resolvedHeavyweightRouting = resolveHeavyweightCommandRouting(
        taskDef.id,
        taskDef.command,
        taskDef.executorType,
        taskDef.remoteTargetId,
        this.heavyweightCommandRouting,
        this.availableRemoteTargetIds,
      );
      const effectiveExecutorType = resolvedHeavyweightRouting?.executorType ?? taskDef.executorType;
      const effectiveRemoteTargetId = resolvedHeavyweightRouting?.remoteTargetId ?? taskDef.remoteTargetId;

      // Validate executor routing conformance for tasks with commands
      assertExecutorRoutingConforms(
        taskDef.id,
        taskDef.command,
        effectiveExecutorType,
        effectiveRemoteTargetId,
        this.executorRoutingRules,
      );

      const scopedId = localToScoped.get(taskDef.id)!;
      const scopedDeps = (taskDef.dependencies ?? []).map((dep) => {
        const s = localToScoped.get(dep);
        if (!s) {
          throw new Error(`Task "${taskDef.id}" depends on unknown task id "${dep}" in this plan`);
        }
        return s;
      });
      const externalDependencies =
        taskDef.externalDependencies?.map((dep) => ({
          workflowId: dep.workflowId,
          taskId: dep.taskId,
          requiredStatus: dep.requiredStatus ?? 'completed',
          gatePolicy: dep.gatePolicy ?? 'review_ready',
        })) ?? [];
      const baseConfig = {
        workflowId,
        command: taskDef.command,
        prompt: taskDef.prompt,
        pivot: taskDef.pivot,
        experimentVariants: taskDef.experimentVariants,
        requiresManualApproval: taskDef.requiresManualApproval,
        featureBranch: taskDef.featureBranch,
        executionAgent: taskDef.executionAgent,
        externalDependencies,
      } as const;
      const executorType = normalizeExecutorType(effectiveExecutorType) ?? 'worktree';
      let taskConfig: TaskConfig;
      switch (executorType) {
        case 'docker':
          taskConfig = { ...baseConfig, executorType, dockerImage: taskDef.dockerImage, remoteTargetId: effectiveRemoteTargetId };
          break;
        case 'ssh':
          taskConfig = { ...baseConfig, executorType, remoteTargetId: effectiveRemoteTargetId };
          break;
        default:
          taskConfig = { ...baseConfig, executorType: 'worktree' as const, remoteTargetId: effectiveRemoteTargetId };
          break;
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
    for (const taskDef of plan.tasks) {
      for (const dep of taskDef.externalDependencies ?? []) {
        if (!this.findExternalDependencyTask(dep.workflowId, dep.taskId)) {
          const depDisplayId = this.externalDependencyDisplayId(dep.workflowId, dep.taskId);
          missingExternalDeps.push(
            `task "${taskDef.id}" references missing external dependency "${depDisplayId}"`,
          );
        }
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
      { workflowId, isMergeNode: true, executorType: 'merge' },
    );

    // ── Pass 2: all validation passed — persist everything ──
    this.activeWorkflowIds.add(workflowId);
    const createdAt = workflowTimestamp().toISOString();

    this.persistence.saveWorkflow({
      id: workflowId,
      name: plan.name,
      description: plan.description,
      visualProof: plan.visualProof,
      status: 'running',
      repoUrl: plan.repoUrl,
      onFinish: plan.onFinish,
      baseBranch: plan.baseBranch,
      featureBranch: plan.featureBranch,
      mergeMode: plan.mergeMode,
      createdAt,
      updatedAt: createdAt,
    });

    const deltas: TaskDelta[] = [];
    for (const task of validatedTasks) {
      this.createAndSync(task);
      deltas.push({ type: 'created', task });
    }

    this.createAndSync(mergeTask);
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
        const executableStatuses = new Set(['running', 'fixing_with_ai']);
        if (!executableStatuses.has(earlyTask.status)) {
          this.logger.warn('[orchestrator] handleWorkerResponse: ignoring response for non-executable task', {
            workerResponseStatus: response.status,
            taskId: response.actionId,
            status: earlyTask.status,
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

  setFixAwaitingApproval(taskId: string, originalError: string): void {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
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

  /**
   * Select a winning experiment for a reconciliation task — **retry-class**
   * invalidation route per Step 7 of
   * `docs/architecture/task-invalidation-roadmap.md` and the Decision Table
   * row "Edit selected experiment" in
   * `docs/architecture/task-invalidation-chart.md`
   * (`MUTATION_POLICIES.selectedExperiment` → `retryTask` / task scope).
   *
   * Why retry-class (not recreate-class). The chart classifies single
   * experiment selection as a downstream-input mutation: the
   * reconciliation task's *result* (its selected branch/commit) is the
   * execution input that downstream consumers use, so changing the
   * winner invalidates downstream attempts but does NOT change the
   * reconciliation task's own spec. The chart's "Why" column reads
   * "Downstream execution inputs changed". `applyInvalidation('task',
   * 'retryTask', reconId, deps)` is wired to today's
   * `Orchestrator.restartTask` via `buildInvalidationDeps` (the
   * compatibility seam Step 1 introduced; Step 13 will rename
   * `restartTask` → `retryTask` to close the matrix).
   *
   * Sequence (mirrors `applyInvalidation`'s contract for the
   * synchronous orchestrator-internal seam — see `invalidation-policy.ts`
   * and the Step 5/6 `editTaskType` precedent):
   *   1. **Cancel-first (Hard Invariant).** Compute the transitive
   *      downstream subgraph of the reconciliation task and cancel any
   *      member that is actively executing (`running` or
   *      `fixing_with_ai`) BEFORE we mutate the recon's
   *      `selectedExperiment`. This is the "any AFFECTED in-flight
   *      work" guarantee from the chart: stale downstream attempts
   *      cannot survive a re-selection because they would consume the
   *      OLD winner's lineage. For the common initial-selection path
   *      (recon `needs_input` → `completed` with downstream blocked at
   *      `pending`) this loop is a no-op — there is nothing active.
   *   2. **Persist new winner.** `writeAndSync` updates
   *      `execution.selectedExperiment` (and the recon's
   *      `branch`/`commit` to mirror the winner's lineage) and emits a
   *      `task.completed` delta. The reconciliation task's status
   *      transitions to `completed`; this matches the existing
   *      "Behavior Today" column in the chart ("completes
   *      reconciliation task and unblocks downstream").
   *   3. **Retry-class reset of downstream (re-selection only).** When
   *      the recon was previously completed with a *different* winner,
   *      every direct downstream consumer is reset via `restartTask`,
   *      which is the current `retryTask` compatibility wire.
   *      `restartTask` cascades to its own descendants and bumps each
   *      affected task's execution generation exactly once via
   *      `withBumpedExecutionGeneration` (single source of truth for the
   *      retry reset shape — Step 7 deliberately reuses it instead of
   *      duplicating the field list here, mirroring Steps 5/6). For
   *      the initial-selection path no downstream reset is needed
   *      because nothing has executed yet against the recon's result.
   *   4. **Auto-start newly ready tasks.** Existing behavior:
   *      `findNewlyReadyTasks(reconId)` plus `autoStartReadyTasks`
   *      unblocks downstream that just became ready due to recon
   *      completing.
   *
   * Public surface is unchanged: same `(taskId, experimentId)` signature
   * returning `TaskState[]` of newly-started tasks. Active downstream is
   * NO LONGER silently overwritten with a new winner — that's the whole
   * point of cancel-first per the chart's Hard Invariant. Prior to
   * Step 7 there was no general active invalidation model for selection
   * (per the chart's "Behavior Today" column); this method introduces
   * one.
   *
   * NOTE: `recreateTask`'s lineage-discarding reset shape is
   * deliberately NOT used here. Downstream tasks may still hold valid
   * workspace lineage (their own branch, their own workspacePath) that
   * the executor can reuse when the new winner's branch is rebased onto
   * theirs; that is what makes selection retry-class rather than
   * recreate-class in the chart's Decision Table.
   */
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
      for (const dsId of directDownstream) {
        this.recreateTask(dsId);
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
      for (const dsId of directDownstreamAfter) {
        if (this.stateGetTask(dsId)) {
          this.recreateTask(dsId);
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
    if (!task) throw new Error(`Task ${taskId} not found`);
    const id = task.id;

    // Step 18 (`docs/architecture/task-invalidation-roadmap.md`,
    // Hard Invariant): cancel any active attempt on this task or its
    // downstream subgraph BEFORE the reset writes pending state.
    // Defense-in-depth for direct callers (CommandService.retryTask
    // wired in Step 17) that bypass `applyInvalidation`'s upstream
    // cancel; a no-op when invoked through `applyInvalidation`.
    this.cancelActiveBeforeInvalidation('task', id);

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
        commit: undefined,
        lastHeartbeatAt: undefined,
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

    const retryStatuses = new Set([
      'failed',
      'needs_input',
      'blocked',
      'stale',
      'fixing_with_ai',
      'awaiting_approval',
      'review_ready',
    ]);

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
        isFixingWithAI: false,
        // Preserve branch/commit/workspacePath — they contain valid work context
        // Only clear error-related and timing fields
      },
    };

    const retryRootIds = allTasks
      .filter((task) => retryStatuses.has(task.status))
      .map((task) => task.id);
    const { affectedIds } = this.resetSubgraphToPending(retryRootIds, resetChanges);
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
    if (!task) throw new Error(`Task ${taskId} not found`);

    const rootId = task.id;

    // Step 18 cancel-first invariant: interrupt active attempts on
    // this task / downstream subgraph BEFORE the recreate reset.
    // Defense-in-depth for direct callers (CommandService.recreateTask
    // wired in Step 17); a no-op when invoked through `applyInvalidation`.
    this.cancelActiveBeforeInvalidation('task', rootId);
    const allTasks = this.stateMachine.getAllTasks();
    const taskMap = new Map(allTasks.map((t) => [t.id, t]));
    const descendantIds = getTransitiveDependents(rootId, taskMap, () => false);
    const toResetIds = [rootId, ...descendantIds];
    const toResetSet = new Set(toResetIds);

    const resetChanges: TaskStateChanges = {
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
        reviewUrl: undefined,
        reviewId: undefined,
        reviewStatus: undefined,
        reviewProviderId: undefined,
        agentSessionId: undefined,
        containerId: undefined,
      },
    };

    this.logger.info('[orchestrator] recreateTask reset', {
      taskId: rootId,
      resetCount: toResetIds.length,
    });

    for (const id of toResetIds) {
      const current = this.stateGetTask(id);
      if (!current) continue;
      const changesWithGeneration = this.withBumpedExecutionGeneration(current, resetChanges);
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
    return this.autoStartReadyTasks(readyIds, Orchestrator.EXPEDITED_PRIORITY);
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

    const resetChanges: TaskStateChanges = {
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
        reviewUrl: undefined,
        reviewId: undefined,
        reviewStatus: undefined,
        reviewProviderId: undefined,
        agentSessionId: undefined,
        containerId: undefined,
      },
    };

    this.logger.info('[orchestrator] recreateWorkflow reset', {
      workflowId,
      resetCount: allTasks.length,
    });
    this.logger.info(
      '[agent-session-trace] recreateWorkflow: resetChanges.execution clears agentSessionId/containerId (DB NULL before next run)',
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
  beginConflictResolution(taskId: string): { savedError: string } {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
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
   * Revert a conflict resolution attempt: restore the task to failed
   * with its original error and re-parsed mergeConflict field.
   */
  revertConflictResolution(taskId: string, savedError: string, fixError?: string): void {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
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

  editTaskCommand(taskId: string, newCommand: string): TaskState[] {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.config.isMergeNode) throw new Error(`Cannot edit merge node ${taskId}`);

    if (task.status === 'running' || task.status === 'fixing_with_ai') {
      this.cancelTask(taskId);
    }

    const cmdChanges: TaskStateChanges = { config: { command: newCommand } };
    const cmdBefore = this.stateGetTask(taskId)!;
    const cmdUpdated = this.writeAndSync(taskId, cmdChanges);
    const cmdDelta: TaskDelta = this.buildUpdateDelta(cmdBefore, cmdUpdated, cmdChanges);
    this.persistence.logEvent?.(taskId, 'task.updated', cmdChanges);
    this.messageBus.publish(TASK_DELTA_CHANNEL, cmdDelta);

    return this.recreateTask(taskId);
  }

    editTaskPrompt(taskId: string, newPrompt: string): TaskState[] {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.config.isMergeNode) throw new Error(`Cannot edit merge node ${taskId}`);

    if (task.status === 'running' || task.status === 'fixing_with_ai') {
      this.cancelTask(taskId);
    }

    const promptChanges: TaskStateChanges = { config: { prompt: newPrompt } };
    const promptBefore = this.stateGetTask(taskId)!;
    const promptUpdated = this.writeAndSync(taskId, promptChanges);
    const promptDelta: TaskDelta = this.buildUpdateDelta(promptBefore, promptUpdated, promptChanges);
    this.persistence.logEvent?.(taskId, 'task.updated', promptChanges);
    this.messageBus.publish(TASK_DELTA_CHANNEL, promptDelta);

    return this.recreateTask(taskId);
  }

    editTaskType(taskId: string, executorType: string, remoteTargetId?: string): TaskState[] {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.config.isMergeNode) throw new Error(`Cannot change executor type of merge node ${taskId}`);

    const effectiveType = normalizeExecutorType(executorType) ?? executorType;

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

    const oldExecutorType = task.config.executorType;
    const oldRemoteTargetId =
      oldExecutorType === 'ssh' ? task.config.remoteTargetId : undefined;
    const newRemoteTargetId = effectiveType === 'ssh' ? remoteTargetId : undefined;
    const hostKey = (et: string | undefined, rid: string | undefined): string =>
      et === 'ssh' ? `ssh:${rid ?? ''}` : 'local';
    const hostChanged =
      hostKey(oldExecutorType, oldRemoteTargetId) !==
      hostKey(effectiveType, newRemoteTargetId);

    if (task.status === 'running' || task.status === 'fixing_with_ai') {
      this.cancelTask(taskId);
    }

    const configPatch: Record<string, unknown> = { executorType: effectiveType };
    if (effectiveType === 'ssh') {
      configPatch.remoteTargetId = remoteTargetId;
    } else {
      configPatch.remoteTargetId = undefined;
    }
    const typeChanges: TaskStateChanges = { config: configPatch };
    const typeBefore = this.stateGetTask(taskId)!;
    const typeUpdated = this.writeAndSync(taskId, typeChanges);
    const typeDelta: TaskDelta = this.buildUpdateDelta(typeBefore, typeUpdated, typeChanges);
    this.persistence.logEvent?.(taskId, 'task.updated', typeChanges);
    this.messageBus.publish(TASK_DELTA_CHANNEL, typeDelta);

    return hostChanged ? this.recreateTask(taskId) : this.retryTask(taskId);
  }

    editTaskAgent(taskId: string, agentName: string): TaskState[] {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.config.isMergeNode) throw new Error(`Cannot change execution agent of merge node ${taskId}`);

    if (task.status === 'running' || task.status === 'fixing_with_ai') {
      this.cancelTask(taskId);
    }

    const agentChanges: TaskStateChanges = { config: { executionAgent: agentName } };
    const agentBefore = this.stateGetTask(taskId)!;
    const agentUpdated = this.writeAndSync(taskId, agentChanges);
    const agentDelta: TaskDelta = this.buildUpdateDelta(agentBefore, agentUpdated, agentChanges);
    this.persistence.logEvent?.(taskId, 'task.updated', agentChanges);
    this.messageBus.publish(TASK_DELTA_CHANNEL, agentDelta);

    return this.recreateTask(taskId);
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
   *
   * NOTE: `recreateTask`'s lineage-discarding reset shape is
   * deliberately NOT used here. A merge-mode flip does not invalidate
   * the merge node's accumulated workspace (the merged branch lineage
   * built from upstream leaf results); only the merge execution
   * policy changed. That distinction is what makes merge-mode the
   * single retry-class route alongside the other retry-class rows
   * (`executorType`, `selectedExperiment`, `selectedExperimentSet`)
   * in the chart's Decision Table.
   */
  editTaskMergeMode(
    taskId: string,
    mergeMode: 'manual' | 'automatic' | 'external_review',
  ): TaskState[] {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
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

    // Step 9 retry-class reset: restartTask is today's `retryTask`
    // compatibility wire (`buildInvalidationDeps` →
    // `orchestrator.restartTask`). It resets the merge node to
    // `pending`, clears volatile attempt state, and bumps execution
    // generation exactly once via `withBumpedExecutionGeneration`
    // while preserving branch/workspacePath lineage — the chart's
    // retry-class semantics for merge-mode mutations.
    return this.retryTask(taskId);
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
   * spec (`command` / `prompt` / `executionAgent` / `executorType` /
   * `remoteTargetId`); they only redirect the AI fix attempt that
   * runs against an already-failed task lineage.
   */
  editTaskFixContext(
    taskId: string,
    patch: { fixPrompt?: string; fixContext?: string },
  ): TaskState[] {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
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

    // Step 10 retry-class reset: restartTask is today's `retryTask`
    // compatibility wire (`buildInvalidationDeps` →
    // `orchestrator.restartTask`). It resets the task to `pending`,
    // clears volatile attempt state (`agentSessionId`, `containerId`,
    // transient `error`/`exitCode`/timing fields), and bumps
    // execution generation exactly once via
    // `withBumpedExecutionGeneration` while preserving branch /
    // workspacePath lineage — the chart's "retry from reverted
    // failed state" baseline for fix-context mutations.
    return this.retryTask(taskId);
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
  setTaskExternalGatePolicies(taskId: string, updates: ExternalGatePolicyUpdate[]): TaskState[] {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.status === 'running' || task.status === 'fixing_with_ai') {
      throw new Error(`Cannot edit running task ${taskId}`);
    }

    const deps = task.config.externalDependencies;
    if (!deps || deps.length === 0) {
      throw new Error(`Task ${taskId} has no external dependencies`);
    }
    if (!updates.length) return [];

    const keyOf = (workflowId: string, depTaskId?: string): string => {
      const normalizedTaskId = depTaskId?.trim() || '__merge__';
      return `${workflowId}::${normalizedTaskId}`;
    };

    const byKey = new Map<string, ExternalGatePolicyUpdate>();
    for (const update of updates) {
      if (update.gatePolicy !== 'completed' && update.gatePolicy !== 'review_ready') {
        throw new Error(`Invalid gatePolicy "${String(update.gatePolicy)}" for task ${taskId}`);
      }
      byKey.set(keyOf(update.workflowId, update.taskId), update);
    }

    let changed = 0;
    const nextDeps = deps.map((dep): ExternalDependency => {
      const update = byKey.get(keyOf(dep.workflowId, dep.taskId));
      if (!update) return dep;
      const current = dep.gatePolicy ?? 'review_ready';
      if (current === update.gatePolicy) return dep;
      changed += 1;
      return { ...dep, gatePolicy: update.gatePolicy };
    });

    if (changed === 0) return [];

    const policyChanges: TaskStateChanges = {
      config: { externalDependencies: nextDeps },
    };
    const policyUpdated = this.writeAndSync(taskId, policyChanges);
    const policyDelta: TaskDelta = this.buildUpdateDelta(task, policyUpdated, policyChanges);
    this.persistence.logEvent?.(taskId, 'task.external_dependency_policy_updated', {
      updates,
      changed,
    });
    this.messageBus.publish(TASK_DELTA_CHANNEL, policyDelta);

    // Re-evaluate and auto-start anything newly unblocked by this policy change.
    const started = this.autoStartExternallyUnblockedReadyTasks();
    this.checkWorkflowCompletion();
    return started;
  }

  forkWorkflow(workflowId: string, opts?: { autoStart?: boolean }): ForkWorkflowResult {
    this.refreshWorkflowFromDb(workflowId);

    const sourceTasks = this.stateMachine
      .getAllTasks()
      .filter((t) => t.config.workflowId === workflowId);
    if (sourceTasks.length === 0) {
      throw new Error(`forkWorkflow: workflow ${workflowId} not found (no tasks)`);
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
      if (typeof m.onFinish === 'string') baseSaveWf.onFinish = m.onFinish;
      if (typeof m.baseBranch === 'string') baseSaveWf.baseBranch = m.baseBranch;
      if (typeof m.featureBranch === 'string') baseSaveWf.featureBranch = m.featureBranch;
      if (m.mergeMode === 'manual' || m.mergeMode === 'automatic' || m.mergeMode === 'external_review') {
        baseSaveWf.mergeMode = m.mergeMode;
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
      { workflowId: newWfId, isMergeNode: true, executorType: 'merge' },
    );
    this.createAndSync(newMerge);
    this.messageBus.publish(TASK_DELTA_CHANNEL, { type: 'created', task: newMerge });

    this.reconcileMergeLeaves(newWfId);

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
    if (!task) throw new Error(`Task ${taskId} not found`);
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
      const rtExecutorType = normalizeExecutorType(rt.executorType) ?? task.config.executorType ?? 'worktree';
      const rtBase = {
        workflowId: wfId,
        command: rt.command,
        prompt: rt.prompt,
        executionAgent: rt.executionAgent ?? task.config.executionAgent,
      } as const;
      // Replacement tasks inherit executor config from the parent task.
      // The switch narrows the config so TS accepts the correct variant.
      let rtConfig: TaskConfig;
      switch (rtExecutorType) {
        case 'docker':
          rtConfig = {
            ...rtBase, executorType: 'docker',
            dockerImage: task.config.executorType === 'docker' ? task.config.dockerImage : undefined,
          };
          break;
        case 'ssh':
          rtConfig = {
            ...rtBase, executorType: 'ssh',
            remoteTargetId: task.config.executorType === 'ssh' ? task.config.remoteTargetId : undefined,
          };
          break;
        default:
          rtConfig = { ...rtBase, executorType: 'worktree' as const };
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
    return this.autoStartReadyTasks(rootIds);
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
    const workflows = this.persistence.listWorkflows();
    for (const wf of workflows) {
      this.activeWorkflowIds.add(wf.id);
      const tasks = this.persistence.loadTasks(wf.id);
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
  resumeWorkflow(workflowId: string): TaskState[] {
    this.syncFromDb(workflowId);
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
    this.scheduler.killAll();
  }

  /**
   * Delete a single workflow: DB first, then scheduler, memory, and publish removal deltas.
   * Follows the same DB→memory→publish pattern as writeAndSync().
   */
  deleteWorkflow(workflowId: string): void {
    // 1. Collect affected tasks before DB delete (needed for deltas and scheduler cleanup)
    const affectedTasks = this.stateMachine.getAllTasks().filter(
      (t) => t.config.workflowId === workflowId,
    );

    // 2. DB first — single source of truth
    this.persistence.deleteWorkflow?.(workflowId);

    // 3. Clean scheduler: free slots for all tasks in this workflow
    for (const task of affectedTasks) {
      this.clearQueuedSchedulerEntries(task.id, task.execution.selectedAttemptId);
    }

    // 4. Clear memory and reload remaining workflows
    this.activeWorkflowIds.delete(workflowId);
    this.stateMachine.clear();
    for (const wfId of this.activeWorkflowIds) {
      const tasks = this.persistence.loadTasks(wfId);
      for (const task of tasks) {
        this.stateMachine.restoreTask(task);
      }
    }

    // 5. Any surviving tasks that depended on this workflow externally can no
    // longer make progress; mark them blocked with an explicit reason.
    this.blockTasksMissingDeletedExternalWorkflow(workflowId);

    // 6. Publish removal deltas — drives UI cache cleanup via messageBus subscriber
    for (const task of affectedTasks) {
      this.messageBus.publish(TASK_DELTA_CHANNEL, this.buildRemoveDelta(task));
    }
  }

  /**
   * Delete all workflows: DB first, then scheduler, memory, and publish removal deltas.
   * Follows the same DB→memory→publish pattern as writeAndSync().
   */
  deleteAllWorkflows(): void {
    // 1. Collect all tasks before clearing (needed for deltas)
    const allTasks = this.stateMachine.getAllTasks();

    // 2. DB first
    this.persistence.deleteAllWorkflows?.();

    // 3. Clear scheduler
    this.scheduler.killAll();

    // 4. Clear memory
    this.activeWorkflowIds.clear();
    this.stateMachine.clear();

    // 5. Publish removal deltas
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

  getTask(taskId: string): TaskState | undefined {
    return this.stateGetTask(taskId);
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
    if (!task) throw new Error(`Task "${taskId}" not found`);

    const terminal = new Set(['completed', 'stale']);
    if (terminal.has(task.status)) {
      throw new Error(`Task "${taskId}" is already ${task.status}`);
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
          ? 'Cancelled by user'
          : `Cancelled: upstream task "${upstreamLabel}" was cancelled`;
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
      throw new Error(`No tasks found for workflow ${workflowId}`);
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

    // Transition running → pending
    const changes: TaskStateChanges = {
      status: 'pending',
      execution: { startedAt: undefined, lastHeartbeatAt: undefined },
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
    const queuedTasks = this.stateMachine
      .getReadyTasks()
      .filter((task) => task.status === 'pending')
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
      lastAgentSessionId?: string;
      lastAgentName?: string;
      branch?: string;
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
      execution.lastAgentName = task?.execution.agentName ?? task?.execution.lastAgentName;
    }
    if (parsed.branch !== undefined) {
      execution.branch = parsed.branch;
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
      protocolErrorCode?: string;
      protocolErrorMessage?: string;
      mergeConflict?: { failedBranch: string; conflictFiles: string[] };
    },
    eventName: string,
  ): TaskState[] {
    const existing = this.stateGetTask(taskId);
    if (!existing) {
      throw new Error(`finalizeFailedTask: task ${taskId} not found in graph`);
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
      executorType: parentTask?.config.executorType,
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
      this.syncWorkflowStatus(wfId);
    }
  }

  private autoStartReadyTasks(taskIds: string[], priority: number = 0): TaskState[] {
    for (const taskId of taskIds) {
      const task = this.stateGetTask(taskId);
      if (!task) continue;
      if (this.getExternalDependencyBlocker(task) !== undefined) continue;

      // Unblock: if a blocked task's deps are all complete, it's genuinely ready
      if (task.status === 'blocked') {
        this.logger.info('[orchestrator] autoStartReadyTasks: unblocking blocked task', {
          taskId,
        });
        this.writeAndSync(taskId, { status: 'pending' });
      }

      this.enqueueIfNotScheduled(taskId, priority);
    }

    return this.drainScheduler();
  }

  private enqueueIfNotScheduled(taskId: string, priority: number = 0): void {
    const task = this.stateGetTask(taskId);
    if (!task) return;

    const attemptId = this.ensureCurrentPendingAttempt(task);
    const currentAttempt = this.loadAttemptById(attemptId);
    if ((currentAttempt?.queuePriority ?? 0) !== priority) {
      this.taskRepository.updateAttempt(attemptId, { queuePriority: priority });
    }
    if (task.execution.selectedAttemptId === attemptId && this.isAttemptLeaseActive(currentAttempt)) {
      if (this.isTaskExecutionActive(task, currentAttempt)) {
        return;
      }
      try {
        this.taskRepository.updateAttempt(attemptId, { status: 'superseded' });
      } catch { /* best effort */ }
    }
    const queuedJob = this.scheduler
      .getQueuedJobs()
      .find((job) => job.attemptId === attemptId || job.taskId === taskId);
    if (queuedJob) {
      if (priority > queuedJob.priority) {
        this.scheduler.removeJob(queuedJob.attemptId ?? queuedJob.taskId);
        this.scheduler.enqueue({ taskId, attemptId, priority });
      }
      return;
    }
    this.scheduler.enqueue({ taskId, attemptId, priority });
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
   * Was `private` before Step 15; exposed publicly so
   * `applyInvalidation`'s `'scheduleOnly'` dep can invoke it
   * type-safely. No other behavior changes.
   */
  autoStartExternallyUnblockedReadyTasks(): TaskState[] {
    const readyTasks = this.stateMachine
      .getReadyTasks()
      .filter((task) => (task.config.externalDependencies?.length ?? 0) > 0)
      .filter((task) => this.getExternalDependencyBlocker(task) === undefined);

    for (const task of readyTasks) {
      this.enqueueIfNotScheduled(task.id);
    }
    return this.drainScheduler();
  }

  private autoStartUnblockedTasks(): TaskState[] {
    for (const task of this.stateMachine.getAllTasks()) {
      if (task.status !== 'blocked') continue;
      if (!this.areLocalDependenciesSatisfied(task)) continue;
      if (this.getExternalDependencyBlocker(task) !== undefined) continue;

      this.writeAndSync(task.id, { status: 'pending' });
      this.enqueueIfNotScheduled(task.id);
    }
    return this.drainScheduler();
  }

  private areLocalDependenciesSatisfied(task: TaskState): boolean {
    return task.dependencies.every((depId) => {
      const dep = this.stateGetTask(depId);
      if (!dep) return false;
      if (task.config?.isReconciliation) {
        return dep.status === 'completed' || dep.status === 'failed' || dep.status === 'stale';
      }
      return dep.status === 'completed' || dep.status === 'stale';
    });
  }

  private externalDependencyDisplayId(workflowId: string, taskId?: string): string {
    const normalizedTaskId = taskId?.trim() || '__merge__';
    if (normalizedTaskId.includes('/')) return normalizedTaskId;
    if (normalizedTaskId === '__merge__') return `__merge__${workflowId}`;
    return `${workflowId}/${normalizedTaskId}`;
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

  private getExternalDependencyBlocker(task: TaskState): string | undefined {
    const deps = task.config.externalDependencies;
    if (!deps || deps.length === 0) return undefined;

    for (const dep of deps) {
      const prerequisite = this.findExternalDependencyTask(dep.workflowId, dep.taskId);
      const depDisplayId = this.externalDependencyDisplayId(dep.workflowId, dep.taskId);
      if (!prerequisite) {
        return `missing prerequisite ${depDisplayId}`;
      }
      const required = dep.requiredStatus ?? 'completed';
      const gatePolicy = dep.gatePolicy ?? 'review_ready';
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

  private blockTasksMissingDeletedExternalWorkflow(deletedWorkflowId: string): void {
    const tasks = this.stateMachine.getAllTasks();
    for (const task of tasks) {
      if (task.status !== 'pending' && task.status !== 'blocked') continue;
      const deps = task.config.externalDependencies ?? [];
      if (!deps.some((dep) => dep.workflowId === deletedWorkflowId)) continue;

      const blocker = this.getExternalDependencyBlocker(task);
      if (blocker === undefined) continue;

      const changes: TaskStateChanges = {
        status: 'blocked',
        execution: { blockedBy: blocker },
      };
      const blockUpdated = this.writeAndSync(task.id, changes);
      this.scheduler.removeJob(task.id);
      const delta: TaskDelta = this.buildUpdateDelta(task, blockUpdated, changes);
      this.persistence.logEvent?.(task.id, 'task.blocked', changes);
      this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
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
      const task = this.stateGetTask(job.taskId);
      this.logger.info('[orchestrator] drainScheduler: dequeued', {
        taskId: job.taskId,
        actualStatus: task?.status ?? 'NOT_FOUND',
      });
      if (!task || task.status !== 'pending') {
        this.logger.info('[orchestrator] drainScheduler: skipping non-pending task', {
          taskId: job.taskId,
        });
        job = this.scheduler.takeNext();
        continue;
      }

      const now = new Date();
      const attemptId = job.attemptId ?? this.ensureCurrentPendingAttempt(task);
      if (task.execution.selectedAttemptId !== attemptId) {
        this.writeAndSync(job.taskId, { execution: { selectedAttemptId: attemptId } });
      }
      const currentAttempt = this.loadAttemptById(attemptId);
      if (this.isAttemptLeaseActive(currentAttempt, now.getTime())) {
        if (this.isTaskExecutionActive(task, currentAttempt, now.getTime())) {
          job = availableSlots > 0 ? this.scheduler.takeNext() : null;
          continue;
        }
        try {
          this.taskRepository.updateAttempt(attemptId, { status: 'superseded' });
        } catch { /* best effort */ }
      }

      const changes: TaskStateChanges = {
        status: 'running',
        execution: {
          selectedAttemptId: attemptId,
          generation: this.getExecutionGeneration(task),
          startedAt: now,
          lastHeartbeatAt: now,
          phase: 'launching',
          launchStartedAt: now,
          launchCompletedAt: undefined,
        },
      };
      const updated = this.writeAndSync(job.taskId, changes);
      this.persistence.logEvent?.(job.taskId, 'task.running', changes);
      this.messageBus.publish(TASK_DELTA_CHANNEL, this.buildUpdateDelta(task, updated, changes));
      started.push(updated);
      this.logger.info('[orchestrator] drainScheduler: started', {
        taskId: job.taskId,
        attemptId,
        phase: 'launching',
        generation: changes.execution?.generation ?? 'unknown',
      });

      try {
        const existingAttempt = this.persistence.loadAttempt(attemptId);
        if (existingAttempt) {
          this.taskRepository.updateAttempt(attemptId, this.deferRunningUntilLaunch
            ? {
                status: 'claimed',
                claimedAt: now,
                lastHeartbeatAt: now,
                leaseExpiresAt: nextLeaseExpiry(now),
              }
            : {
                status: 'running',
                claimedAt: existingAttempt.claimedAt ?? now,
                startedAt: now,
                lastHeartbeatAt: now,
                leaseExpiresAt: nextLeaseExpiry(now),
              });
        } else {
          const upstreamAttemptIds = task.dependencies
            .map(depId => this.stateGetTask(depId)?.execution.selectedAttemptId)
            .filter((id): id is string => !!id);
          const attempt = createAttempt(job.taskId, this.deferRunningUntilLaunch
            ? {
                status: 'claimed',
                claimedAt: now,
                lastHeartbeatAt: now,
                leaseExpiresAt: nextLeaseExpiry(now),
                upstreamAttemptIds,
              }
            : {
                status: 'running',
                claimedAt: now,
                startedAt: now,
                lastHeartbeatAt: now,
                leaseExpiresAt: nextLeaseExpiry(now),
                upstreamAttemptIds,
              });
          this.taskRepository.saveAttempt(attempt);
          this.writeAndSync(job.taskId, { execution: { selectedAttemptId: attempt.id } });
        }
      } catch { /* best effort — never break existing flow */ }

      availableSlots -= 1;
      job = availableSlots > 0 ? this.scheduler.takeNext() : null;
    }
    if (started.length > 0) {
      try {
        this.taskDispatcher?.(started);
      } catch (err) {
        this.logger.error('[orchestrator] taskDispatcher threw', { err });
      }
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
    if (selectedAttemptId && selectedAttemptId !== attemptId) {
      this.logger.info('[orchestrator] markTaskRunningAfterLaunch: reject', {
        taskId,
        attemptId,
        reason: 'attempt_mismatch',
        selectedAttemptId,
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
      const existingAttempt = this.persistence.loadAttempt(attemptId);
      if (existingAttempt) {
        this.taskRepository.updateAttempt(attemptId, {
          status: 'running',
          claimedAt: existingAttempt.claimedAt ?? launchedAt,
          startedAt: launchedAt,
          lastHeartbeatAt: launchedAt,
          leaseExpiresAt: nextLeaseExpiry(launchedAt),
        });
      } else {
        const upstreamAttemptIds = task.dependencies
          .map(depId => this.stateGetTask(depId)?.execution.selectedAttemptId)
          .filter((id): id is string => !!id);
        const attempt = createAttempt(taskId, {
          status: 'running',
          claimedAt: launchedAt,
          startedAt: launchedAt,
          lastHeartbeatAt: launchedAt,
          leaseExpiresAt: nextLeaseExpiry(launchedAt),
          upstreamAttemptIds,
        });
        this.taskRepository.saveAttempt(attempt);
        this.writeAndSync(taskId, { execution: { selectedAttemptId: attempt.id } });
      }
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
