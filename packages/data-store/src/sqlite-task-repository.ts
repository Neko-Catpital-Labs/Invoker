/**
 * SqliteTaskRepository — Adapter that implements the TaskRepository port
 * by delegating to SQLiteAdapter.
 *
 * This is a thin wrapper: all persistence logic lives in SQLiteAdapter.
 */

import type {
  TaskRepository,
  WorkflowRecord,
  WorkflowChanges,
  AttemptChanges,
  AttemptFailPatch,
} from '@invoker/workflow-core';
import type { TaskState, TaskStateChanges, Attempt } from '@invoker/workflow-core';
import type { SQLiteAdapter } from './sqlite-adapter.js';

export class SqliteTaskRepository implements TaskRepository {
  constructor(private adapter: SQLiteAdapter) {}

  runInTransaction<T>(work: () => T): T {
    return this.adapter.runInTransaction(work);
  }

  // ── Workflow writes ──

  saveWorkflow(workflow: WorkflowRecord): void {
    this.adapter.saveWorkflow(workflow);
  }

  updateWorkflow(workflowId: string, changes: WorkflowChanges): void {
    this.adapter.updateWorkflow(workflowId, changes as any);
  }

  deleteWorkflow(workflowId: string): void {
    this.adapter.deleteWorkflow(workflowId);
  }

  deleteAllWorkflows(): void {
    this.adapter.deleteAllWorkflows();
  }

  // ── Task writes ──

  saveTask(workflowId: string, task: TaskState): void {
    this.adapter.saveTask(workflowId, task);
  }

  updateTask(taskId: string, changes: TaskStateChanges): void {
    this.adapter.updateTask(taskId, changes);
  }

  deleteTask(taskId: string): void {
    this.adapter.deleteTask(taskId);
  }

  logEvent(taskId: string, eventType: string, payload?: unknown): void {
    this.adapter.logEvent(taskId, eventType, payload);
  }

  // ── Attempt writes ──

  saveAttempt(attempt: Attempt): void {
    this.adapter.saveAttempt(attempt);
  }

  updateAttempt(attemptId: string, changes: AttemptChanges): void {
    this.adapter.updateAttempt(attemptId, changes);
  }

  claimAttemptForLaunch(attemptId: string, changes: AttemptChanges, now: Date): boolean {
    return this.adapter.claimAttemptForLaunch(attemptId, changes, now);
  }

  failTaskAndAttempt(
    taskId: string,
    taskChanges: TaskStateChanges,
    attemptPatch: AttemptFailPatch,
  ): void {
    this.adapter.failTaskAndAttempt(taskId, taskChanges, attemptPatch);
  }
}
