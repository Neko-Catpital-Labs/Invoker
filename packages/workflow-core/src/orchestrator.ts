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
import type { TaskState, TaskDelta, TaskStateChanges, TaskConfig, Attempt, ExternalDependency } from '@invoker/workflow-graph';
import type { ExecutorType } from '@invoker/workflow-graph';
import { createTaskState, createAttempt } from '@invoker/workflow-graph';
import type { WorkResponse } from '@invoker/contracts';
import { normalizeExecutorType } from '@invoker/workflow-graph';

const MERGE_TRACE_LOG = resolve(homedir(), '.invoker', 'merge-trace.log');
function mergeTrace(tag: string, data: Record<string, unknown>): void {
  try {
    mkdirSync(resolve(homedir(), '.invoker'), { recursive: true });
    appendFileSync(MERGE_TRACE_LOG, `${new Date().toISOString()} [merge-trace:orchestrator] ${tag} ${JSON.stringify(data)}\n`);
  } catch { /* best effort */ }
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
  /** Load a workflow by ID (needed for SSH validation in editTaskType). */
  loadWorkflow?(workflowId: string): { repoUrl?: string; baseBranch?: string } | undefined;
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

  constructor(config: OrchestratorConfig) {
    this.maxConcurrency = config.maxConcurrency ?? 3;
    this.persistence = config.persistence;
    this.messageBus = config.messageBus;
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
    };
    if (process.env.NODE_ENV !== 'test' && TRACE_PERSIST_SYNC) {
      const ex = updated.execution;
      const execKeys = changes.execution ? Object.keys(changes.execution).join(',') : '';
      console.log(
        `[persist-sync] taskId=${id} resolvedStatus=${updated.status} ` +
          `isFixingWithAI=${ex.isFixingWithAI === true ? '1' : '0'} exitCode=${ex.exitCode ?? 'null'} ` +
          `errorLen=${ex.error?.length ?? 0} pendingFix=${ex.pendingFixError ? '1' : '0'} ` +
          `inputPrompt=${ex.inputPrompt ? '1' : '0'} changeStatus=${changes.status ?? '—'} execKeys=${execKeys || '—'}`,
      );
    }
    this.stateMachine.restoreTask(updated);
    if (!opts?.skipWorkflowStatusSync && changes.status !== undefined && existing.config.workflowId) {
      this.syncWorkflowStatus(existing.config.workflowId);
    }
    return updated;
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
        this.writeAndSync(id, changesWithGeneration, { skipWorkflowStatusSync: true });
        const priorAttemptId = current.execution.selectedAttemptId;
        this.replaceSelectedAttempt(current, {}, { skipWorkflowStatusSync: true });
        this.persistence.logEvent?.(id, 'task.pending', changesWithGeneration);
        pendingTaskDeltas.push({
          type: 'updated',
          taskId: id,
          changes: changesWithGeneration,
        });

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
    console.log(
      `[orchestrator] startExecution: ready=${readyTasks.length} active=${activeAttempts} maxConcurrency=${this.maxConcurrency} ` +
        `readyIds=[${readyTasks.map((task) => task.id).join(', ')}]`,
    );
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
            console.warn(
              `[worker-response] STALE_ATTEMPT_REJECTED taskId=${earlyTask.id} ` +
                `responseAttemptId=${response.attemptId} activeAttemptId=${activeAttemptId ?? 'none'} ` +
                `workerResponseStatus=${response.status}`,
            );
            return [];
          }
        }
        const activeGeneration = this.getExecutionGeneration(earlyTask);
        if (
          !response.attemptId &&
          response.executionGeneration !== undefined &&
          response.executionGeneration !== activeGeneration
        ) {
          console.warn(
            `[worker-response] STALE_GENERATION_REJECTED taskId=${earlyTask.id} ` +
              `responseGeneration=${response.executionGeneration} activeGeneration=${activeGeneration} ` +
              `workerResponseStatus=${response.status}`,
          );
          return [];
        }
      }
      if (earlyTask) {
        const executableStatuses = new Set(['running', 'fixing_with_ai']);
        if (!executableStatuses.has(earlyTask.status)) {
          console.warn(
            `[orchestrator] handleWorkerResponse: ignoring "${response.status}" for non-executable ` +
              `task "${response.actionId}" (status=${earlyTask.status})`,
          );
          return [];
        }
      }
    }

    const parsed = this.responseHandler.parseResponse(response);
    if (!('type' in parsed)) {
      const parseErr = 'error' in parsed ? (parsed as { error: string }).error : 'unknown';
      const task = this.stateGetTask(response.actionId);

      if (!task) {
        console.warn(
          `[worker-response] PROTOCOL_FAILURE_UNKNOWN_TASK actionId=${response.actionId} parseError=${parseErr}`,
        );
        return [];
      }

      const canonicalTaskId = task.id;
      console.warn(
        `[worker-response] PROTOCOL_FAILURE taskId=${canonicalTaskId} parseError=${parseErr}`,
      );
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
      console.warn(`[worker-response] task not in graph taskId=${taskId} (stale response?)`);
      return [];
    }

    const canonicalTaskId = task.id;
    if (process.env.NODE_ENV !== 'test' && TRACE_WORKER_RESPONSE) {
      console.log(
        `[worker-response] write path parsedType=${parsed.type} taskId=${canonicalTaskId} ` +
          `graphStatusBefore=${task.status} workerResponseStatus=${response.status} ` +
          `executionGeneration=${response.executionGeneration}`,
      );
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
    this.writeAndSync(id, changes);
    if (task.execution.selectedAttemptId) {
      this.taskRepository.updateAttempt(task.execution.selectedAttemptId, { status: 'running' });
    }
    const delta: TaskDelta = { type: 'updated', taskId: id, changes };
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
      console.log(
        `[merge-gate-workspace] setTask${status === 'review_ready' ? 'ReviewReady' : 'AwaitingApproval'} mergeNode=${id} ` +
          `execution.workspacePath=${changes.execution.workspacePath ?? 'NULL'}`,
      );
    }
    this.writeAndSync(id, changes);
    this.updateSelectedAttempt(id, {
      status: 'needs_input',
      completedAt: changes.execution?.completedAt,
      ...(changes.config?.summary !== undefined ? { summary: changes.config.summary } : {}),
      ...(changes.execution?.branch !== undefined ? { branch: changes.execution.branch } : {}),
      ...(changes.execution?.commit !== undefined ? { commit: changes.execution.commit } : {}),
      ...(changes.execution?.workspacePath !== undefined ? { workspacePath: changes.execution.workspacePath } : {}),
      ...(keepAgentSessionId !== undefined ? { agentSessionId: keepAgentSessionId } : {}),
    });
    const delta: TaskDelta = { type: 'updated', taskId: id, changes };
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
    console.log(`[setFixAwaitingApproval] taskId=${tid} agentSessionId=${task.execution.agentSessionId}`);
    if (task.config.isMergeNode) {
      console.log(
        `[merge-gate-workspace] setFixAwaitingApproval mergeNode=${tid} ` +
          `workspacePath unchanged by this call; current=${task.execution.workspacePath ?? 'none'}`,
      );
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
    console.log(`[setFixAwaitingApproval] delta.changes.execution=`, JSON.stringify(changes.execution));
    this.writeAndSync(tid, changes);
    this.updateSelectedAttempt(tid, {
      status: 'needs_input',
      error: originalError,
      agentSessionId: task.execution.agentSessionId,
    });
    const delta: TaskDelta = { type: 'updated', taskId: tid, changes };
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
      console.log(
        `[orchestrator.approve] skipped taskId=${taskId} ` +
          (!task ? '(task not found)' : `(status=${task.status}, expected awaiting_approval|review_ready)`),
      );
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
    this.writeAndSync(taskId, changes);
    this.updateSelectedAttempt(taskId, {
      status: 'completed',
      completedAt: changes.execution?.completedAt,
    });
    const delta: TaskDelta = { type: 'updated', taskId, changes };
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
    this.writeAndSync(taskId, changes);
    this.updateSelectedAttempt(taskId, {
      status: 'running',
      startedAt: now,
      lastHeartbeatAt: now,
    });
    const delta: TaskDelta = { type: 'updated', taskId, changes };
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
    this.writeAndSync(taskId, changes);
    this.updateSelectedAttempt(taskId, {
      status: 'failed',
      error: reason ?? 'Rejected',
      completedAt: changes.execution?.completedAt,
    });
    const delta: TaskDelta = { type: 'updated', taskId, changes };
    this.persistence.logEvent?.(taskId, 'task.failed', changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);

    this.checkWorkflowCompletion();
  }

  /**
   * Select a winning experiment for a reconciliation task.
   */
  selectExperiment(taskId: string, experimentId: string): TaskState[] {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task || !task.config.isReconciliation) return [];
    const reconId = task.id;

    const winner = this.stateGetTask(experimentId);
    const winnerId = winner?.id ?? experimentId;
    const changes: TaskStateChanges = {
      status: 'completed',
      execution: {
        selectedExperiment: winnerId,
        completedAt: new Date(),
        branch: winner?.execution.branch,
        commit: winner?.execution.commit,
      },
    };
    this.writeAndSync(reconId, changes);
    this.updateSelectedAttempt(reconId, {
      status: 'completed',
      completedAt: changes.execution?.completedAt,
      branch: winner?.execution.branch,
      commit: winner?.execution.commit,
    });
    const delta: TaskDelta = { type: 'updated', taskId: reconId, changes };
    this.persistence.logEvent?.(reconId, 'task.completed', changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);

    const readyTaskIds = this.stateMachine.findNewlyReadyTasks(reconId);
    console.log(`[orchestrator] selectExperiment "${reconId}": ${readyTaskIds.length} newly ready: [${readyTaskIds.join(', ')}]`);
    const started = this.autoStartReadyTasks(readyTaskIds);
    this.checkWorkflowCompletion();
    return started;
  }

  /**
   * Select multiple winning experiments for a reconciliation task.
   * For a single experiment, delegates to selectExperiment.
   * For multiple, uses the provided combined branch/commit from the merged result.
   */
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
    this.writeAndSync(reconId, changes);
    this.updateSelectedAttempt(reconId, {
      status: 'completed',
      completedAt: changes.execution?.completedAt,
      branch: combinedBranch,
      commit: combinedCommit,
    });
    const delta: TaskDelta = { type: 'updated', taskId: reconId, changes };
    this.persistence.logEvent?.(reconId, 'task.completed', changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);

    const readyTaskIds = this.stateMachine.findNewlyReadyTasks(reconId);
    console.log(`[orchestrator] selectExperiments "${reconId}": ${readyTaskIds.length} newly ready: [${readyTaskIds.join(', ')}]`);
    const started = this.autoStartReadyTasks(readyTaskIds);
    this.checkWorkflowCompletion();
    return started;
  }

  /**
   * Restart a non-running task: reset it to pending, unblock dependents,
   * and auto-start if its own dependencies are satisfied.
   */
  restartTask(taskId: string): TaskState[] {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    const id = task.id;

    const prevStatus = task.status;
    console.log(`[orchestrator] restartTask "${id}" (was ${prevStatus})`);
    if (task.config.isMergeNode) {
      console.log(
        `[merge-gate-workspace] restartTask mergeNode=${id} ` +
          `before reset workspacePath=${task.execution.workspacePath ?? 'none'} ` +
          '(restartTask does not clear workspacePath)',
      );
      mergeTrace('GATE_WS_RESTART_TASK_MERGE', {
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
    console.log(
      `[agent-session-trace] restartTask: before writeAndSync task="${id}" agentSessionId=${t0.execution.agentSessionId ?? 'null'} ` +
        '(reset clears agentSessionId/containerId; branch/workspacePath unchanged)',
    );
    const { affectedIds } = this.resetSubgraphToPending([id], resetChanges, {
      forceResetIds: new Set([id]),
    });
    const afterRt = this.stateGetTask(id)!;
    console.log(
      `[agent-session-trace] restartTask: after writeAndSync task="${id}" agentSessionId=${afterRt.execution.agentSessionId ?? 'null'}`,
    );
    if (afterRt.config.isMergeNode) {
      console.log(
        `[merge-gate-workspace] restartTask mergeNode=${id} ` +
          `after reset workspacePath=${afterRt.execution.workspacePath ?? 'none'}`,
      );
      mergeTrace('GATE_WS_RESTART_TASK_MERGE_AFTER', {
        taskId: id,
        workspacePathAfter: afterRt.execution.workspacePath ?? null,
      });
    }
    if (affectedIds.length > 1) {
      console.log(
        `[orchestrator] restartTask "${id}": invalidated ${affectedIds.length - 1} downstream task(s)`,
      );
    }

    const readyTasks = this.stateMachine.getReadyTasks();
    const isReady = readyTasks.some((t) => t.id === id);
    console.log(`[orchestrator] restartTask "${id}": ready=${isReady}`);
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
          this.writeAndSync(id, blockedChanges);
          const blockedDelta: TaskDelta = { type: 'updated', taskId: id, changes: blockedChanges };
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

    const allTasks = this.stateMachine.getAllTasks().filter(
      (t) => t.config.workflowId === workflowId,
    );
    if (allTasks.length === 0) throw new Error(`No tasks found for workflow ${workflowId}`);

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

    console.log(
      `[orchestrator] retryWorkflow invalidation: workflow=${workflowId} ` +
      `roots=[${retryRootIds.join(', ')}] affected=${affectedIds.length}`,
    );
    console.log(
      `[orchestrator] retryWorkflow: reset ${affectedIds.length}/${allTasks.length} tasks for ${workflowId} ` +
        `(roots=${retryRootIds.length}, preserved completed outside invalidated subgraphs)`,
    );

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
    console.log(
      `[orchestrator] retryWorkflow timing workflow=${workflowId} ` +
        `refreshMs=${afterRefreshMs - retryStartMs} resetMs=${afterResetMs - afterRefreshMs} ` +
        `enqueueDrainMs=${retryEndMs - afterResetMs} totalMs=${retryEndMs - retryStartMs} started=${started.length}`,
    );
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

    console.log(
      `[orchestrator] recreateTask: resetting ${toResetIds.length} task(s) rooted at ${rootId}`,
    );

    for (const id of toResetIds) {
      const current = this.stateGetTask(id);
      if (!current) continue;
      const changesWithGeneration = this.withBumpedExecutionGeneration(current, resetChanges);
      this.writeAndSync(id, changesWithGeneration);
      const priorAttemptId = current.execution.selectedAttemptId;
      this.replaceSelectedAttempt(current);
      this.persistence.logEvent?.(id, 'task.pending', changesWithGeneration);
      this.messageBus.publish(TASK_DELTA_CHANNEL, { type: 'updated', taskId: id, changes: changesWithGeneration });

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

    console.log(`[orchestrator] recreateWorkflow: resetting ${allTasks.length} tasks for workflow ${workflowId}`);
    console.log(
      '[agent-session-trace] recreateWorkflow: resetChanges.execution clears agentSessionId/containerId (DB NULL before next run)',
    );
    for (const task of allTasks) {
      const prevSess = task.execution.agentSessionId ?? null;
      const prevCt = task.execution.containerId ?? null;
      if (task.config.isMergeNode) {
        console.log(
          `[merge-gate-workspace] recreateWorkflow mergeNode=${task.id} ` +
            `will clear workspace_path (was ${task.execution.workspacePath ?? 'NULL'})`,
        );
        mergeTrace('GATE_WS_RESTART_WORKFLOW_MERGE', {
          taskId: task.id,
          workspacePathBefore: task.execution.workspacePath ?? null,
        });
      }
      console.log(`[orchestrator]   reset "${task.id}" (was ${task.status}, branch=${task.execution.branch ?? 'none'}, commit=${task.execution.commit?.slice(0, 7) ?? 'none'})`);
      console.log(
        `[agent-session-trace] recreateWorkflow: before writeAndSync task="${task.id}" agentSessionId=${prevSess ?? 'null'} containerId=${prevCt ?? 'null'}`,
      );
      const changesWithGeneration = this.withBumpedExecutionGeneration(task, resetChanges);
      const after = this.writeAndSync(task.id, changesWithGeneration);
      const priorAttemptId = task.execution.selectedAttemptId;
      this.replaceSelectedAttempt(task);
      console.log(
        `[agent-session-trace] recreateWorkflow: after writeAndSync task="${task.id}" agentSessionId=${after.execution.agentSessionId ?? 'null'} containerId=${after.execution.containerId ?? 'null'}`,
      );
      const delta: TaskDelta = { type: 'updated', taskId: task.id, changes: changesWithGeneration };
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
    this.writeAndSync(taskId, changesWithGeneration);
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
    const delta: TaskDelta = { type: 'updated', taskId: id, changes: changesWithGeneration };
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
    this.writeAndSync(taskId, changes);
    this.updateSelectedAttempt(taskId, {
      status: 'failed',
      error: displayError,
      mergeConflict,
      completedAt,
    });
    const delta: TaskDelta = { type: 'updated', taskId: id, changes };
    this.persistence.logEvent?.(id, 'task.failed', changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
  }

  /**
   * Edit a task's command, fork its downstream subtree, and restart it.
   */
  editTaskCommand(taskId: string, newCommand: string): TaskState[] {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.config.isMergeNode) throw new Error(`Cannot edit merge node ${taskId}`);
    if (task.status === 'running' || task.status === 'fixing_with_ai') throw new Error(`Cannot edit running task ${taskId}`);

    const cmdChanges: TaskStateChanges = { config: { command: newCommand } };
    this.writeAndSync(taskId, cmdChanges);
    const cmdDelta: TaskDelta = { type: 'updated', taskId, changes: cmdChanges };
    this.persistence.logEvent?.(taskId, 'task.updated', cmdChanges);
    this.messageBus.publish(TASK_DELTA_CHANNEL, cmdDelta);

    return this.restartTask(taskId);
  }

  /**
   * Change a task's executor type (executorType) and restart it.
   * Does NOT fork the dirty subtree.
   */
  editTaskType(taskId: string, executorType: string, remoteTargetId?: string): TaskState[] {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.config.isMergeNode) throw new Error(`Cannot change executor type of merge node ${taskId}`);
    if (task.status === 'running' || task.status === 'fixing_with_ai') throw new Error(`Cannot edit running task ${taskId}`);

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

    const configPatch: Record<string, unknown> = { executorType: effectiveType };
    if (effectiveType === 'ssh') {
      configPatch.remoteTargetId = remoteTargetId;
    } else {
      configPatch.remoteTargetId = undefined;
    }
    const typeChanges: TaskStateChanges = { config: configPatch };
    this.writeAndSync(taskId, typeChanges);
    const typeDelta: TaskDelta = { type: 'updated', taskId, changes: typeChanges };
    this.persistence.logEvent?.(taskId, 'task.updated', typeChanges);
    this.messageBus.publish(TASK_DELTA_CHANNEL, typeDelta);

    return this.restartTask(taskId);
  }

  /**
   * Change a task's execution agent (e.g. 'claude' → 'codex') and restart it.
   */
  editTaskAgent(taskId: string, agentName: string): TaskState[] {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.config.isMergeNode) throw new Error(`Cannot change execution agent of merge node ${taskId}`);
    if (task.status === 'running' || task.status === 'fixing_with_ai') throw new Error(`Cannot edit running task ${taskId}`);

    const agentChanges: TaskStateChanges = { config: { executionAgent: agentName } };
    this.writeAndSync(taskId, agentChanges);
    const agentDelta: TaskDelta = { type: 'updated', taskId, changes: agentChanges };
    this.persistence.logEvent?.(taskId, 'task.updated', agentChanges);
    this.messageBus.publish(TASK_DELTA_CHANNEL, agentDelta);

    return this.restartTask(taskId);
  }

  /**
   * Update gate policy on one or more external dependencies for a task, then
   * immediately re-evaluate ready tasks that were blocked by external deps.
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
    this.writeAndSync(taskId, policyChanges);
    const policyDelta: TaskDelta = { type: 'updated', taskId, changes: policyChanges };
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
      const staleChanges: TaskStateChanges = { status: 'stale' };
      this.writeAndSync(id, staleChanges);
      this.updateSelectedAttempt(id, { status: 'superseded' });
      this.persistence.logEvent?.(id, 'task.stale', staleChanges);
      this.messageBus.publish(TASK_DELTA_CHANNEL, {
        type: 'updated', taskId: id, changes: staleChanges,
      });
      const current = this.stateGetTask(id);
      this.clearQueuedSchedulerEntries(id, current?.execution.selectedAttemptId);
    }
    const sourceChanges: TaskStateChanges = { status: 'stale' };
    this.writeAndSync(sourceId, sourceChanges);
    this.updateSelectedAttempt(sourceId, { status: 'superseded' });
    this.persistence.logEvent?.(sourceId, 'task.stale', sourceChanges);
    this.messageBus.publish(TASK_DELTA_CHANNEL, {
      type: 'updated', taskId: sourceId, changes: sourceChanges,
    });
    this.clearQueuedSchedulerEntries(sourceId, this.stateGetTask(sourceId)?.execution.selectedAttemptId);

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
      const delta: TaskDelta = { type: 'removed', taskId: task.id };
      this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
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
      const delta: TaskDelta = { type: 'removed', taskId: task.id };
      this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
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
      this.writeAndSync(id, changes);
      this.updateSelectedAttempt(id, {
        status: 'failed',
        error: errorMsg,
        completedAt: changes.execution?.completedAt,
      });
      const delta: TaskDelta = { type: 'updated', taskId: id, changes };
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
      this.writeAndSync(id, changes);
      this.updateSelectedAttempt(id, {
        status: 'failed',
        error: 'Cancelled by user (workflow)',
        completedAt: changes.execution?.completedAt,
      });
      this.persistence.logEvent?.(id, 'task.cancelled', changes);
      this.messageBus.publish(TASK_DELTA_CHANNEL, { type: 'updated', taskId: id, changes });
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
    this.writeAndSync(id, changes);
    const delta: TaskDelta = { type: 'updated', taskId: id, changes };
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
    this.writeAndSync(taskId, changes);
    const delta: TaskDelta = { type: 'updated', taskId, changes };
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
    console.log(`[orchestrator] handleCompleted "${taskId}": ${readyTaskIds.length} newly ready: [${readyTaskIds.join(', ')}]`);
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
    };
    this.stateMachine.restoreTask(updated);

    const delta: TaskDelta = { type: 'updated', taskId, changes };
    this.persistence.logEvent?.(taskId, eventName, changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);

    this.checkExperimentCompletion(taskId);

    const readyTaskIds = this.stateMachine.findNewlyReadyTasks(taskId);
    console.log(
      `[orchestrator] finalizeFailedTask "${taskId}" (${eventName}): ${readyTaskIds.length} newly ready: [${readyTaskIds.join(', ')}]`,
    );
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
    this.writeAndSync(taskId, changes);
    const currentAttemptId = this.stateGetTask(taskId)?.execution.selectedAttemptId;
    if (currentAttemptId) {
      this.taskRepository.updateAttempt(currentAttemptId, { status: 'needs_input' });
    }
    const delta: TaskDelta = { type: 'updated', taskId, changes };
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
      console.warn(`[orchestrator] handleSpawnExperiments: task "${taskId}" has no workflowId; skipping`);
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
        this.writeAndSync(recon.id, reconChanges);
        const delta: TaskDelta = { type: 'updated', taskId: recon.id, changes: reconChanges };
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
        console.log(`[orchestrator] autoStartReadyTasks: unblocking "${taskId}" (was blocked, deps now satisfied)`);
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

  private autoStartExternallyUnblockedReadyTasks(): TaskState[] {
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
      this.writeAndSync(task.id, changes);
      this.scheduler.removeJob(task.id);
      const delta: TaskDelta = { type: 'updated', taskId: task.id, changes };
      this.persistence.logEvent?.(task.id, 'task.blocked', changes);
      this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
    }
  }

  /** Drain the scheduler queue, starting tasks that fit the concurrency limit. */
  private drainScheduler(): TaskState[] {
    const started: TaskState[] = [];
    const activeAttempts = this.countActivePersistedAttempts();
    let availableSlots = Math.max(0, this.maxConcurrency - activeAttempts);
    console.log(
      `[orchestrator] drainScheduler: begin active=${activeAttempts} maxConcurrency=${this.maxConcurrency} availableSlots=${availableSlots}`,
    );
    let job = availableSlots > 0 ? this.scheduler.takeNext() : null;
    while (job && availableSlots > 0) {
      const task = this.stateGetTask(job.taskId);
      console.log(`[orchestrator] drainScheduler: dequeued "${job.taskId}" actual status=${task?.status ?? 'NOT_FOUND'}`);
      if (!task || task.status !== 'pending') {
        console.log(`[orchestrator] drainScheduler: SKIPPING "${job.taskId}" — not pending`);
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
      this.messageBus.publish(TASK_DELTA_CHANNEL, {
        type: 'updated',
        taskId: job.taskId,
        changes,
      });
      started.push(updated);
      console.log(
        `[orchestrator] drainScheduler: started "${job.taskId}" attempt=${attemptId} phase=launching generation=${changes.execution?.generation ?? 'unknown'}`,
      );

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
        console.error('[orchestrator] taskDispatcher threw:', err);
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
      console.log(`[orchestrator] markTaskRunningAfterLaunch: REJECT task="${taskId}" attempt=${attemptId} reason=not_found`);
      this.clearQueuedSchedulerEntries(taskId, attemptId);
      return false;
    }

    const selectedAttemptId = task.execution.selectedAttemptId;
    if (selectedAttemptId && selectedAttemptId !== attemptId) {
      console.log(
        `[orchestrator] markTaskRunningAfterLaunch: REJECT task="${taskId}" attempt=${attemptId} reason=attempt_mismatch selected=${selectedAttemptId}`,
      );
      this.clearQueuedSchedulerEntries(taskId, attemptId);
      return false;
    }

    if (task.status !== 'running' && task.status !== 'pending' && task.status !== 'fixing_with_ai') {
      console.log(
        `[orchestrator] markTaskRunningAfterLaunch: REJECT task="${taskId}" attempt=${attemptId} reason=invalid_status status=${task.status}`,
      );
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

      this.writeAndSync(taskId, changes);
      this.persistence.logEvent?.(taskId, 'task.running', changes);
      this.messageBus.publish(TASK_DELTA_CHANNEL, {
        type: 'updated',
        taskId,
        changes,
      });
      console.log(
        `[orchestrator] markTaskRunningAfterLaunch: EXECUTING task="${taskId}" attempt=${attemptId} previousStatus=${task.status}`,
      );
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

    console.log(`[orchestrator] markTaskRunningAfterLaunch: OK task="${taskId}" attempt=${attemptId}`);
    return true;
  }
}
