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
    status: 'running' | 'completed' | 'failed';
    createdAt: string;
    updatedAt: string;
    onFinish?: string;
    baseBranch?: string;
    featureBranch?: string;
    mergeMode?: 'manual' | 'automatic' | 'github';
  }): void;
  updateWorkflow?(workflowId: string, changes: { status?: string; updatedAt?: string; baseBranch?: string; generation?: number; mergeMode?: 'manual' | 'automatic' | 'github' }): void;
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
    mergeMode?: 'manual' | 'automatic' | 'github';
    generation?: number;
  }>;
  loadTasks(workflowId: string): TaskState[];
  // Attempt methods (optional for backward compat)
  saveAttempt?(attempt: Attempt): void;
  loadAttempts?(nodeId: string): Attempt[];
  loadAttempt?(attemptId: string): Attempt | undefined;
  updateAttempt?(attemptId: string, changes: Partial<Pick<Attempt, 'status' | 'startedAt' | 'completedAt' | 'exitCode' | 'error' | 'lastHeartbeatAt' | 'branch' | 'commit' | 'summary' | 'workspacePath' | 'claudeSessionId' | 'containerId' | 'mergeConflict'>>): void;
  getNextAttemptNumber?(nodeId: string): number;
}

export interface OrchestratorMessageBus {
  publish<T>(channel: string, message: T): void;
}

// ── Public Types ────────────────────────────────────────────

export interface PlanDefinition {
  name: string;
  description?: string;
  onFinish?: 'none' | 'merge' | 'pull_request';
  baseBranch?: string;
  featureBranch?: string;
  mergeMode?: 'manual' | 'automatic' | 'github';
  tasks: Array<{
    id: string;
    description: string;
    command?: string;
    prompt?: string;
    dependencies?: string[];
    pivot?: boolean;
    experimentVariants?: Array<{ id: string; description: string; prompt?: string; command?: string }>;
    requiresManualApproval?: boolean;
    repoUrl?: string;
    featureBranch?: string;
    familiarType?: string;
    autoFix?: boolean;
    maxFixAttempts?: number;
    dockerImage?: string;
    remoteTargetId?: string;
  }>;
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
  repoUrl?: string;
  familiarType?: string;
  isReconciliation?: boolean;
  requiresManualApproval?: boolean;
  autoFix?: boolean;
  maxFixAttempts?: number;
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
  maxFixAttempts?: number;
}

export interface OrchestratorConfig {
  persistence: OrchestratorPersistence;
  messageBus: OrchestratorMessageBus;
  maxConcurrency?: number;
  maxUtilization?: number;
  utilizationRules?: UtilizationRule[];
  defaultUtilization?: number;
  maxAttemptsPerNode?: number;
}

// ── Orchestrator ────────────────────────────────────────────

export class Orchestrator {
  private readonly stateMachine: TaskStateMachine;
  private readonly responseHandler: ResponseHandler;
  private readonly scheduler: TaskScheduler;
  private readonly persistence: OrchestratorPersistence;
  private readonly messageBus: OrchestratorMessageBus;
  private readonly maxConcurrency: number;
  private readonly maxAttemptsPerNode: number;
  private readonly estimator: ResourceEstimator;

  private activeWorkflowIds = new Set<string>();
  private beforeApproveHook?: (task: TaskState) => Promise<void>;

  constructor(config: OrchestratorConfig) {
    this.maxConcurrency = config.maxConcurrency ?? 3;
    this.maxAttemptsPerNode = config.maxAttemptsPerNode ?? 10;
    this.persistence = config.persistence;
    this.messageBus = config.messageBus;

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
    this.persistence.updateTask(taskId, changes);
    const existing = this.stateMachine.getTask(taskId);
    if (!existing) {
      throw new Error(`writeAndSync: task ${taskId} not found in graph`);
    }
    const updated: TaskState = {
      ...existing,
      ...(changes.status !== undefined ? { status: changes.status } : {}),
      ...(changes.dependencies !== undefined ? { dependencies: changes.dependencies } : {}),
      config: { ...existing.config, ...changes.config },
      execution: { ...existing.execution, ...changes.execution },
    };
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
    if (!opts?.allowGraphMutation) {
      const newIds = new Set(plan.tasks.map((t) => t.id));
      const existingTasks = this.stateMachine.getAllTasks();
      const overlapping = existingTasks.filter(
        (t) => newIds.has(t.id) && !t.config.isMergeNode,
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
          `~/.invoker/config.json or <repoDir>/.invoker.json.`,
          conflictingIds,
          conflictingWorkflows,
        );
      }
    }

    const workflowId = `wf-${Date.now()}-${++workflowCounter}`;
    this.activeWorkflowIds.add(workflowId);

    this.persistence.saveWorkflow({
      id: workflowId,
      name: plan.name,
      description: plan.description,
      status: 'running',
      onFinish: plan.onFinish,
      baseBranch: plan.baseBranch,
      featureBranch: plan.featureBranch,
      mergeMode: plan.mergeMode,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const deltas: TaskDelta[] = [];
    const taskIds = new Set(plan.tasks.map((t) => t.id));
    const dependedOn = new Set<string>();
    for (const taskDef of plan.tasks) {
      for (const dep of taskDef.dependencies ?? []) {
        dependedOn.add(dep);
      }
    }

    for (const taskDef of plan.tasks) {
      const task = createTaskState(
        taskDef.id,
        taskDef.description,
        taskDef.dependencies ?? [],
        {
          workflowId,
          command: taskDef.command,
          prompt: taskDef.prompt,
          pivot: taskDef.pivot,
          experimentVariants: taskDef.experimentVariants,
          requiresManualApproval: taskDef.requiresManualApproval,
          repoUrl: taskDef.repoUrl,
          featureBranch: taskDef.featureBranch,
          familiarType: normalizeFamiliarType(taskDef.familiarType) ?? 'worktree',
          dockerImage: taskDef.dockerImage,
          remoteTargetId: taskDef.remoteTargetId,
          autoFix: taskDef.autoFix,
          maxFixAttempts: taskDef.maxFixAttempts,
        },
      );

      this.createAndSync(task);
      const delta: TaskDelta = { type: 'created', task };
      deltas.push(delta);
    }

    // Create terminal merge node depending on all leaf tasks
    const leafIds = plan.tasks
      .filter((t) => !dependedOn.has(t.id))
      .map((t) => t.id);
    const mergeNodeId = `__merge__${workflowId}`;
    const mergeTask = createTaskState(
      mergeNodeId,
      `Merge gate for ${plan.name}`,
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
      const earlyTask = this.stateMachine.getTask(response.actionId);
      if (earlyTask?.status === 'stale') {
        this.scheduler.completeJob(response.actionId);
        return [];
      }
      if (earlyTask && (earlyTask.status === 'failed' || earlyTask.status === 'completed')) {
        console.warn(`[orchestrator] handleWorkerResponse: received "${response.status}" for already-"${earlyTask.status}" task "${response.actionId}"`);
      }
    }

    // Auto-fix interception
    if (response.status === 'failed') {
      const task = this.stateMachine.getTask(response.actionId);
      if (task?.config.autoFix) {
        const syntheticResponse = this.buildAutoFixResponse(task, response.outputs);
        return this.handleWorkerResponse(syntheticResponse);
      }
    }

    const parsed = this.responseHandler.parseResponse(response);
    if (!('type' in parsed)) {
      this.scheduler.completeJob(response.actionId);
      return [];
    }

    const taskId = parsed.taskId;
    const task = this.stateMachine.getTask(taskId);
    if (!task) {
      this.scheduler.completeJob(taskId);
      return [];
    }

    this.scheduler.completeJob(taskId);

    switch (parsed.type) {
      case 'completed':
        return this.handleCompleted(taskId, parsed);
      case 'failed':
        return this.handleFailed(taskId, parsed);
      case 'needs_input':
        return this.handleNeedsInput(taskId, parsed);
      case 'spawn_experiments':
        return this.handleSpawnExperiments(taskId, parsed);
      case 'select_experiment':
        return this.handleSelectExperiment(taskId, parsed);
      default:
        return [];
    }
  }

  /**
   * Resume a paused task with user input.
   */
  provideInput(taskId: string, input: string): void {
    this.refreshFromDb();
    const task = this.stateMachine.getTask(taskId);
    if (!task || task.status !== 'needs_input') return;

    const changes: TaskStateChanges = { status: 'running', execution: { inputPrompt: undefined } };
    this.writeAndSync(taskId, changes);
    const delta: TaskDelta = { type: 'updated', taskId, changes };
    this.persistence.logEvent?.(taskId, 'task.running', changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
  }

  /**
   * Transition a running task directly to awaiting_approval.
   * Used by the merge gate in manual mode after successful consolidation.
   * Does NOT trigger checkWorkflowCompletion (the workflow stays open).
   */
  setTaskAwaitingApproval(taskId: string, additionalChanges?: TaskStateChanges): void {
    this.refreshFromDb();
    const task = this.stateMachine.getTask(taskId);
    if (!task) return;

    this.scheduler.completeJob(taskId);

    const changes: TaskStateChanges = {
      status: 'awaiting_approval',
      config: additionalChanges?.config,
      execution: { ...additionalChanges?.execution, completedAt: new Date() },
    };
    this.writeAndSync(taskId, changes);
    const delta: TaskDelta = { type: 'updated', taskId, changes };
    this.persistence.logEvent?.(taskId, 'task.awaiting_approval', changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
  }

  setFixAwaitingApproval(taskId: string, originalError: string): void {
    this.refreshFromDb();
    const task = this.stateMachine.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.status !== 'running') throw new Error(`Task ${taskId} is not running (status: ${task.status})`);
    console.log(`[setFixAwaitingApproval] taskId=${taskId} claudeSessionId=${task.execution.claudeSessionId}`);

    this.scheduler.completeJob(taskId);

    const changes: TaskStateChanges = {
      status: 'awaiting_approval',
      execution: { pendingFixError: originalError, isFixingWithAI: undefined, claudeSessionId: task.execution.claudeSessionId },
    };
    console.log(`[setFixAwaitingApproval] delta.changes.execution=`, JSON.stringify(changes.execution));
    this.writeAndSync(taskId, changes);
    const delta: TaskDelta = { type: 'updated', taskId, changes };
    this.persistence.logEvent?.(taskId, 'task.awaiting_approval', changes);
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
    const task = this.stateMachine.getTask(taskId);
    mergeTrace('APPROVE_TASK_LOOKUP', { taskId, found: !!task, status: task?.status, isMergeNode: !!task?.config.isMergeNode, hasHook: !!this.beforeApproveHook });
    if (!task || task.status !== 'awaiting_approval') return [];

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
          const dep = this.stateMachine.getTask(depId);
          return { id: depId, status: dep?.status ?? 'NOT_FOUND' };
        }),
      });
    }

    const readyTaskIds = this.stateMachine.findNewlyReadyTasks(taskId);
    mergeTrace('APPROVE_READY_TASKS', { taskId, readyTaskIds });
    const started = this.autoStartReadyTasks(readyTaskIds);
    mergeTrace('APPROVE_STARTED', { taskId, startedIds: started.map(t => t.id), startedStatuses: started.map(t => t.status) });
    this.checkWorkflowCompletion();
    return started;
  }

  /**
   * Reject a task awaiting approval. Fails it and blocks dependents.
   */
  reject(taskId: string, reason?: string): void {
    this.refreshFromDb();
    const task = this.stateMachine.getTask(taskId);
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
    const task = this.stateMachine.getTask(taskId);
    if (!task || !task.config.isReconciliation) return [];

    const winner = this.stateMachine.getTask(experimentId);
    const changes: TaskStateChanges = {
      status: 'completed',
      execution: {
        selectedExperiment: experimentId,
        completedAt: new Date(),
        branch: winner?.execution.branch,
        commit: winner?.execution.commit,
      },
    };
    this.writeAndSync(taskId, changes);
    const delta: TaskDelta = { type: 'updated', taskId, changes };
    this.persistence.logEvent?.(taskId, 'task.completed', changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);

    const readyTaskIds = this.stateMachine.findNewlyReadyTasks(taskId);
    const schedulerStatus = this.scheduler.getStatus();
    console.log(`[orchestrator] selectExperiment "${taskId}": ${readyTaskIds.length} newly ready: [${readyTaskIds.join(', ')}], scheduler: util=${schedulerStatus.runningUtilization}/${schedulerStatus.maxUtilization} running=${schedulerStatus.runningCount} queued=${schedulerStatus.queueLength}`);
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
    const task = this.stateMachine.getTask(taskId);
    if (!task || !task.config.isReconciliation) return [];

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
    this.writeAndSync(taskId, changes);
    const delta: TaskDelta = { type: 'updated', taskId, changes };
    this.persistence.logEvent?.(taskId, 'task.completed', changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);

    const readyTaskIds = this.stateMachine.findNewlyReadyTasks(taskId);
    const schedulerStatus = this.scheduler.getStatus();
    console.log(`[orchestrator] selectExperiments "${taskId}": ${readyTaskIds.length} newly ready: [${readyTaskIds.join(', ')}], scheduler: util=${schedulerStatus.runningUtilization}/${schedulerStatus.maxUtilization} running=${schedulerStatus.runningCount} queued=${schedulerStatus.queueLength}`);
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
    const task = this.stateMachine.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    // Enforce maxAttemptsPerNode
    if (this.persistence.getNextAttemptNumber) {
      const nextNum = this.persistence.getNextAttemptNumber(taskId);
      if (nextNum > this.maxAttemptsPerNode) {
        throw new Error(`Task "${taskId}" has reached the maximum of ${this.maxAttemptsPerNode} attempts`);
      }
    }

    const prevStatus = task.status;
    console.log(`[orchestrator] restartTask "${taskId}" (was ${prevStatus})`);

    const completedDownstream = this.stateMachine.getAllTasks().filter(
      t => t.status === 'completed' && t.dependencies.includes(taskId),
    );
    if (completedDownstream.length > 0 && prevStatus === 'completed') {
      console.warn(`[orchestrator] restartTask "${taskId}": ${completedDownstream.length} downstream task(s) are completed and will NOT be invalidated: [${completedDownstream.map(t => t.id).join(', ')}]`);
    }

    // Supersede current selected attempt and create a new one (best-effort)
    try {
      if (this.persistence.loadAttempts && this.persistence.updateAttempt && this.persistence.saveAttempt && this.persistence.getNextAttemptNumber) {
        const attempts = this.persistence.loadAttempts(taskId);
        const current = attempts[attempts.length - 1];
        if (current && (current.status === 'running' || current.status === 'pending')) {
          this.persistence.updateAttempt(current.id, { status: 'superseded' });
        }
        const nextNum = this.persistence.getNextAttemptNumber(taskId);
        const newAttempt = createAttempt(taskId, nextNum, {
          snapshotCommit: current?.commit,
          supersedesAttemptId: current?.id,
        });
        this.persistence.saveAttempt(newAttempt);
      }
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
        isFixingWithAI: undefined,
      },
    };
    this.writeAndSync(taskId, resetChanges);
    const resetDelta: TaskDelta = { type: 'updated', taskId, changes: resetChanges };
    this.persistence.logEvent?.(taskId, 'task.pending', resetChanges);
    this.messageBus.publish(TASK_DELTA_CHANNEL, resetDelta);

    // Reset any reconciliation task that was already in needs_input but now
    // has a dependency that is no longer terminal (because we just restarted it).
    for (const recon of this.stateMachine.getAllTasks()) {
      if (!recon.config.isReconciliation) continue;
      if (recon.status !== 'needs_input') continue;
      if (!recon.dependencies.includes(taskId)) continue;

      const reconReset: TaskStateChanges = {
        status: 'pending',
        execution: { experimentResults: undefined },
      };
      this.writeAndSync(recon.id, reconReset);
      const reconDelta: TaskDelta = { type: 'updated', taskId: recon.id, changes: reconReset };
      this.persistence.logEvent?.(recon.id, 'task.pending', reconReset);
      this.messageBus.publish(TASK_DELTA_CHANNEL, reconDelta);
      console.log(`[orchestrator] restartTask "${taskId}": reset reconciliation "${recon.id}" back to pending`);
    }

    this.scheduler.completeJob(taskId);

    const readyTasks = this.stateMachine.getReadyTasks();
    const isReady = readyTasks.some((t) => t.id === taskId);
    console.log(`[orchestrator] restartTask "${taskId}": ready=${isReady}`);
    if (isReady) {
      return this.autoStartReadyTasks([taskId]);
    }

    return [this.stateMachine.getTask(taskId)!];
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
        prUrl: undefined,
        prIdentifier: undefined,
        prStatus: undefined,
      },
    };

    console.log(`[orchestrator] restartWorkflow: resetting ${allTasks.length} tasks for workflow ${workflowId}`);
    for (const task of allTasks) {
      console.log(`[orchestrator]   reset "${task.id}" (was ${task.status}, branch=${task.execution.branch ?? 'none'}, commit=${task.execution.commit?.slice(0, 7) ?? 'none'})`);
      this.writeAndSync(task.id, resetChanges);
      const delta: TaskDelta = { type: 'updated', taskId: task.id, changes: resetChanges };
      this.persistence.logEvent?.(task.id, 'task.pending', resetChanges);
      this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
      this.scheduler.completeJob(task.id);
    }

    return this.startExecution();
  }

  /**
   * Transition a failed task to running before an async conflict resolution.
   * Returns the saved error string so the caller can revert on failure.
   */
  beginConflictResolution(taskId: string): { savedError: string } {
    this.refreshFromDb();
    const task = this.stateMachine.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.status !== 'failed') throw new Error(`Task ${taskId} is not failed (status: ${task.status})`);

    const savedError = task.execution.error ?? '';

    const changes: TaskStateChanges = {
      status: 'running',
      execution: { isFixingWithAI: true, startedAt: new Date(), lastHeartbeatAt: new Date() },
    };
    this.writeAndSync(taskId, changes);
    const delta: TaskDelta = { type: 'updated', taskId, changes };
    this.persistence.logEvent?.(taskId, 'task.running', changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);

    return { savedError };
  }

  /**
   * Revert a conflict resolution attempt: restore the task to failed
   * with its original error and re-parsed mergeConflict field.
   */
  revertConflictResolution(taskId: string, savedError: string): void {
    this.refreshFromDb();

    let mergeConflict: { failedBranch: string; conflictFiles: string[] } | undefined;
    try {
      const obj = JSON.parse(savedError);
      if (obj?.type === 'merge_conflict') {
        mergeConflict = { failedBranch: obj.failedBranch, conflictFiles: obj.conflictFiles };
      }
    } catch { /* not JSON — normal error string */ }

    const changes: TaskStateChanges = {
      status: 'failed',
      execution: { error: savedError, mergeConflict, isFixingWithAI: undefined },
    };
    this.writeAndSync(taskId, changes);
    const delta: TaskDelta = { type: 'updated', taskId, changes };
    this.persistence.logEvent?.(taskId, 'task.failed', changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
  }

  /**
   * Edit a task's command, fork its downstream subtree, and restart it.
   */
  editTaskCommand(taskId: string, newCommand: string): TaskState[] {
    this.refreshFromDb();
    const task = this.stateMachine.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.config.isMergeNode) throw new Error(`Cannot edit merge node ${taskId}`);
    if (task.status === 'running') throw new Error(`Cannot edit running task ${taskId}`);

    const cmdChanges: TaskStateChanges = { config: { command: newCommand } };
    this.writeAndSync(taskId, cmdChanges);
    const cmdDelta: TaskDelta = { type: 'updated', taskId, changes: cmdChanges };
    this.persistence.logEvent?.(taskId, 'task.updated', cmdChanges);
    this.messageBus.publish(TASK_DELTA_CHANNEL, cmdDelta);

    // Create a fresh-start attempt with commandOverride (best-effort)
    try {
      if (this.persistence.loadAttempts && this.persistence.updateAttempt && this.persistence.saveAttempt && this.persistence.getNextAttemptNumber) {
        const attempts = this.persistence.loadAttempts(taskId);
        const current = attempts[attempts.length - 1];
        if (current && (current.status === 'running' || current.status === 'pending')) {
          this.persistence.updateAttempt(current.id, { status: 'superseded' });
        }
        const nextNum = this.persistence.getNextAttemptNumber(taskId);
        const freshAttempt = createAttempt(taskId, nextNum, {
          commandOverride: newCommand,
          supersedesAttemptId: current?.id,
        });
        this.persistence.saveAttempt(freshAttempt);
      }
    } catch { /* best effort */ }

    return this.restartTask(taskId);
  }

  /**
   * Change a task's executor type (familiarType) and restart it.
   * Does NOT fork the dirty subtree.
   */
  editTaskType(taskId: string, familiarType: string, remoteTargetId?: string): TaskState[] {
    this.refreshFromDb();
    const task = this.stateMachine.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.config.isMergeNode) throw new Error(`Cannot change executor type of merge node ${taskId}`);
    if (task.status === 'running') throw new Error(`Cannot edit running task ${taskId}`);

    const effectiveType = normalizeFamiliarType(familiarType) ?? familiarType;
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
    const task = this.stateMachine.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.status === 'running') throw new Error(`Cannot replace running task ${taskId}`);
    if (replacementTasks.length === 0) throw new Error('Must provide at least one replacement task');

    const replacementIds = new Set(replacementTasks.map((t) => t.id));

    // 1. Stale the broken task and all downstream (except merge node)
    const allTasks = this.stateMachine.getAllTasks();
    const taskMap = new Map(allTasks.map((t) => [t.id, t]));
    const descendantIds = getTransitiveDependents(
      taskId,
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
    this.writeAndSync(taskId, sourceChanges);
    this.persistence.logEvent?.(taskId, 'task.stale', sourceChanges);
    this.messageBus.publish(TASK_DELTA_CHANNEL, {
      type: 'updated', taskId, changes: sourceChanges,
    });

    // 2. Create replacement tasks
    for (const rt of replacementTasks) {
      const hasInternalDeps =
        rt.dependencies?.length && rt.dependencies.some((d) => replacementIds.has(d));
      const newTask = createTaskState(rt.id, rt.description, hasInternalDeps ? rt.dependencies! : [...task.dependencies], {
        workflowId: task.config.workflowId,
        command: rt.command,
        prompt: rt.prompt,
        familiarType: rt.familiarType ?? task.config.familiarType,
        autoFix: rt.autoFix,
        maxFixAttempts: rt.maxFixAttempts,
      });
      this.createAndSync(newTask);
      this.messageBus.publish(TASK_DELTA_CHANNEL, { type: 'created', task: newTask });
    }

    // 3. Reconcile merge node deps from actual graph state
    if (task.config.workflowId) {
      this.reconcileMergeLeaves(task.config.workflowId);
    }

    this.scheduler.completeJob(taskId);

    // Auto-start ready replacement root tasks
    const rootIds = replacementTasks
      .filter((rt) => {
        const hasInternalDeps =
          rt.dependencies?.length && rt.dependencies.some((d) => replacementIds.has(d));
        return !hasInternalDeps;
      })
      .map((rt) => rt.id);
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

  // ── Queries ───────────────────────────────────────────────

  getTask(taskId: string): TaskState | undefined {
    return this.stateMachine.getTask(taskId);
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
      running: tasks.filter((t) => t.status === 'running').length,
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

    const task = this.stateMachine.getTask(taskId);
    if (!task) throw new Error(`Task "${taskId}" not found`);

    const terminal = new Set(['completed', 'stale']);
    if (terminal.has(task.status)) {
      throw new Error(`Task "${taskId}" is already ${task.status}`);
    }

    // Find all transitive dependents, skipping completed/stale
    const allTasks = this.stateMachine.getAllTasks();
    const taskMap = new Map(allTasks.map(t => [t.id, t]));
    const descendantIds = getTransitiveDependents(
      taskId,
      taskMap,
      (t) => t.status === 'completed' || t.status === 'stale',
    );

    const toCancelIds = [taskId, ...descendantIds];
    const cancelled: string[] = [];
    const runningCancelled: string[] = [];

    for (const id of toCancelIds) {
      const t = this.stateMachine.getTask(id);
      if (!t || t.status === 'completed' || t.status === 'stale') continue;

      const wasRunning = t.status === 'running';

      // Free scheduler slot
      if (wasRunning) {
        this.scheduler.completeJob(id);
        runningCancelled.push(id);
      } else {
        this.scheduler.removeJob(id);
      }

      // Mark as failed
      const errorMsg = id === taskId
        ? 'Cancelled by user'
        : `Cancelled: upstream task "${taskId}" was cancelled`;
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
        description: this.stateMachine.getTask(j.taskId)?.description ?? '',
      })),
      queued: queuedJobs.map(j => ({
        taskId: j.taskId,
        priority: j.priority,
        utilization: j.utilization ?? 50,
        description: this.stateMachine.getTask(j.taskId)?.description ?? '',
      })),
    };
  }

  // ── Private: Response Handling ─────────────────────────────

  private handleCompleted(
    taskId: string,
    parsed: Extract<ParsedResponse, { type: 'completed' }>,
  ): TaskState[] {
    const changes: TaskStateChanges = {
      status: 'completed',
      config: { summary: parsed.summary },
      execution: {
        exitCode: parsed.exitCode,
        commit: parsed.commitHash,
        claudeSessionId: parsed.claudeSessionId,
        completedAt: new Date(),
      },
    };
    this.writeAndSync(taskId, changes);
    const delta: TaskDelta = { type: 'updated', taskId, changes };
    this.persistence.logEvent?.(taskId, 'task.completed', changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);

    // Dual-write: update latest Attempt to completed, auto-select (best-effort)
    try {
      if (this.persistence.loadAttempts && this.persistence.updateAttempt) {
        const attempts = this.persistence.loadAttempts(taskId);
        const latest = attempts[attempts.length - 1];
        if (latest && latest.status === 'running') {
          this.persistence.updateAttempt(latest.id, {
            status: 'completed',
            exitCode: parsed.exitCode,
            commit: parsed.commitHash,
            claudeSessionId: parsed.claudeSessionId,
            completedAt: new Date(),
          });
          // Auto-select this attempt
          const selectChanges: TaskStateChanges = { execution: { selectedAttemptId: latest.id } };
          this.writeAndSync(taskId, selectChanges);
        }
      }
    } catch { /* best effort */ }

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
      if (this.persistence.loadAttempts && this.persistence.updateAttempt) {
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
      }
    } catch { /* best effort */ }

    this.checkExperimentCompletion(taskId);
    this.checkWorkflowCompletion();
    return [];
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
    const parentTask = this.stateMachine.getTask(taskId);
    const wfId = parentTask?.config.workflowId;

    const experimentTasks: GraphMutationNodeDef[] = parsed.variants.map((v) => ({
      id: v.id,
      description: v.description ?? `Experiment: ${v.id}`,
      dependencies: [taskId],
      workflowId: wfId,
      parentTask: taskId,
      experimentPrompt: v.prompt,
      prompt: v.prompt,
      command: v.command,
      repoUrl: parentTask?.config.repoUrl,
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

    this.applyGraphMutation({
      sourceNodeId: taskId,
      sourceDisposition: 'complete',
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
      if (recon.status === 'needs_input' || recon.status === 'completed') continue;
      if (!recon.dependencies.includes(taskId)) continue;

      const allReported = recon.dependencies.every((depId) => {
        const dep = this.stateMachine.getTask(depId);
        return dep && (dep.status === 'completed' || dep.status === 'failed');
      });

      if (allReported) {
        const experimentResults = recon.dependencies.map((depId) => {
          const dep = this.stateMachine.getTask(depId)!;
          return {
            id: depId,
            status: (dep.status === 'completed' ? 'completed' : 'failed') as 'completed' | 'failed',
            summary: dep.config.summary,
            exitCode: dep.execution.exitCode,
          };
        });

        const reconChanges: TaskStateChanges = {
          status: 'needs_input',
          execution: { experimentResults },
        };
        this.writeAndSync(recon.id, reconChanges);
        const delta: TaskDelta = { type: 'updated', taskId: recon.id, changes: reconChanges };
        this.persistence.logEvent?.(recon.id, 'task.needs_input', reconChanges);
        this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
      }
    }
  }

  private buildAutoFixResponse(task: TaskState, outputs: WorkResponse['outputs']): WorkResponse {
    const maxAttempts = task.config.maxFixAttempts ?? 3;
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
    ].slice(0, maxAttempts);

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
      const task = this.stateMachine.getTask(taskId);
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
      const task = this.stateMachine.getTask(runningId);
      if (!task || task.status !== 'running') {
        console.warn(`[orchestrator] drainScheduler: freeing leaked scheduler slot for "${runningId}" (actual status: ${task?.status ?? 'not found'})`);
        this.scheduler.completeJob(runningId);
      }
    }

    const started: TaskState[] = [];
    let job = this.scheduler.dequeue();
    while (job) {
      const task = this.stateMachine.getTask(job.taskId);
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
        if (this.persistence.getNextAttemptNumber && this.persistence.saveAttempt) {
          const attemptNum = this.persistence.getNextAttemptNumber(job.taskId);
          const attempt = createAttempt(job.taskId, attemptNum, {
            status: 'running',
            startedAt: now,
          });
          this.persistence.saveAttempt(attempt);
        }
      } catch { /* best effort — never break existing flow */ }

      job = this.scheduler.dequeue();
    }
    return started;
  }
}
