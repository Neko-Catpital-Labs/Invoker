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

import { TaskStateMachine } from './state-machine.js';
import { ResponseHandler } from './response-handler.js';
import type { ParsedResponse } from './response-handler.js';
import { TaskScheduler } from './scheduler.js';
import { ResourceEstimator } from './resource-estimator.js';
import type { UtilizationRule } from './resource-estimator.js';
import type { TaskState, TaskDelta, TaskStateChanges, TaskCreateOptions } from './task-types.js';
import { createTaskState } from './task-types.js';
import type { WorkResponse } from '@invoker/protocol';
import { getTransitiveDependents, nextVersion, findLeafTaskIds } from './dag.js';
import { ActionGraph } from '@invoker/graph';

// ── Channel Constants ───────────────────────────────────────

const TASK_DELTA_CHANNEL = 'task.delta';
let workflowCounter = 0;

// ── Adapter Interfaces ──────────────────────────────────────

export interface OrchestratorPersistence {
  saveWorkflow(workflow: {
    id: string;
    name: string;
    status: 'running' | 'completed' | 'failed';
    createdAt: string;
    updatedAt: string;
    onFinish?: string;
    baseBranch?: string;
    featureBranch?: string;
    mergeMode?: 'manual' | 'automatic';
  }): void;
  updateWorkflow?(workflowId: string, changes: { status?: string; updatedAt?: string }): void;
  saveTask(workflowId: string, task: TaskState): void;
  updateTask(taskId: string, changes: TaskStateChanges): void;
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
  listWorkflows(): Array<{
    id: string;
    name: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  }>;
  loadTasks(workflowId: string): TaskState[];
}

export interface OrchestratorMessageBus {
  publish<T>(channel: string, message: T): void;
}

// ── Public Types ────────────────────────────────────────────

export interface PlanDefinition {
  name: string;
  onFinish?: 'none' | 'merge' | 'pull_request';
  baseBranch?: string;
  featureBranch?: string;
  mergeMode?: 'manual' | 'automatic';
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

  private activeWorkflowIds = new Set<string>();

  constructor(config: OrchestratorConfig) {
    this.maxConcurrency = config.maxConcurrency ?? 3;
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
  loadPlan(plan: PlanDefinition): void {
    const workflowId = `wf-${Date.now()}-${++workflowCounter}`;
    this.activeWorkflowIds.add(workflowId);

    this.persistence.saveWorkflow({
      id: workflowId,
      name: plan.name,
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
          familiarType: taskDef.familiarType ?? (taskDef.command ? 'local' : 'worktree'),
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
      return [];
    }

    const taskId = parsed.taskId;
    const task = this.stateMachine.getTask(taskId);
    if (!task) {
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
  setTaskAwaitingApproval(taskId: string): void {
    this.refreshFromDb();
    const task = this.stateMachine.getTask(taskId);
    if (!task) return;

    this.scheduler.completeJob(taskId);

    const changes: TaskStateChanges = {
      status: 'awaiting_approval',
      execution: { completedAt: new Date() },
    };
    this.writeAndSync(taskId, changes);
    const delta: TaskDelta = { type: 'updated', taskId, changes };
    this.persistence.logEvent?.(taskId, 'task.awaiting_approval', changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
  }

  /**
   * Approve a task awaiting approval. Completes it and unblocks dependents.
   */
  approve(taskId: string): void {
    this.refreshFromDb();
    const task = this.stateMachine.getTask(taskId);
    if (!task || task.status !== 'awaiting_approval') return;

    const changes: TaskStateChanges = {
      status: 'completed',
      execution: { completedAt: new Date() },
    };
    this.writeAndSync(taskId, changes);
    const delta: TaskDelta = { type: 'updated', taskId, changes };
    this.persistence.logEvent?.(taskId, 'task.completed', changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);

    const readyTaskIds = this.stateMachine.findNewlyReadyTasks(taskId);
    this.autoStartReadyTasks(readyTaskIds);
    this.checkWorkflowCompletion();
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

    this.blockDependents(taskId);
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

    const prevStatus = task.status;
    console.log(`[orchestrator] restartTask "${taskId}" (was ${prevStatus})`);

    const completedDownstream = this.stateMachine.getAllTasks().filter(
      t => t.status === 'completed' && t.dependencies.includes(taskId),
    );
    if (completedDownstream.length > 0 && prevStatus === 'completed') {
      console.warn(`[orchestrator] restartTask "${taskId}": ${completedDownstream.length} downstream task(s) are completed and will NOT be invalidated: [${completedDownstream.map(t => t.id).join(', ')}]`);
    }

    const resetChanges: TaskStateChanges = {
      status: 'pending',
      config: { summary: undefined },
      execution: {
        startedAt: undefined,
        completedAt: undefined,
        error: undefined,
        exitCode: undefined,
        blockedBy: undefined,
        commit: undefined,
      },
    };
    this.writeAndSync(taskId, resetChanges);
    const resetDelta: TaskDelta = { type: 'updated', taskId, changes: resetChanges };
    this.persistence.logEvent?.(taskId, 'task.pending', resetChanges);
    this.messageBus.publish(TASK_DELTA_CHANNEL, resetDelta);

    // Unblock dependents
    const unblockedIds = this.stateMachine.computeTasksToUnblock(taskId);
    console.log(`[orchestrator] restartTask "${taskId}": unblocked ${unblockedIds.length} tasks: [${unblockedIds.join(', ')}]`);

    const blockedByOther = this.stateMachine.getAllTasks().filter(
      t => t.status === 'blocked' && t.dependencies.includes(taskId) && t.execution.blockedBy !== taskId,
    );
    if (blockedByOther.length > 0) {
      console.warn(`[orchestrator] restartTask "${taskId}": ${blockedByOther.length} task(s) depend on "${taskId}" but are blocked by a different task: ${blockedByOther.map(t => `"${t.id}" (blockedBy: ${t.execution.blockedBy})`).join(', ')}`);
    }

    for (const id of unblockedIds) {
      const t = this.stateMachine.getTask(id);
      const failedDeps = t?.dependencies.filter(depId => {
        const dep = this.stateMachine.getTask(depId);
        return dep?.status === 'failed';
      }) ?? [];
      if (failedDeps.length > 0) {
        console.warn(`[orchestrator] restartTask: unblocking "${id}" but it still has failed deps: [${failedDeps.join(', ')}]`);
      }

      const unblockChanges: TaskStateChanges = { status: 'pending', execution: { blockedBy: undefined } };
      this.writeAndSync(id, unblockChanges);
      const unblockDelta: TaskDelta = { type: 'updated', taskId: id, changes: unblockChanges };
      this.persistence.logEvent?.(id, 'task.pending', unblockChanges);
      this.messageBus.publish(TASK_DELTA_CHANNEL, unblockDelta);
    }

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
        blockedBy: undefined,
        commit: undefined,
        branch: undefined,
        workspacePath: undefined,
      },
    };

    for (const task of allTasks) {
      this.writeAndSync(task.id, resetChanges);
      const delta: TaskDelta = { type: 'updated', taskId: task.id, changes: resetChanges };
      this.persistence.logEvent?.(task.id, 'task.pending', resetChanges);
      this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
      this.scheduler.completeJob(task.id);
    }

    return this.startExecution();
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

    this.forkDirtySubtree(taskId);

    return this.restartTask(taskId);
  }

  /**
   * Change a task's executor type (familiarType) and restart it.
   * Does NOT fork the dirty subtree.
   */
  editTaskType(taskId: string, familiarType: string): TaskState[] {
    this.refreshFromDb();
    const task = this.stateMachine.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.config.isMergeNode) throw new Error(`Cannot change executor type of merge node ${taskId}`);
    if (task.status === 'running') throw new Error(`Cannot edit running task ${taskId}`);

    const typeChanges: TaskStateChanges = { config: { familiarType } };
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
   * Fork the subtree downstream of a dirty task.
   *
   * @param depOverrides Optional map of dependency ID replacements applied
   *   before the clone ID map. Use this to point forked clones at a
   *   replacement node instead of the original dirty task.
   */
  forkDirtySubtree(dirtyTaskId: string, depOverrides?: Map<string, string>): TaskDelta[] {
    const allTasks = this.stateMachine.getAllTasks();
    const taskMap = new Map(allTasks.map((t) => [t.id, t]));

    // Skip merge nodes: they are terminal and should not be forked
    const descendantIds = getTransitiveDependents(
      dirtyTaskId,
      taskMap,
      (t) => !!t.config.isMergeNode,
    );
    if (descendantIds.length === 0) {
      // No non-merge descendants; reconcile merge leaves from graph state
      const dirtyTask = taskMap.get(dirtyTaskId);
      if (dirtyTask?.config.workflowId) {
        this.reconcileMergeLeaves(dirtyTask.config.workflowId);
      }
      return [];
    }

    const deltas: TaskDelta[] = [];

    // Mark descendants as stale
    for (const id of descendantIds) {
      const t = this.stateMachine.getTask(id);
      if (!t) continue;
      const staleChanges: TaskStateChanges = { status: 'stale' };
      this.writeAndSync(id, staleChanges);
      const delta: TaskDelta = { type: 'updated', taskId: id, changes: staleChanges };
      this.persistence.logEvent?.(id, 'task.stale', staleChanges);
      this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
      deltas.push(delta);
    }

    // Build ID mapping: original → clone
    const idMap = new Map<string, string>();
    for (const id of descendantIds) {
      idMap.set(id, nextVersion(id));
    }

    // Create cloned tasks with remapped dependencies
    for (const originalId of descendantIds) {
      const original = taskMap.get(originalId);
      if (!original) continue;

      const cloneId = idMap.get(originalId)!;
      const remappedDeps = original.dependencies.map((dep) =>
        depOverrides?.get(dep) ?? idMap.get(dep) ?? dep,
      );

      const cloneTask = createTaskState(cloneId, original.description, remappedDeps as string[], original.config);

      this.createAndSync(cloneTask);
      const delta: TaskDelta = { type: 'created', task: cloneTask };
      this.persistence.logEvent?.(cloneId, 'task.created');
      this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
      deltas.push(delta);
    }

    // Reconcile merge node deps from actual graph state
    const dirtyTask = taskMap.get(dirtyTaskId);
    if (dirtyTask?.config.workflowId) {
      this.reconcileMergeLeaves(dirtyTask.config.workflowId);
    }

    return deltas;
  }

  /**
   * Recompute the merge node's dependencies from the actual graph state.
   * Active (non-stale, non-merge) leaf tasks become the merge gate's deps.
   * No-ops if deps are already correct.
   */
  private reconcileMergeLeaves(workflowId: string): void {
    const mergeNode = this.getMergeNode(workflowId);
    if (!mergeNode) return;

    const allTasks = this.stateMachine.getAllTasks();
    const activeTasks = allTasks.filter(
      (t) =>
        t.config.workflowId === workflowId &&
        !t.config.isMergeNode &&
        t.status !== 'stale',
    );
    const leafIds = findLeafTaskIds(activeTasks);

    const currentDeps = new Set(mergeNode.dependencies);
    const newDepsSet = new Set(leafIds);
    if (
      currentDeps.size === newDepsSet.size &&
      [...currentDeps].every((d) => newDepsSet.has(d))
    ) {
      return;
    }

    const changes: TaskStateChanges = {
      dependencies: leafIds,
      status: 'pending',
      execution: { blockedBy: undefined },
    };
    this.writeAndSync(mergeNode.id, changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, {
      type: 'updated',
      taskId: mergeNode.id,
      changes,
    });
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
    const completed = this.writeAndSync(taskId, changes);
    const delta: TaskDelta = { type: 'updated', taskId, changes };
    this.persistence.logEvent?.(taskId, 'task.completed', changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);

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
    const failed = this.writeAndSync(taskId, changes);
    const delta: TaskDelta = { type: 'updated', taskId, changes };
    this.persistence.logEvent?.(taskId, 'task.failed', changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);

    this.blockDependents(taskId);
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
    const allDeltas: TaskDelta[] = [];

    // 1. Fork downstream with dep override: sourceNode → outputNode
    const forkDeltas = this.forkDirtySubtree(
      mutation.sourceNodeId,
      new Map([[mutation.sourceNodeId, mutation.outputNodeId]]),
    );
    allDeltas.push(...forkDeltas);

    // 2. Apply source disposition
    const baseChanges: TaskStateChanges = mutation.sourceDisposition === 'complete'
      ? { status: 'completed' as const, execution: { completedAt: new Date() } }
      : { status: 'stale' as const };
    const sourceChanges: TaskStateChanges = {
      ...baseChanges,
      ...mutation.sourceChanges,
      config: { ...baseChanges.config, ...mutation.sourceChanges?.config },
      execution: { ...baseChanges.execution, ...mutation.sourceChanges?.execution },
    };
    this.writeAndSync(mutation.sourceNodeId, sourceChanges);
    const sourceDelta: TaskDelta = {
      type: 'updated',
      taskId: mutation.sourceNodeId,
      changes: sourceChanges,
    };
    this.persistence.logEvent?.(
      mutation.sourceNodeId,
      mutation.sourceDisposition === 'complete' ? 'task.completed' : 'task.stale',
      sourceChanges,
    );
    this.messageBus.publish(TASK_DELTA_CHANNEL, sourceDelta);
    allDeltas.push(sourceDelta);

    // 3. Create new nodes
    for (const nodeDef of mutation.newNodes) {
      const task = createTaskState(nodeDef.id, nodeDef.description, nodeDef.dependencies, {
        workflowId: nodeDef.workflowId,
        parentTask: nodeDef.parentTask,
        experimentPrompt: nodeDef.experimentPrompt,
        prompt: nodeDef.prompt,
        command: nodeDef.command,
        repoUrl: nodeDef.repoUrl,
        familiarType: nodeDef.familiarType,
        isReconciliation: nodeDef.isReconciliation,
        requiresManualApproval: nodeDef.requiresManualApproval,
        autoFix: nodeDef.autoFix,
        maxFixAttempts: nodeDef.maxFixAttempts,
        isMergeNode: nodeDef.isMergeNode,
      });
      this.createAndSync(task);
      const delta: TaskDelta = { type: 'created', task };
      this.persistence.logEvent?.(task.id, 'task.created');
      this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
      allDeltas.push(delta);
    }

    // 4. Reconcile merge leaves now that new nodes exist in the graph
    const sourceTask = this.stateMachine.getTask(mutation.sourceNodeId);
    if (sourceTask?.config.workflowId) {
      this.reconcileMergeLeaves(sourceTask.config.workflowId);
    }

    return allDeltas;
  }

  // ── Private: Helpers ──────────────────────────────────────

  private blockDependents(failedTaskId: string): void {
    const toBlock = this.stateMachine.computeTasksToBlock(failedTaskId);
    for (const id of toBlock) {
      const existing = this.stateMachine.getTask(id);
      if (existing?.execution.blockedBy && existing.execution.blockedBy !== failedTaskId) {
        console.warn(`[orchestrator] blockDependents: "${id}" blockedBy overwritten from "${existing.execution.blockedBy}" to "${failedTaskId}"`);
      }

      const blockChanges: TaskStateChanges = { status: 'blocked', execution: { blockedBy: failedTaskId } };
      this.writeAndSync(id, blockChanges);
      const delta: TaskDelta = { type: 'updated', taskId: id, changes: blockChanges };
      this.persistence.logEvent?.(id, 'task.blocked', blockChanges);
      this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
    }
  }

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
      const utilization = task ? this.estimator.estimateUtilization(task) : 50;
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
      if (!task || task.status !== 'pending') {
        this.scheduler.completeJob(job.taskId);
        job = this.scheduler.dequeue();
        continue;
      }

      const changes: TaskStateChanges = {
        status: 'running',
        execution: { startedAt: new Date() },
      };
      const updated = this.writeAndSync(job.taskId, changes);
      started.push(updated);

      const delta: TaskDelta = { type: 'updated', taskId: job.taskId, changes };
      this.persistence.logEvent?.(job.taskId, 'task.running', changes);
      this.messageBus.publish(TASK_DELTA_CHANNEL, delta);

      job = this.scheduler.dequeue();
    }
    return started;
  }
}
