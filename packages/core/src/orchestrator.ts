/**
 * Orchestrator — Wiring layer that connects pure components to infrastructure.
 *
 * Coordinates TaskStateMachine, ResponseHandler, ExperimentManager, and TaskScheduler
 * with a persistence adapter (storage) and a message bus (event publishing).
 *
 * No business logic here. State transitions live in StateMachine.
 * Response routing lives in ResponseHandler. This layer wires them together
 * and handles persistence + publishing side effects.
 *
 * Interfaces for persistence and message bus are defined locally to avoid
 * circular workspace dependencies (persistence depends on core for TaskState).
 */

import { TaskStateMachine } from './state-machine.js';
import { ExperimentManager } from './experiments.js';
import { ResponseHandler } from './response-handler.js';
import { TaskScheduler } from './scheduler.js';
import type { TaskState, TaskDelta, SideEffect } from './task-types.js';
import type { WorkResponse } from '@invoker/protocol';
import { getTransitiveDependents, nextVersion } from './dag.js';
import { ActionGraph } from '@invoker/graph';

// ── Channel Constants ───────────────────────────────────────
// Mirrors @invoker/transport Channels to avoid adding a dependency.

const TASK_DELTA_CHANNEL = 'task.delta';

// ── Adapter Interfaces ──────────────────────────────────────
// These mirror the interfaces in @invoker/persistence and @invoker/transport.
// Defined locally to avoid circular workspace dependencies.

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
  loadTasks?(workflowId: string): TaskState[];
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
    this.responseHandler = new ResponseHandler({
      stateMachine: this.stateMachine,
      experimentManager: this.experimentManager,
    });
    this.scheduler = new TaskScheduler(this.maxConcurrency);
  }

  // ── Commands ──────────────────────────────────────────────

  /**
   * Parse a plan definition and create tasks with dependencies.
   * Persists workflow and tasks, publishes deltas via MessageBus.
   */
  loadPlan(plan: PlanDefinition): void {
    // Clear any previously-loaded tasks so repeated loads don't accumulate stale state
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
      const { task, delta } = this.stateMachine.createTask(
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

      this.persistence.saveTask(workflowId, task);
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
    const readyTasks = this.stateMachine.getReadyTasks();
    const started: TaskState[] = [];

    for (const task of readyTasks) {
      this.scheduler.enqueue({ taskId: task.id, priority: 0 });
    }

    let job = this.scheduler.dequeue();
    while (job) {
      const result = this.stateMachine.startTask(job.taskId);
      if ('error' in result) {
        this.scheduler.completeJob(job.taskId);
        job = this.scheduler.dequeue();
        continue;
      }

      started.push(result.task);
      this.persistAndPublish(result.task, result.delta);

      job = this.scheduler.dequeue();
    }

    return started;
  }

  /**
   * Route a worker response through ResponseHandler.
   * Persists changes, publishes deltas, and auto-starts newly ready tasks.
   */
  handleWorkerResponse(response: WorkResponse): TaskState[] {
    // Auto-fix interception: transform failed autoFix tasks into spawn_experiments
    // before the response handler processes the failure. This reuses the existing
    // experiment spawning pipeline instead of duplicating it.
    if (response.status === 'failed') {
      const task = this.stateMachine.getTask(response.actionId);
      if (task?.autoFix) {
        const syntheticResponse = this.buildAutoFixResponse(task, response.outputs);
        return this.handleWorkerResponse(syntheticResponse);
      }
    }

    const result = this.responseHandler.handleResponse(response);
    if (!result.success) {
      return [];
    }

    // Free the scheduler slot for the completed/failed/paused task
    this.scheduler.completeJob(response.actionId);

    // Persist and publish all deltas
    if (result.deltas) {
      for (const delta of result.deltas) {
        if (delta.type === 'updated') {
          const task = this.stateMachine.getTask(delta.taskId);
          if (task) {
            this.persistence.updateTask(delta.taskId, delta.changes);
            if (delta.changes.status) {
              this.persistence.logEvent?.(delta.taskId, `task.${delta.changes.status}`, delta.changes);
            }
            this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
          }
        } else if (delta.type === 'created') {
          if (this.workflowId) {
            this.persistence.saveTask(this.workflowId, delta.task);
          }
          this.persistence.logEvent?.(delta.task.id, 'task.created');
          this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
        }
      }
    }

    // Check if this was an experiment task completion
    if (response.status === 'completed' || response.status === 'failed') {
      this.checkExperimentCompletion(response.actionId);
    }

    // Auto-start newly ready tasks and drain any previously queued tasks
    const started = this.autoStartReadyTasks(result.readyTasks ?? []);
    this.checkWorkflowCompletion();
    return started;
  }

  /**
   * Resume a paused task with user input.
   */
  provideInput(taskId: string, input: string): void {
    const result = this.stateMachine.resumeWithInput(taskId);
    if ('error' in result) {
      return;
    }

    this.persistAndPublish(result.task, result.delta);
  }

  /**
   * Approve a task awaiting approval. Completes it and unblocks dependents.
   */
  approve(taskId: string): void {
    const result = this.stateMachine.approveTask(taskId);
    if ('error' in result) {
      return;
    }

    this.persistAndPublish(result.task, result.delta);

    const readyTaskIds = this.extractReadyTaskIds(result.sideEffects);
    this.autoStartReadyTasks(readyTaskIds);
    this.checkWorkflowCompletion();
  }

  /**
   * Reject a task awaiting approval. Fails it and blocks dependents.
   */
  reject(taskId: string, reason?: string): void {
    const result = this.stateMachine.rejectTask(taskId, reason);
    if ('error' in result) {
      return;
    }

    this.persistAndPublish(result.task, result.delta);

    // Persist and publish deltas for blocked dependents
    for (const effect of result.sideEffects) {
      if (effect.type === 'tasks_blocked') {
        for (const blockedId of effect.taskIds) {
          const blockedTask = this.stateMachine.getTask(blockedId);
          if (blockedTask) {
            const blockedDelta: TaskDelta = {
              type: 'updated',
              taskId: blockedId,
              changes: { status: 'blocked', blockedBy: effect.blockedBy },
            };
            this.persistence.updateTask(blockedId, { status: 'blocked', blockedBy: effect.blockedBy });
            this.messageBus.publish(TASK_DELTA_CHANNEL, blockedDelta);
          }
        }
      }
    }
    this.checkWorkflowCompletion();
  }

  /**
   * Select a winning experiment for a reconciliation task.
   */
  selectExperiment(taskId: string, experimentId: string): TaskState[] {
    const result = this.stateMachine.completeReconciliation(taskId, experimentId);
    if ('error' in result) {
      return [];
    }

    this.persistAndPublish(result.task, result.delta);

    const readyTaskIds = this.extractReadyTaskIds(result.sideEffects);
    const started = this.autoStartReadyTasks(readyTaskIds);
    this.checkWorkflowCompletion();
    return started;
  }

  /**
   * Restart a non-running task: reset it to pending, unblock dependents,
   * and auto-start if its own dependencies are satisfied.
   * Returns tasks that were started (for caller to execute via familiar).
   */
  restartTask(taskId: string): TaskState[] {
    const result = this.stateMachine.restartTask(taskId);
    if ('error' in result) {
      throw new Error(result.error);
    }

    this.persistAndPublish(result.task, result.delta);

    // Persist and publish deltas for unblocked dependents
    for (const effect of result.sideEffects) {
      if (effect.type === 'tasks_ready') {
        for (const id of effect.taskIds) {
          const t = this.stateMachine.getTask(id);
          if (t) {
            const delta: TaskDelta = {
              type: 'updated',
              taskId: id,
              changes: { status: 'pending', blockedBy: undefined },
            };
            this.persistence.updateTask(id, { status: 'pending', blockedBy: undefined });
            this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
          }
        }
      }
    }

    // Free the scheduler slot in case it was tracked
    this.scheduler.completeJob(taskId);

    // If the restarted task's dependencies are all completed, auto-start it
    const readyTasks = this.stateMachine.getReadyTasks();
    const isReady = readyTasks.some((t) => t.id === taskId);
    if (isReady) {
      return this.autoStartReadyTasks([taskId]);
    }

    return [result.task];
  }

  /**
   * Edit a task's command, fork its downstream subtree, and restart it.
   * Returns the tasks that were started (for caller to execute via familiar).
   */
  editTaskCommand(taskId: string, newCommand: string): TaskState[] {
    const result = this.stateMachine.updateTaskFields(taskId, { command: newCommand });
    if ('error' in result) {
      throw new Error(result.error);
    }

    this.persistAndPublish(result.task, result.delta);

    this.forkDirtySubtree(taskId);

    return this.restartTask(taskId);
  }

  /**
   * Change a task's executor type (familiarType) and restart it.
   * Unlike editTaskCommand, this does NOT fork the dirty subtree — changing
   * the executor doesn't invalidate downstream results.
   */
  editTaskType(taskId: string, familiarType: string): TaskState[] {
    const result = this.stateMachine.updateTaskFields(taskId, { familiarType });
    if ('error' in result) throw new Error(result.error);
    this.persistAndPublish(result.task, result.delta);
    return this.restartTask(taskId);
  }

  /**
   * Fork the subtree downstream of a dirty task.
   *
   * 1. Mark all transitive descendants as 'stale'
   * 2. Create cloned tasks with versioned IDs and remapped dependencies
   * 3. Clones that depended on the dirty task keep depending on it (it has the user's edits)
   * 4. Clones that depended on other stale tasks depend on the clone instead
   *
   * Returns all deltas (stale + created) for UI update.
   */
  forkDirtySubtree(dirtyTaskId: string): TaskDelta[] {
    const allTasks = this.stateMachine.getAllTasks();
    const taskMap = new Map(allTasks.map(t => [t.id, t]));

    const descendantIds = getTransitiveDependents(dirtyTaskId, taskMap);
    if (descendantIds.length === 0) return [];

    const deltas: TaskDelta[] = [];

    // 1. Mark descendants as stale
    for (const id of descendantIds) {
      const result = this.stateMachine.markStale(id);
      if ('error' in result) continue;
      this.persistAndPublish(result.task, result.delta);
      deltas.push(result.delta);
    }

    // 2. Build ID mapping: original → clone
    const idMap = new Map<string, string>();
    for (const id of descendantIds) {
      idMap.set(id, nextVersion(id));
    }

    // 3. Create cloned tasks with remapped dependencies
    for (const originalId of descendantIds) {
      const original = taskMap.get(originalId);
      if (!original) continue;

      const cloneId = idMap.get(originalId)!;

      // Remap dependencies: if dep was stale, point to its clone; otherwise keep original
      const remappedDeps = original.dependencies.map(dep =>
        idMap.get(dep) ?? dep,
      );

      const { task, delta } = this.stateMachine.createTask(
        cloneId,
        original.description,
        remappedDeps,
        {
          command: original.command,
          prompt: original.prompt,
          pivot: original.pivot,
          requiresManualApproval: original.requiresManualApproval,
          repoUrl: original.repoUrl,
          featureBranch: original.featureBranch,
          familiarType: original.familiarType,
          autoFix: original.autoFix,
          maxFixAttempts: original.maxFixAttempts,
        },
      );

      if (this.workflowId) {
        this.persistence.saveTask(this.workflowId, task);
      }
      this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
      deltas.push(delta);
    }

    return deltas;
  }

  /**
   * Load tasks from persistence into the state machine, mirroring DB state
   * exactly. Non-destructive: does not mutate task status or write back to DB.
   * Safe to call at any time (startup, db-poll, view switch).
   */
  syncFromDb(workflowId: string): void {
    if (!this.persistence.loadTasks) {
      throw new Error('Persistence adapter does not support loading tasks');
    }

    this.workflowId = workflowId;
    this.stateMachine.clear();
    const tasks = this.persistence.loadTasks(workflowId);
    for (const task of tasks) {
      this.stateMachine.restoreTask(task);
    }
  }

  /**
   * Resume a previously persisted workflow by restoring tasks into the
   * state machine and auto-starting ready tasks.
   * Throws if persistence adapter does not support loadTasks.
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

  // ── Private Helpers ───────────────────────────────────────

  private checkExperimentCompletion(taskId: string): void {
    const task = this.stateMachine.getTask(taskId);
    if (!task) return;

    const result = this.experimentManager.onExperimentCompleted(taskId, {
      id: taskId,
      status: task.status === 'completed' ? 'completed' : 'failed',
      summary: task.summary,
      exitCode: task.exitCode,
    });

    if (!result) return; // not part of any experiment group

    if (result.allDone) {
      const reconResult = this.stateMachine.triggerReconciliation(
        result.group.reconciliationTaskId,
        Array.from(result.group.completedExperiments.values()),
      );
      if (!('error' in reconResult)) {
        this.persistAndPublish(reconResult.task, reconResult.delta);
      }
    }
  }

  /**
   * Build a synthetic spawn_experiments WorkResponse from a failed autoFix task.
   * This transforms the failure into an experiment spawn, reusing the existing pipeline.
   */
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

  private persistAndPublish(task: TaskState, delta: TaskDelta): void {
    if (delta.type === 'updated') {
      this.persistence.updateTask(task.id, delta.changes);
      if (delta.changes.status) {
        this.persistence.logEvent?.(task.id, `task.${delta.changes.status}`, delta.changes);
      }
    } else if (delta.type === 'created' && this.workflowId) {
      this.persistence.saveTask(this.workflowId, task);
      this.persistence.logEvent?.(task.id, 'task.created');
    }
    this.messageBus.publish(TASK_DELTA_CHANNEL, delta);
  }

  private autoStartReadyTasks(taskIds: string[]): TaskState[] {
    const started: TaskState[] = [];
    for (const taskId of taskIds) {
      this.scheduler.enqueue({ taskId, priority: 0 });
    }

    let job = this.scheduler.dequeue();
    while (job) {
      const result = this.stateMachine.startTask(job.taskId);
      if ('error' in result) {
        this.scheduler.completeJob(job.taskId);
        job = this.scheduler.dequeue();
        continue;
      }

      started.push(result.task);
      this.persistAndPublish(result.task, result.delta);
      job = this.scheduler.dequeue();
    }
    return started;
  }

  private extractReadyTaskIds(sideEffects: readonly SideEffect[]): string[] {
    const ready: string[] = [];
    for (const effect of sideEffects) {
      if (effect.type === 'tasks_ready') {
        ready.push(...effect.taskIds);
      }
    }
    return ready;
  }
}
