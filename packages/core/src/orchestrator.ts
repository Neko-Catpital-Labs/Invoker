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
import { ExperimentManager } from './experiments.js';
import { ResponseHandler } from './response-handler.js';
import type { ParsedResponse } from './response-handler.js';
import { TaskScheduler } from './scheduler.js';
import type { TaskState, TaskDelta, TaskCreateOptions } from './task-types.js';
import { createTaskState } from './task-types.js';
import type { WorkResponse } from '@invoker/protocol';
import { getTransitiveDependents, nextVersion } from './dag.js';
import { ActionGraph } from '@invoker/graph';

// ── Channel Constants ───────────────────────────────────────

const TASK_DELTA_CHANNEL = 'task.delta';

// ── Adapter Interfaces ──────────────────────────────────────

export interface OrchestratorPersistence {
  saveWorkflow(workflow: {
    id: string;
    name: string;
    status: 'running' | 'completed' | 'failed';
    createdAt: string;
    updatedAt: string;
  }): void;
  updateWorkflow?(workflowId: string, changes: { status?: string; updatedAt?: string }): void;
  saveTask(workflowId: string, task: TaskState): void;
  updateTask(taskId: string, changes: Partial<TaskState>): void;
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
  loadWorkflows?(): Array<{
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

export interface OrchestratorConfig {
  persistence: OrchestratorPersistence;
  messageBus: OrchestratorMessageBus;
  maxConcurrency?: number;
}

// ── Orchestrator ────────────────────────────────────────────

export class Orchestrator {
  private readonly stateMachine: TaskStateMachine;
  private readonly experimentManager: ExperimentManager;
  private readonly responseHandler: ResponseHandler;
  private readonly scheduler: TaskScheduler;
  private readonly persistence: OrchestratorPersistence;
  private readonly messageBus: OrchestratorMessageBus;
  private readonly maxConcurrency: number;

  private workflowId: string | undefined;

  constructor(config: OrchestratorConfig) {
    this.maxConcurrency = config.maxConcurrency ?? 3;
    this.persistence = config.persistence;
    this.messageBus = config.messageBus;

    this.stateMachine = new TaskStateMachine(new ActionGraph());
    this.experimentManager = new ExperimentManager();
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
    if (!this.workflowId) return;
    this.stateMachine.clear();
    const tasks = this.persistence.loadTasks(this.workflowId);
    for (const task of tasks) {
      this.stateMachine.restoreTask(task);
    }
  }

  /**
   * Write field changes to the DB, then update the in-memory cache
   * to match. Returns the updated task state.
   */
  private writeAndSync(taskId: string, changes: Partial<TaskState>): TaskState {
    this.persistence.updateTask(taskId, changes);

    const existing = this.stateMachine.getTask(taskId);
    if (!existing) {
      throw new Error(`writeAndSync: task ${taskId} not found in graph`);
    }
    const updated: TaskState = { ...existing, ...changes } as TaskState;
    this.stateMachine.restoreTask(updated);
    return updated;
  }

  /**
   * Create a new task: save to DB, then add to the in-memory cache.
   * Returns the new task state.
   */
  private createAndSync(task: TaskState): TaskState {
    if (!this.workflowId) {
      throw new Error('createAndSync: no workflowId set');
    }
    this.persistence.saveTask(this.workflowId, task);
    this.stateMachine.restoreTask(task);
    return task;
  }

  // ── Commands ──────────────────────────────────────────────

  /**
   * Parse a plan definition and create tasks with dependencies.
   * Persists workflow and tasks, publishes deltas via MessageBus.
   */
  loadPlan(plan: PlanDefinition): void {
    this.stateMachine.clear();

    const workflowId = `wf-${Date.now()}`;
    this.workflowId = workflowId;

    this.persistence.saveWorkflow({
      id: workflowId,
      name: plan.name,
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const deltas: TaskDelta[] = [];
    for (const taskDef of plan.tasks) {
      const task = createTaskState(
        taskDef.id,
        taskDef.description,
        taskDef.dependencies ?? [],
        {
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

    for (const delta of deltas) {
      this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
    }
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
      this.scheduler.enqueue({ taskId: task.id, priority: 0 });
    }

    let job = this.scheduler.dequeue();
    while (job) {
      const task = this.stateMachine.getTask(job.taskId);
      if (!task || task.status !== 'pending') {
        this.scheduler.completeJob(job.taskId);
        job = this.scheduler.dequeue();
        continue;
      }

      const changes: Partial<TaskState> = {
        status: 'running',
        startedAt: new Date(),
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

  /**
   * Route a worker response through the pure parser, then apply
   * the parsed result via DB writes.
   */
  handleWorkerResponse(response: WorkResponse): TaskState[] {
    this.refreshFromDb();

    // Auto-fix interception
    if (response.status === 'failed') {
      const task = this.stateMachine.getTask(response.actionId);
      if (task?.autoFix) {
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

    const changes: Partial<TaskState> = { status: 'running', inputPrompt: undefined };
    this.writeAndSync(taskId, changes);
    const delta: TaskDelta = { type: 'updated', taskId, changes };
    this.persistence.logEvent?.(taskId, 'task.running', changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
  }

  /**
   * Approve a task awaiting approval. Completes it and unblocks dependents.
   */
  approve(taskId: string): void {
    this.refreshFromDb();
    const task = this.stateMachine.getTask(taskId);
    if (!task || task.status !== 'awaiting_approval') return;

    const changes: Partial<TaskState> = {
      status: 'completed',
      completedAt: new Date(),
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

    const changes: Partial<TaskState> = {
      status: 'failed',
      error: reason ?? 'Rejected',
      completedAt: new Date(),
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
    if (!task || !task.isReconciliation) return [];

    const changes: Partial<TaskState> = {
      status: 'completed',
      selectedExperiment: experimentId,
      completedAt: new Date(),
    };
    this.writeAndSync(taskId, changes);
    const delta: TaskDelta = { type: 'updated', taskId, changes };
    this.persistence.logEvent?.(taskId, 'task.completed', changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);

    const readyTaskIds = this.stateMachine.findNewlyReadyTasks(taskId);
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

    const resetChanges: Partial<TaskState> = {
      status: 'pending',
      startedAt: undefined,
      completedAt: undefined,
      error: undefined,
      exitCode: undefined,
      blockedBy: undefined,
      summary: undefined,
      commit: undefined,
    };
    this.writeAndSync(taskId, resetChanges);
    const resetDelta: TaskDelta = { type: 'updated', taskId, changes: resetChanges };
    this.persistence.logEvent?.(taskId, 'task.pending', resetChanges);
    this.messageBus.publish(TASK_DELTA_CHANNEL, resetDelta);

    // Unblock dependents
    const unblockedIds = this.stateMachine.computeTasksToUnblock(taskId);
    for (const id of unblockedIds) {
      const unblockChanges: Partial<TaskState> = { status: 'pending', blockedBy: undefined };
      this.writeAndSync(id, unblockChanges);
      const unblockDelta: TaskDelta = { type: 'updated', taskId: id, changes: unblockChanges };
      this.persistence.logEvent?.(id, 'task.pending', unblockChanges);
      this.messageBus.publish(TASK_DELTA_CHANNEL, unblockDelta);
    }

    this.scheduler.completeJob(taskId);

    const readyTasks = this.stateMachine.getReadyTasks();
    const isReady = readyTasks.some((t) => t.id === taskId);
    if (isReady) {
      return this.autoStartReadyTasks([taskId]);
    }

    return [this.stateMachine.getTask(taskId)!];
  }

  /**
   * Edit a task's command, fork its downstream subtree, and restart it.
   */
  editTaskCommand(taskId: string, newCommand: string): TaskState[] {
    this.refreshFromDb();
    const task = this.stateMachine.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.status === 'running') throw new Error(`Cannot edit running task ${taskId}`);

    const cmdChanges: Partial<TaskState> = { command: newCommand };
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
    if (task.status === 'running') throw new Error(`Cannot edit running task ${taskId}`);

    const typeChanges: Partial<TaskState> = { familiarType };
    this.writeAndSync(taskId, typeChanges);
    const typeDelta: TaskDelta = { type: 'updated', taskId, changes: typeChanges };
    this.persistence.logEvent?.(taskId, 'task.updated', typeChanges);
    this.messageBus.publish(TASK_DELTA_CHANNEL, typeDelta);

    return this.restartTask(taskId);
  }

  /**
   * Fork the subtree downstream of a dirty task.
   */
  forkDirtySubtree(dirtyTaskId: string): TaskDelta[] {
    const allTasks = this.stateMachine.getAllTasks();
    const taskMap = new Map(allTasks.map((t) => [t.id, t]));

    const descendantIds = getTransitiveDependents(dirtyTaskId, taskMap);
    if (descendantIds.length === 0) return [];

    const deltas: TaskDelta[] = [];

    // Mark descendants as stale
    for (const id of descendantIds) {
      const t = this.stateMachine.getTask(id);
      if (!t) continue;
      const staleChanges: Partial<TaskState> = { status: 'stale' };
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
      const remappedDeps = original.dependencies.map((dep) => idMap.get(dep) ?? dep);

      const cloneTask = createTaskState(cloneId, original.description, remappedDeps as string[], {
        command: original.command,
        prompt: original.prompt,
        pivot: original.pivot,
        requiresManualApproval: original.requiresManualApproval,
        repoUrl: original.repoUrl,
        featureBranch: original.featureBranch,
        familiarType: original.familiarType,
        autoFix: original.autoFix,
        maxFixAttempts: original.maxFixAttempts,
      });

      this.createAndSync(cloneTask);
      const delta: TaskDelta = { type: 'created', task: cloneTask };
      this.persistence.logEvent?.(cloneId, 'task.created');
      this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
      deltas.push(delta);
    }

    return deltas;
  }

  /**
   * Load tasks from persistence into the state machine.
   * Safe to call at any time (startup, db-poll, view switch).
   */
  syncFromDb(workflowId: string): void {
    this.workflowId = workflowId;
    this.stateMachine.clear();
    const tasks = this.persistence.loadTasks(workflowId);
    for (const task of tasks) {
      this.stateMachine.restoreTask(task);
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

  getWorkflowStatus(): {
    total: number;
    completed: number;
    failed: number;
    running: number;
    pending: number;
  } {
    const tasks = this.stateMachine.getAllTasks();
    return {
      total: tasks.length,
      completed: tasks.filter((t) => t.status === 'completed').length,
      failed: tasks.filter((t) => t.status === 'failed').length,
      running: tasks.filter((t) => t.status === 'running').length,
      pending: tasks.filter((t) => t.status === 'pending').length,
    };
  }

  // ── Private: Response Handling ─────────────────────────────

  private handleCompleted(
    taskId: string,
    parsed: Extract<ParsedResponse, { type: 'completed' }>,
  ): TaskState[] {
    const changes: Partial<TaskState> = {
      status: 'completed',
      exitCode: parsed.exitCode,
      summary: parsed.summary,
      commit: parsed.commitHash,
      claudeSessionId: parsed.claudeSessionId,
      completedAt: new Date(),
    };
    this.writeAndSync(taskId, changes);
    const delta: TaskDelta = { type: 'updated', taskId, changes };
    this.persistence.logEvent?.(taskId, 'task.completed', changes);
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);

    this.checkExperimentCompletion(taskId);

    const readyTaskIds = this.stateMachine.findNewlyReadyTasks(taskId);
    const started = this.autoStartReadyTasks(readyTaskIds);
    this.checkWorkflowCompletion();
    return started;
  }

  private handleFailed(
    taskId: string,
    parsed: Extract<ParsedResponse, { type: 'failed' }>,
  ): TaskState[] {
    const changes: Partial<TaskState> = {
      status: 'failed',
      exitCode: parsed.exitCode,
      error: parsed.error,
      completedAt: new Date(),
    };
    this.writeAndSync(taskId, changes);
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
    const changes: Partial<TaskState> = {
      status: 'needs_input',
      inputPrompt: parsed.prompt,
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
    // Complete the parent (pivot) task
    const completionChanges: Partial<TaskState> = {
      status: 'completed',
      completedAt: new Date(),
    };
    this.writeAndSync(taskId, completionChanges);
    const completionDelta: TaskDelta = { type: 'updated', taskId, changes: completionChanges };
    this.persistence.logEvent?.(taskId, 'task.completed', completionChanges);
    this.messageBus.publish(TASK_DELTA_CHANNEL, completionDelta);

    // Plan experiment group
    const parentTask = this.stateMachine.getTask(taskId);
    const plan = this.experimentManager.planExperimentGroup(
      taskId,
      parsed.variants.map((v) => ({
        id: v.id,
        description: v.description ?? `Experiment: ${v.id}`,
        prompt: v.prompt,
        command: v.command,
      })),
      parentTask?.repoUrl,
      parentTask?.familiarType,
    );

    const allDeltas: TaskDelta[] = [completionDelta];

    // Create experiment tasks
    for (const planned of plan.experimentTasks) {
      const task = createTaskState(planned.id, planned.description, planned.dependencies, {
        parentTask: planned.parentTask,
        experimentPrompt: planned.experimentPrompt,
        prompt: planned.prompt,
        command: planned.command,
        repoUrl: planned.repoUrl,
        familiarType: planned.familiarType,
      });
      this.createAndSync(task);
      const delta: TaskDelta = { type: 'created', task };
      this.persistence.logEvent?.(task.id, 'task.created');
      this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
      allDeltas.push(delta);
    }

    // Create reconciliation task
    const reconTask = createTaskState(
      plan.reconciliationTask.id,
      plan.reconciliationTask.description,
      plan.reconciliationTask.dependencies,
      {
        parentTask: plan.reconciliationTask.parentTask,
        isReconciliation: plan.reconciliationTask.isReconciliation,
        requiresManualApproval: plan.reconciliationTask.requiresManualApproval,
      },
    );
    this.createAndSync(reconTask);
    const reconDelta: TaskDelta = { type: 'created', task: reconTask };
    this.persistence.logEvent?.(reconTask.id, 'task.created');
    this.messageBus.publish(TASK_DELTA_CHANNEL, reconDelta);
    allDeltas.push(reconDelta);

    // Apply dependency rewrites to existing tasks
    for (const rewrite of plan.rewrites) {
      this.applyDependencyRewrite(rewrite.fromDep, rewrite.toDep);
    }

    // Auto-start the experiment tasks (they depend on the now-completed pivot)
    const readyIds = plan.experimentTasks.map((t) => t.id);
    const started = this.autoStartReadyTasks(readyIds);
    return started;
  }

  private handleSelectExperiment(
    taskId: string,
    parsed: Extract<ParsedResponse, { type: 'select_experiment' }>,
  ): TaskState[] {
    return this.selectExperiment(taskId, parsed.experimentId);
  }

  // ── Private: Helpers ──────────────────────────────────────

  private blockDependents(failedTaskId: string): void {
    const toBlock = this.stateMachine.computeTasksToBlock(failedTaskId);
    for (const id of toBlock) {
      const blockChanges: Partial<TaskState> = { status: 'blocked', blockedBy: failedTaskId };
      this.writeAndSync(id, blockChanges);
      const delta: TaskDelta = { type: 'updated', taskId: id, changes: blockChanges };
      this.persistence.logEvent?.(id, 'task.blocked', blockChanges);
      this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
    }
  }

  private applyDependencyRewrite(fromDep: string, toDep: string): void {
    for (const task of this.stateMachine.getAllTasks()) {
      if (!task.dependencies.includes(fromDep)) continue;
      if (task.id === toDep) continue; // don't rewrite the recon task itself

      const newDeps = task.dependencies.map((d) => (d === fromDep ? toDep : d));
      const changes: Partial<TaskState> = { dependencies: newDeps };
      this.writeAndSync(task.id, changes);
      const delta: TaskDelta = { type: 'updated', taskId: task.id, changes };
      this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
    }
  }

  private checkExperimentCompletion(taskId: string): void {
    const task = this.stateMachine.getTask(taskId);
    if (!task) return;

    const result = this.experimentManager.onExperimentCompleted(taskId, {
      id: taskId,
      status: task.status === 'completed' ? 'completed' : 'failed',
      summary: task.summary,
      exitCode: task.exitCode,
    });

    if (!result) return;

    if (result.allDone) {
      const reconId = result.group.reconciliationTaskId;
      const reconTask = this.stateMachine.getTask(reconId);
      if (reconTask) {
        const reconChanges: Partial<TaskState> = {
          status: 'needs_input',
          experimentResults: Array.from(result.group.completedExperiments.values()),
        };
        this.writeAndSync(reconId, reconChanges);
        const delta: TaskDelta = { type: 'updated', taskId: reconId, changes: reconChanges };
        this.persistence.logEvent?.(reconId, 'task.needs_input', reconChanges);
        this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
      }
    }
  }

  private buildAutoFixResponse(task: TaskState, outputs: WorkResponse['outputs']): WorkResponse {
    const maxAttempts = task.maxFixAttempts ?? 3;
    const errorMsg = outputs.error ?? `Task failed with exit code ${outputs.exitCode ?? 1}`;

    const variants = [
      {
        id: 'fix-conservative',
        description: 'Conservative fix: minimal change to fix the error',
        prompt: `The following task failed. Apply the MINIMAL change needed to fix this specific error.\n\nOriginal task: ${task.description}\nOriginal prompt: ${task.prompt ?? task.command ?? 'N/A'}\nError: ${errorMsg}\n\nFix the error with the smallest possible change. Do not refactor or restructure.`,
      },
      {
        id: 'fix-refactor',
        description: 'Refactor fix: restructure to avoid the error',
        prompt: `The following task failed. Restructure the approach to avoid this class of error entirely.\n\nOriginal task: ${task.description}\nOriginal prompt: ${task.prompt ?? task.command ?? 'N/A'}\nError: ${errorMsg}\n\nRefactor the code to fix the error and prevent similar issues.`,
      },
      {
        id: 'fix-alternative',
        description: 'Alternative fix: try a completely different approach',
        prompt: `The following task failed. Try a COMPLETELY DIFFERENT implementation approach.\n\nOriginal task: ${task.description}\nOriginal prompt: ${task.prompt ?? task.command ?? 'N/A'}\nError: ${errorMsg}\n\nIgnore the previous approach and implement this from scratch using a different strategy.`,
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
    if (!this.workflowId || !this.persistence.updateWorkflow) return;

    const tasks = this.stateMachine.getAllTasks();
    if (tasks.length === 0) return;

    const settled = tasks.every(
      (t) =>
        t.status === 'completed' ||
        t.status === 'failed' ||
        t.status === 'needs_input' ||
        t.status === 'awaiting_approval' ||
        t.status === 'blocked' ||
        t.status === 'stale',
    );
    if (!settled) return;

    const hasPendingInput = tasks.some(
      (t) => t.status === 'needs_input' || t.status === 'awaiting_approval',
    );
    if (hasPendingInput) return;

    const allSucceeded = tasks.every(
      (t) => t.status === 'completed' || t.status === 'stale',
    );
    const status = allSucceeded ? 'completed' : 'failed';
    this.persistence.updateWorkflow(this.workflowId, {
      status,
      updatedAt: new Date().toISOString(),
    });
    this.persistence.logEvent?.('__workflow__', `workflow.${status}`);
  }

  private autoStartReadyTasks(taskIds: string[]): TaskState[] {
    const started: TaskState[] = [];
    for (const taskId of taskIds) {
      this.scheduler.enqueue({ taskId, priority: 0 });
    }

    let job = this.scheduler.dequeue();
    while (job) {
      const task = this.stateMachine.getTask(job.taskId);
      if (!task || task.status !== 'pending') {
        this.scheduler.completeJob(job.taskId);
        job = this.scheduler.dequeue();
        continue;
      }

      const changes: Partial<TaskState> = {
        status: 'running',
        startedAt: new Date(),
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
