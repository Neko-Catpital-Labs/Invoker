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
import { ResourceEstimator } from './resource-estimator.js';
import type { UtilizationRule } from './resource-estimator.js';
import type { TaskState, TaskDelta, TaskStateChanges, Attempt } from './task-types.js';
import { createTaskState, createAttempt } from './task-types.js';
import type { WorkResponse } from '@invoker/protocol';
import { normalizeFamiliarType } from '@invoker/graph';

const MERGE_TRACE_LOG = resolve(homedir(), '.invoker', 'merge-trace.log');
function mergeTrace(tag: string, data: Record<string, unknown>): void {
  try {
    mkdirSync(resolve(homedir(), '.invoker'), { recursive: true });
    appendFileSync(MERGE_TRACE_LOG, `${new Date().toISOString()} [merge-trace:orchestrator] ${tag} ${JSON.stringify(data)}\n`);
  } catch { /* best effort */ }
}
import { getTransitiveDependents } from './dag.js';
import { ActionGraph } from '@invoker/graph';
import { reconcileMergeLeavesImpl, applyGraphMutationImpl } from './graph-mutation.js';
import type { GraphMutationHost } from './graph-mutation.js';
import { buildPlanLocalToScopedIdMap, scopePlanTaskId } from './task-id-scope.js';

// ── Channel Constants ───────────────────────────────────────

const TASK_DELTA_CHANNEL = 'task.delta';
let workflowCounter = 0;

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
  updateAttempt(attemptId: string, changes: Partial<Pick<Attempt, 'status' | 'startedAt' | 'completedAt' | 'exitCode' | 'error' | 'lastHeartbeatAt' | 'branch' | 'commit' | 'summary' | 'workspacePath' | 'agentSessionId' | 'containerId' | 'mergeConflict'>>): void;
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
    pivot?: boolean;
    experimentVariants?: Array<{ id: string; description: string; prompt?: string; command?: string }>;
    requiresManualApproval?: boolean;
    featureBranch?: string;
    familiarType?: string;
    autoFix?: boolean;
    dockerImage?: string;
    remoteTargetId?: string;
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
  familiarType?: string;
  isReconciliation?: boolean;
  requiresManualApproval?: boolean;
  autoFix?: boolean;
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
  familiarType?: string;
  autoFix?: boolean;
}

/** A single routing rule that maps a task command to a familiarType and remoteTargetId. */
export interface ExecutorRoutingRule {
  /** Substring to match against the task command. */
  pattern?: string;
  /** Regular expression matched against the task command; compiled with new RegExp(regex). */
  regex?: string;
  /** Familiar type to assign (e.g. "ssh", "docker", "worktree"). */
  familiarType: string;
  /** Remote target ID to assign; must correspond to an entry in remoteTargets. */
  remoteTargetId: string;
}

/**
 * Resolve which familiarType and remoteTargetId to apply to a task.
 *
 * Returns `{}` (no override) when:
 *   - The plan already sets `familiarType` OR `remoteTargetId` on the task.
 *   - No rule matches the command.
 *
 * Otherwise returns the familiarType and remoteTargetId from the first matching rule.
 * A rule matches when `pattern` is a substring of `command`, `regex` compiles and tests
 * true against `command`, or both (either is sufficient).
 */
export function resolveExecutorRouting(
  command: string,
  planFamiliarType: string | undefined,
  planRemoteTargetId: string | undefined,
  rules: ExecutorRoutingRule[],
): { familiarType?: string; remoteTargetId?: string } {
  if (planFamiliarType !== undefined || planRemoteTargetId !== undefined) {
    return {};
  }
  for (const rule of rules) {
    const patternMatch = rule.pattern !== undefined && command.includes(rule.pattern);
    const regexMatch = rule.regex !== undefined && new RegExp(rule.regex).test(command);
    if (patternMatch || regexMatch) {
      return { familiarType: rule.familiarType, remoteTargetId: rule.remoteTargetId };
    }
  }
  return {};
}

export interface OrchestratorConfig {
  persistence: OrchestratorPersistence;
  messageBus: OrchestratorMessageBus;
  maxConcurrency?: number;
  maxUtilization?: number;
  utilizationRules?: UtilizationRule[];
  defaultUtilization?: number;
  executorRoutingRules?: ExecutorRoutingRule[];
}

// ── Orchestrator ────────────────────────────────────────────

export class Orchestrator {
  private readonly stateMachine: TaskStateMachine;
  private readonly responseHandler: ResponseHandler;
  private readonly scheduler: TaskScheduler;
  private readonly persistence: OrchestratorPersistence;
  private readonly messageBus: OrchestratorMessageBus;
  private readonly maxConcurrency: number;
  private readonly estimator: ResourceEstimator;
  private readonly executorRoutingRules: ExecutorRoutingRule[];

  private activeWorkflowIds = new Set<string>();
  private beforeApproveHook?: (task: TaskState) => Promise<void>;

  constructor(config: OrchestratorConfig) {
    this.maxConcurrency = config.maxConcurrency ?? 3;
    this.persistence = config.persistence;
    this.messageBus = config.messageBus;
    this.executorRoutingRules = config.executorRoutingRules ?? [];

    this.stateMachine = new TaskStateMachine(new ActionGraph());
    this.responseHandler = new ResponseHandler();
    this.estimator = new ResourceEstimator(
      config.utilizationRules ?? [],
      config.defaultUtilization ?? 50,
    );

    const defaultUtil = config.defaultUtilization ?? 50;
    const maxUtil = config.maxUtilization ?? (config.maxConcurrency ? config.maxConcurrency * defaultUtil : 100);
    this.scheduler = new TaskScheduler(maxUtil);
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

  /**
   * Write field changes to the DB, then update the in-memory cache
   * to match. Returns the updated task state.
   */
  private writeAndSync(taskId: string, changes: TaskStateChanges): TaskState {
    const existing = this.stateGetTask(taskId);
    if (!existing) {
      throw new Error(`writeAndSync: task ${taskId} not found in graph`);
    }
    const id = existing.id;
    this.persistence.updateTask(id, changes);
    const updated: TaskState = {
      ...existing,
      ...(changes.status !== undefined ? { status: changes.status } : {}),
      ...(changes.dependencies !== undefined ? { dependencies: changes.dependencies } : {}),
      config: { ...existing.config, ...changes.config },
      execution: { ...existing.execution, ...changes.execution },
    };
    if (process.env.NODE_ENV !== 'test') {
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
    return updated;
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

  // ── Commands ──────────────────────────────────────────────

  /**
   * Parse a plan definition and create tasks with dependencies.
   * Persists workflow and tasks, publishes deltas via MessageBus.
   */
  loadPlan(plan: PlanDefinition, opts?: { allowGraphMutation?: boolean }): void {
    const workflowId = `wf-${Date.now()}-${++workflowCounter}`;
    const localToScoped = buildPlanLocalToScopedIdMap(workflowId, plan.tasks);

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

    this.activeWorkflowIds.add(workflowId);

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
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const deltas: TaskDelta[] = [];
    const dependedOn = new Set<string>();
    for (const taskDef of plan.tasks) {
      for (const dep of taskDef.dependencies ?? []) {
        dependedOn.add(dep);
      }
    }

    for (const taskDef of plan.tasks) {
      const routing = taskDef.command && this.executorRoutingRules.length > 0
        ? resolveExecutorRouting(taskDef.command, taskDef.familiarType, taskDef.remoteTargetId, this.executorRoutingRules)
        : {};
      const effectiveFamiliarType = routing.familiarType ?? taskDef.familiarType;
      const effectiveRemoteTargetId = routing.remoteTargetId ?? taskDef.remoteTargetId;
      const scopedId = localToScoped.get(taskDef.id)!;
      const scopedDeps = (taskDef.dependencies ?? []).map((dep) => {
        const s = localToScoped.get(dep);
        if (!s) {
          throw new Error(`Task "${taskDef.id}" depends on unknown task id "${dep}" in this plan`);
        }
        return s;
      });
      const task = createTaskState(
        scopedId,
        taskDef.description,
        scopedDeps,
        {
          workflowId,
          command: taskDef.command,
          prompt: taskDef.prompt,
          pivot: taskDef.pivot,
          experimentVariants: taskDef.experimentVariants,
          requiresManualApproval: taskDef.requiresManualApproval,
          featureBranch: taskDef.featureBranch,
          familiarType: normalizeFamiliarType(effectiveFamiliarType) ?? 'worktree',
          dockerImage: taskDef.dockerImage,
          remoteTargetId: effectiveRemoteTargetId,
          autoFix: taskDef.autoFix,
        },
      );

      this.createAndSync(task);
      const delta: TaskDelta = { type: 'created', task };
      deltas.push(delta);
    }

    // Create terminal merge node depending on all leaf tasks
    const leafIds = plan.tasks
      .filter((t) => !dependedOn.has(t.id))
      .map((t) => localToScoped.get(t.id)!);
    const mergeNodeId = `__merge__${workflowId}`;
    const mergeTask = createTaskState(
      mergeNodeId,
      descriptionForMergeNode(plan),
      leafIds,
      { workflowId, isMergeNode: true, familiarType: 'merge' },
    );
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

    const readyTasks = this.stateMachine.getReadyTasks();
    const started: TaskState[] = [];

    for (const task of readyTasks) {
      const utilization = this.estimator.estimateUtilization(task);
      this.scheduler.enqueue({ taskId: task.id, priority: 0, utilization });
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
        this.scheduler.completeJob(earlyTask.id);
        return [];
      }
      if (earlyTask && (earlyTask.status === 'failed' || earlyTask.status === 'completed')) {
        console.warn(`[orchestrator] handleWorkerResponse: received "${response.status}" for already-"${earlyTask.status}" task "${response.actionId}"`);
      }
    }

    // Auto-fix interception
    if (response.status === 'failed') {
      const task = this.stateGetTask(response.actionId);
      if (task?.config.autoFix) {
        const syntheticResponse = this.buildAutoFixResponse(task, response.outputs);
        return this.handleWorkerResponse(syntheticResponse);
      }
    }

    const parsed = this.responseHandler.parseResponse(response);
    if (!('type' in parsed)) {
      const parseErr = 'error' in parsed ? (parsed as { error: string }).error : 'unknown';
      console.warn(
        `[worker-response] NO_ORCH_WRITE actionId=${response.actionId} parseError=${parseErr} ` +
          `responseStatus=${String(response.status)} — DB task row is unchanged; UI/orchestrator may diverge`,
      );
      this.scheduler.completeJob(this.stateGetTask(response.actionId)?.id ?? response.actionId);
      return [];
    }

    const taskId = parsed.taskId;
    const task = this.stateGetTask(taskId);
    if (!task) {
      console.warn(`[worker-response] task not in graph taskId=${taskId} (stale response?)`);
      this.scheduler.completeJob(this.stateGetTask(taskId)?.id ?? taskId);
      return [];
    }

    const canonicalTaskId = task.id;

    if (process.env.NODE_ENV !== 'test') {
      console.log(
        `[worker-response] write path parsedType=${parsed.type} taskId=${canonicalTaskId} ` +
          `graphStatusBefore=${task.status} workerResponseStatus=${response.status}`,
      );
    }

    this.scheduler.completeJob(canonicalTaskId);

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
    const delta: TaskDelta = { type: 'updated', taskId: id, changes };
    this.persistence.logEvent?.(id, 'task.running', changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
  }

  /**
   * Transition a running task directly to awaiting_approval.
   * Used by the merge gate in manual mode after successful consolidation.
   * Does NOT trigger checkWorkflowCompletion (the workflow stays open).
   */
  setTaskAwaitingApproval(taskId: string, additionalChanges?: TaskStateChanges): void {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) return;
    const id = task.id;

    this.scheduler.completeJob(id);

    const changes: TaskStateChanges = {
      status: 'awaiting_approval',
      config: additionalChanges?.config,
      execution: { ...additionalChanges?.execution, completedAt: new Date() },
    };
    if (task.config.isMergeNode && changes.execution && 'workspacePath' in changes.execution) {
      mergeTrace('GATE_WS_SET_TASK_AWAITING_APPROVAL', {
        taskId: id,
        workspacePath: changes.execution.workspacePath ?? null,
      });
      console.log(
        `[merge-gate-workspace] setTaskAwaitingApproval mergeNode=${id} ` +
          `execution.workspacePath=${changes.execution.workspacePath ?? 'NULL'}`,
      );
    }
    this.writeAndSync(id, changes);
    const delta: TaskDelta = { type: 'updated', taskId: id, changes };
    this.persistence.logEvent?.(id, 'task.awaiting_approval', changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
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

    this.scheduler.completeJob(tid);

    const changes: TaskStateChanges = {
      status: 'awaiting_approval',
      execution: { pendingFixError: originalError, isFixingWithAI: false, agentSessionId: task.execution.agentSessionId },
    };
    console.log(`[setFixAwaitingApproval] delta.changes.execution=`, JSON.stringify(changes.execution));
    this.writeAndSync(tid, changes);
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
    if (!task || task.status !== 'awaiting_approval') {
      mergeTrace('APPROVE_SKIPPED_NOT_AWAITING', {
        taskId,
        found: !!task,
        status: task?.status ?? 'NOT_FOUND',
        pendingFixError: task?.execution.pendingFixError !== undefined,
      });
      console.log(
        `[orchestrator.approve] skipped taskId=${taskId} ` +
          (!task ? '(task not found)' : `(status=${task.status}, expected awaiting_approval)`),
      );
      return [];
    }

    // Merge gate fixed by Claude: approve the fix → running while PR/git
    // prep executes; caller must drive the async publish work via executor.
    if (
      task.config.isMergeNode &&
      task.execution.pendingFixError !== undefined
    ) {
      console.log(
        `[merge-gate-workspace] approve(post-fix) mergeNode=${taskId} ` +
          `before writeAndSync execution.workspacePath=${task.execution.workspacePath ?? 'none'}`,
      );
      mergeTrace('GATE_WS_APPROVE_POST_FIX', {
        taskId,
        workspacePathBefore: task.execution.workspacePath ?? null,
      });
      const now = new Date();
      const fixClearChanges: TaskStateChanges = {
        status: 'running',
        execution: { pendingFixError: undefined, startedAt: now, lastHeartbeatAt: now },
      };
      this.writeAndSync(taskId, fixClearChanges);
      const fixDelta: TaskDelta = { type: 'updated', taskId, changes: fixClearChanges };
      this.persistence.logEvent?.(taskId, 'task.running', fixClearChanges);
      this.messageBus.publish(TASK_DELTA_CHANNEL, fixDelta);
      const updated = this.stateGetTask(taskId)!;
      console.log(
        `[merge-gate-workspace] approve(post-fix) mergeNode=${taskId} ` +
          `after writeAndSync execution.workspacePath=${updated.execution.workspacePath ?? 'none'} ` +
          '(pendingFix cleared; path should be unchanged)',
      );
      mergeTrace('GATE_WS_APPROVE_POST_FIX_AFTER', {
        taskId,
        workspacePathAfter: updated.execution.workspacePath ?? null,
      });
      return [updated];
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
    mergeTrace('APPROVE_STARTED', { taskId: task.id, startedIds: started.map(t => t.id), startedStatuses: started.map(t => t.status) });
    this.checkWorkflowCompletion();
    return started;
  }

  /**
   * Reject a task awaiting approval. Fails it and blocks dependents.
   */
  reject(taskId: string, reason?: string): void {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task || task.status !== 'awaiting_approval') return;

    const changes: TaskStateChanges = {
      status: 'failed',
      execution: { error: reason ?? 'Rejected', completedAt: new Date() },
    };
    this.writeAndSync(taskId, changes);
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

    // Reconciliation may still be `running` if selection happens without a prior
    // `needs_input` worker response (tests); free the scheduler slot either way.
    if (task.status === 'running' || task.status === 'fixing_with_ai') {
      this.scheduler.completeJob(reconId);
    }

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
    const delta: TaskDelta = { type: 'updated', taskId: reconId, changes };
    this.persistence.logEvent?.(reconId, 'task.completed', changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);

    const readyTaskIds = this.stateMachine.findNewlyReadyTasks(reconId);
    const schedulerStatus = this.scheduler.getStatus();
    console.log(`[orchestrator] selectExperiment "${reconId}": ${readyTaskIds.length} newly ready: [${readyTaskIds.join(', ')}], scheduler: util=${schedulerStatus.runningUtilization}/${schedulerStatus.maxUtilization} running=${schedulerStatus.runningCount} queued=${schedulerStatus.queueLength}`);
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

    if (task.status === 'running' || task.status === 'fixing_with_ai') {
      this.scheduler.completeJob(reconId);
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
    this.writeAndSync(reconId, changes);
    const delta: TaskDelta = { type: 'updated', taskId: reconId, changes };
    this.persistence.logEvent?.(reconId, 'task.completed', changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);

    const readyTaskIds = this.stateMachine.findNewlyReadyTasks(reconId);
    const schedulerStatus = this.scheduler.getStatus();
    console.log(`[orchestrator] selectExperiments "${reconId}": ${readyTaskIds.length} newly ready: [${readyTaskIds.join(', ')}], scheduler: util=${schedulerStatus.runningUtilization}/${schedulerStatus.maxUtilization} running=${schedulerStatus.runningCount} queued=${schedulerStatus.queueLength}`);
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

    const completedDownstream = this.stateMachine.getAllTasks().filter(
      t => t.status === 'completed' && t.dependencies.includes(id),
    );
    if (completedDownstream.length > 0 && prevStatus === 'completed') {
      console.warn(`[orchestrator] restartTask "${id}": ${completedDownstream.length} downstream task(s) are completed and will NOT be invalidated: [${completedDownstream.map(t => t.id).join(', ')}]`);
    }

    // Supersede current selected attempt and create a new one (best-effort)
    try {
      const attempts = this.persistence.loadAttempts(id);
      const current = attempts[attempts.length - 1];
      if (current && (current.status === 'running' || current.status === 'pending')) {
        this.persistence.updateAttempt(current.id, { status: 'superseded' });
      }
      const newAttempt = createAttempt(id, {
        snapshotCommit: current?.commit,
        supersedesAttemptId: current?.id,
      });
      this.persistence.saveAttempt(newAttempt);
    } catch { /* best effort */ }

    const resetChanges: TaskStateChanges = {
      status: 'pending',
      config: { summary: undefined },
      execution: {
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
    const afterRt = this.writeAndSync(id, resetChanges);
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
    const resetDelta: TaskDelta = { type: 'updated', taskId: id, changes: resetChanges };
    this.persistence.logEvent?.(id, 'task.pending', resetChanges);
    this.messageBus.publish(TASK_DELTA_CHANNEL, resetDelta);

    // Reset any reconciliation task that was already in needs_input but now
    // has a dependency that is no longer terminal (because we just restarted it).
    for (const recon of this.stateMachine.getAllTasks()) {
      if (!recon.config.isReconciliation) continue;
      if (recon.status !== 'needs_input') continue;
      if (!recon.dependencies.includes(id)) continue;

      const reconReset: TaskStateChanges = {
        status: 'pending',
        execution: { experimentResults: undefined },
      };
      this.writeAndSync(recon.id, reconReset);
      const reconDelta: TaskDelta = { type: 'updated', taskId: recon.id, changes: reconReset };
      this.persistence.logEvent?.(recon.id, 'task.pending', reconReset);
      this.messageBus.publish(TASK_DELTA_CHANNEL, reconDelta);
      console.log(`[orchestrator] restartTask "${id}": reset reconciliation "${recon.id}" back to pending`);
    }

    this.scheduler.completeJob(id);

    const readyTasks = this.stateMachine.getReadyTasks();
    const isReady = readyTasks.some((t) => t.id === id);
    console.log(`[orchestrator] restartTask "${id}": ready=${isReady}`);
    if (isReady) {
      return this.autoStartReadyTasks([id]);
    }

    return [this.stateGetTask(id)!];
  }

  /**
   * Reset ALL tasks in a workflow to pending and auto-start ready ones.
   * Used when a rebase conflicts and the entire DAG needs to re-execute.
   */
  restartWorkflow(workflowId: string): TaskState[] {
    this.refreshFromDb();

    const allTasks = this.stateMachine.getAllTasks().filter(
      (t) => t.config.workflowId === workflowId,
    );
    if (allTasks.length === 0) throw new Error(`No tasks found for workflow ${workflowId}`);

    const resetChanges: TaskStateChanges = {
      status: 'pending',
      config: { summary: undefined },
      execution: {
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

    console.log(`[orchestrator] restartWorkflow: resetting ${allTasks.length} tasks for workflow ${workflowId}`);
    console.log(
      '[agent-session-trace] restartWorkflow: resetChanges.execution clears agentSessionId/containerId (DB NULL before next run)',
    );
    for (const task of allTasks) {
      const prevSess = task.execution.agentSessionId ?? null;
      const prevCt = task.execution.containerId ?? null;
      if (task.config.isMergeNode) {
        console.log(
          `[merge-gate-workspace] restartWorkflow mergeNode=${task.id} ` +
            `will clear workspace_path (was ${task.execution.workspacePath ?? 'NULL'})`,
        );
        mergeTrace('GATE_WS_RESTART_WORKFLOW_MERGE', {
          taskId: task.id,
          workspacePathBefore: task.execution.workspacePath ?? null,
        });
      }
      console.log(`[orchestrator]   reset "${task.id}" (was ${task.status}, branch=${task.execution.branch ?? 'none'}, commit=${task.execution.commit?.slice(0, 7) ?? 'none'})`);
      console.log(
        `[agent-session-trace] restartWorkflow: before writeAndSync task="${task.id}" agentSessionId=${prevSess ?? 'null'} containerId=${prevCt ?? 'null'}`,
      );
      const after = this.writeAndSync(task.id, resetChanges);
      console.log(
        `[agent-session-trace] restartWorkflow: after writeAndSync task="${task.id}" agentSessionId=${after.execution.agentSessionId ?? 'null'} containerId=${after.execution.containerId ?? 'null'}`,
      );
      const delta: TaskDelta = { type: 'updated', taskId: task.id, changes: resetChanges };
      this.persistence.logEvent?.(task.id, 'task.pending', resetChanges);
      this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
      this.scheduler.completeJob(task.id);
    }

    return this.startExecution();
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

    const id = task.id;
    const changes: TaskStateChanges = {
      status: 'fixing_with_ai',
      execution: {
        error: undefined,
        exitCode: undefined,
        completedAt: undefined,
        mergeConflict: undefined,
        isFixingWithAI: false,
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
      },
    };
    this.writeAndSync(taskId, changes);
    const delta: TaskDelta = { type: 'updated', taskId: id, changes };
    this.persistence.logEvent?.(id, 'task.fixing_with_ai', changes);
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

    let mergeConflict: { failedBranch: string; conflictFiles: string[] } | undefined;
    try {
      const obj = JSON.parse(savedError);
      if (obj?.type === 'merge_conflict') {
        mergeConflict = { failedBranch: obj.failedBranch, conflictFiles: obj.conflictFiles };
      }
    } catch { /* not JSON — normal error string */ }

    const displayError = fixError
      ? `[Fix with Claude failed] ${fixError}\n\n${savedError}`
      : savedError;
    const changes: TaskStateChanges = {
      status: 'failed',
      execution: { error: displayError, mergeConflict, isFixingWithAI: false },
    };
    this.writeAndSync(taskId, changes);
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

    // Create a fresh-start attempt with commandOverride (best-effort)
    try {
      const attempts = this.persistence.loadAttempts(taskId);
      const current = attempts[attempts.length - 1];
      if (current && (current.status === 'running' || current.status === 'pending')) {
        this.persistence.updateAttempt(current.id, { status: 'superseded' });
      }
      const freshAttempt = createAttempt(taskId, {
        commandOverride: newCommand,
        supersedesAttemptId: current?.id,
      });
      this.persistence.saveAttempt(freshAttempt);
    } catch { /* best effort */ }

    return this.restartTask(taskId);
  }

  /**
   * Change a task's executor type (familiarType) and restart it.
   * Does NOT fork the dirty subtree.
   */
  editTaskType(taskId: string, familiarType: string, remoteTargetId?: string): TaskState[] {
    this.refreshFromDb();
    const task = this.stateGetTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.config.isMergeNode) throw new Error(`Cannot change executor type of merge node ${taskId}`);
    if (task.status === 'running' || task.status === 'fixing_with_ai') throw new Error(`Cannot edit running task ${taskId}`);

    const effectiveType = normalizeFamiliarType(familiarType) ?? familiarType;

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

    const configPatch: Record<string, unknown> = { familiarType: effectiveType };
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
      this.persistence.logEvent?.(id, 'task.stale', staleChanges);
      this.messageBus.publish(TASK_DELTA_CHANNEL, {
        type: 'updated', taskId: id, changes: staleChanges,
      });
    }
    const sourceChanges: TaskStateChanges = { status: 'stale' };
    this.writeAndSync(sourceId, sourceChanges);
    this.persistence.logEvent?.(sourceId, 'task.stale', sourceChanges);
    this.messageBus.publish(TASK_DELTA_CHANNEL, {
      type: 'updated', taskId: sourceId, changes: sourceChanges,
    });

    // 2. Create replacement tasks
    for (const rt of replacementTasks) {
      const hasInternalDeps =
        rt.dependencies?.length && rt.dependencies.some((d) => replacementRawIds.has(d));
      const scopedId = scopeLocal(rt.id);
      const deps = hasInternalDeps
        ? rt.dependencies!.map((d) => scopeLocal(d))
        : [...task.dependencies];
      const newTask = createTaskState(scopedId, rt.description, deps, {
        workflowId: wfId,
        command: rt.command,
        prompt: rt.prompt,
        familiarType: rt.familiarType ?? task.config.familiarType,
        autoFix: rt.autoFix,
      });
      this.createAndSync(newTask);
      this.messageBus.publish(TASK_DELTA_CHANNEL, { type: 'created', task: newTask });
    }

    // 3. Reconcile merge node deps from actual graph state
    this.reconcileMergeLeaves(wfId);

    this.scheduler.completeJob(task.id);

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
  }

  /**
   * Load tasks from ALL workflows into the state machine.
   * Iterates over listWorkflows() -> loadTasks(wfId) for each.
   * The workflow FK is the single source of truth.
   */
  syncAllFromDb(): void {
    this.stateMachine.clear();
    this.activeWorkflowIds.clear();
    const allTasks: TaskState[] = [];
    const workflows = this.persistence.listWorkflows();
    for (const wf of workflows) {
      this.activeWorkflowIds.add(wf.id);
      const tasks = this.persistence.loadTasks(wf.id);
      for (const task of tasks) {
        this.stateMachine.restoreTask(task);
        allTasks.push(task);
      }
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
      this.scheduler.completeJob(task.id);
      this.scheduler.removeJob(task.id);
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

    // 5. Publish removal deltas — drives UI cache cleanup via messageBus subscriber
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

      // Free scheduler slot
      if (wasRunning) {
        this.scheduler.completeJob(id);
        runningCancelled.push(id);
      } else {
        this.scheduler.removeJob(id);
      }

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
      const delta: TaskDelta = { type: 'updated', taskId: id, changes };
      this.persistence.logEvent?.(id, 'task.cancelled', changes);
      this.messageBus.publish(TASK_DELTA_CHANNEL, delta);

      cancelled.push(id);
    }

    this.checkWorkflowCompletion();
    return { cancelled, runningCancelled };
  }

  /**
   * Get detailed queue status with task metadata for display.
   */
  getQueueStatus(): {
    maxUtilization: number;
    runningUtilization: number;
    running: Array<{ taskId: string; utilization: number; description: string }>;
    queued: Array<{ taskId: string; priority: number; utilization: number; description: string }>;
  } {
    const status = this.scheduler.getStatus();
    const runningJobs = this.scheduler.getRunningJobs();
    const queuedJobs = this.scheduler.getQueuedJobs();

    return {
      maxUtilization: status.maxUtilization,
      runningUtilization: status.runningUtilization,
      running: runningJobs.map(j => ({
        ...j,
        description: this.stateGetTask(j.taskId)?.description ?? '',
      })),
      queued: queuedJobs.map(j => ({
        taskId: j.taskId,
        priority: j.priority,
        utilization: j.utilization ?? 50,
        description: this.stateGetTask(j.taskId)?.description ?? '',
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
    } = {
      exitCode: parsed.exitCode,
      completedAt: new Date(),
    };
    if (parsed.commitHash !== undefined) {
      execution.commit = parsed.commitHash;
    }
    if (parsed.agentSessionId !== undefined) {
      execution.agentSessionId = parsed.agentSessionId;
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

    // Dual-write: update latest Attempt to completed, auto-select (best-effort)
    try {
      const attempts = this.persistence.loadAttempts(taskId);
      const latest = attempts[attempts.length - 1];
      if (latest && latest.status === 'running') {
        this.persistence.updateAttempt(latest.id, {
          status: 'completed',
          exitCode: parsed.exitCode,
          completedAt: new Date(),
          ...(parsed.commitHash !== undefined ? { commit: parsed.commitHash } : {}),
          ...(parsed.agentSessionId !== undefined ? { agentSessionId: parsed.agentSessionId } : {}),
        });
        // Auto-select this attempt
        const selectChanges: TaskStateChanges = { execution: { selectedAttemptId: latest.id } };
        this.writeAndSync(taskId, selectChanges);
      }
    } catch { /* best effort */ }

    // If task requires manual approval, don't trigger downstream tasks yet
    if (needsApproval) return [];

    this.checkExperimentCompletion(taskId);

    const readyTaskIds = this.stateMachine.findNewlyReadyTasks(taskId);
    console.log(`[orchestrator] handleCompleted "${taskId}": ${readyTaskIds.length} newly ready: [${readyTaskIds.join(', ')}]`);
    const started = this.autoStartReadyTasks(readyTaskIds);
    this.checkWorkflowCompletion();
    return started;
  }

  private handleFailed(
    taskId: string,
    parsed: Extract<ParsedResponse, { type: 'failed' }>,
  ): TaskState[] {
    let mergeConflict: { failedBranch: string; conflictFiles: string[] } | undefined;
    if (parsed.error) {
      try {
        const obj = JSON.parse(parsed.error);
        if (obj?.type === 'merge_conflict') {
          mergeConflict = { failedBranch: obj.failedBranch, conflictFiles: obj.conflictFiles };
        }
      } catch { /* not JSON — normal error string */ }
    }

    const changes: TaskStateChanges = {
      status: 'failed',
      execution: {
        exitCode: parsed.exitCode,
        error: parsed.error,
        mergeConflict,
        completedAt: new Date(),
      },
    };
    this.writeAndSync(taskId, changes);
    const delta: TaskDelta = { type: 'updated', taskId, changes };
    this.persistence.logEvent?.(taskId, 'task.failed', changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);

    // Dual-write: update latest Attempt to failed (best-effort)
    try {
      const attempts = this.persistence.loadAttempts(taskId);
      const latest = attempts[attempts.length - 1];
      if (latest && latest.status === 'running') {
        this.persistence.updateAttempt(latest.id, {
          status: 'failed',
          exitCode: parsed.exitCode,
          error: parsed.error,
          mergeConflict,
          completedAt: new Date(),
        });
      }
    } catch { /* best effort */ }

    this.checkExperimentCompletion(taskId);

    const readyTaskIds = this.stateMachine.findNewlyReadyTasks(taskId);
    console.log(
      `[orchestrator] handleFailed "${taskId}": ${readyTaskIds.length} newly ready: [${readyTaskIds.join(', ')}]`,
    );
    const started = this.autoStartReadyTasks(readyTaskIds);
    this.checkWorkflowCompletion();
    return started;
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
      familiarType: parentTask?.config.familiarType,
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
        // TaskExecutor then acquires a worktree and emits `needs_input` (open-terminal cwd).
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

  private buildAutoFixResponse(task: TaskState, outputs: WorkResponse['outputs']): WorkResponse {
    const errorMsg = outputs.error ?? `Task failed with exit code ${outputs.exitCode ?? 1}`;

    const variants = [
      {
        id: 'fix-conservative',
        description: 'Conservative fix: minimal change to fix the error',
        prompt: `The following task failed. Apply the MINIMAL change needed to fix this specific error.\n\nOriginal task: ${task.description}\nOriginal prompt: ${task.config.prompt ?? task.config.command ?? 'N/A'}\nError: ${errorMsg}\n\nFix the error with the smallest possible change. Do not refactor or restructure.`,
      },
      {
        id: 'fix-refactor',
        description: 'Refactor fix: restructure to avoid the error',
        prompt: `The following task failed. Restructure the approach to avoid this class of error entirely.\n\nOriginal task: ${task.description}\nOriginal prompt: ${task.config.prompt ?? task.config.command ?? 'N/A'}\nError: ${errorMsg}\n\nRefactor the code to fix the error and prevent similar issues.`,
      },
      {
        id: 'fix-alternative',
        description: 'Alternative fix: try a completely different approach',
        prompt: `The following task failed. Try a COMPLETELY DIFFERENT implementation approach.\n\nOriginal task: ${task.description}\nOriginal prompt: ${task.config.prompt ?? task.config.command ?? 'N/A'}\nError: ${errorMsg}\n\nIgnore the previous approach and implement this from scratch using a different strategy.`,
      },
    ];

    return {
      requestId: `autofix-${task.id}`,
      actionId: task.id,
      status: 'spawn_experiments',
      outputs: { exitCode: 0 },
      dagMutation: {
        spawnExperiments: {
          description: `Auto-fix experiments for failed task: ${task.description}`,
          variants,
        },
      },
    };
  }

  private checkWorkflowCompletion(): void {
    if (!this.persistence.updateWorkflow) return;

    for (const wfId of this.activeWorkflowIds) {
      const tasks = this.stateMachine.getAllTasks().filter((t) => t.config.workflowId === wfId);
      if (tasks.length === 0) continue;

      const settled = tasks.every(
        (t) =>
          t.status === 'completed' ||
          t.status === 'failed' ||
          t.status === 'needs_input' ||
          t.status === 'awaiting_approval' ||
          t.status === 'blocked' ||
          t.status === 'stale',
      );
      if (!settled) continue;

      const hasPendingInput = tasks.some(
        (t) => t.status === 'needs_input' || t.status === 'awaiting_approval',
      );
      if (hasPendingInput) continue;

      const allSucceeded = tasks.every(
        (t) => t.status === 'completed' || t.status === 'stale',
      );
      const status = allSucceeded ? 'completed' : 'failed';
      this.persistence.updateWorkflow(wfId, {
        status,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  private autoStartReadyTasks(taskIds: string[]): TaskState[] {
    for (const taskId of taskIds) {
      const task = this.stateGetTask(taskId);
      if (!task) continue;

      // Unblock: if a blocked task's deps are all complete, it's genuinely ready
      if (task.status === 'blocked') {
        console.log(`[orchestrator] autoStartReadyTasks: unblocking "${taskId}" (was blocked, deps now satisfied)`);
        this.writeAndSync(taskId, { status: 'pending' });
      }

      const utilization = this.estimator.estimateUtilization(task);
      this.scheduler.enqueue({ taskId, priority: 0, utilization });
    }

    return this.drainScheduler();
  }

  /** Drain the scheduler queue, starting tasks that fit the resource budget. */
  private drainScheduler(): TaskState[] {
    for (const runningId of this.scheduler.getRunningTaskIds()) {
      const task = this.stateGetTask(runningId);
      if (!task || (task.status !== 'running' && task.status !== 'fixing_with_ai')) {
        console.warn(`[orchestrator] drainScheduler: freeing leaked scheduler slot for "${runningId}" (actual status: ${task?.status ?? 'not found'})`);
        this.scheduler.completeJob(runningId);
      }
    }

    const started: TaskState[] = [];
    let job = this.scheduler.dequeue();
    while (job) {
      const task = this.stateGetTask(job.taskId);
      console.log(`[orchestrator] drainScheduler: dequeued "${job.taskId}" actual status=${task?.status ?? 'NOT_FOUND'}`);
      if (!task || task.status !== 'pending') {
        console.log(`[orchestrator] drainScheduler: SKIPPING "${job.taskId}" — not pending`);
        this.scheduler.completeJob(job.taskId);
        job = this.scheduler.dequeue();
        continue;
      }

      const now = new Date();
      const changes: TaskStateChanges = {
        status: 'running',
        execution: { startedAt: now, lastHeartbeatAt: now },
      };
      const updated = this.writeAndSync(job.taskId, changes);
      started.push(updated);

      const delta: TaskDelta = { type: 'updated', taskId: job.taskId, changes };
      this.persistence.logEvent?.(job.taskId, 'task.running', changes);
      this.messageBus.publish(TASK_DELTA_CHANNEL, delta);

      // Dual-write: create Attempt record (best-effort)
      try {
        const upstreamAttemptIds = task.dependencies
          .map(depId => this.stateGetTask(depId)?.execution.selectedAttemptId)
          .filter((id): id is string => !!id);
        const attempt = createAttempt(job.taskId, {
          status: 'running',
          startedAt: now,
          upstreamAttemptIds,
        });
        this.persistence.saveAttempt(attempt);
      } catch { /* best effort — never break existing flow */ }

      job = this.scheduler.dequeue();
    }
    return started;
  }
}
