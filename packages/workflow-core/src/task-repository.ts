/**
 * TaskRepository — Dependency-inversion port for every DB write the
 * orchestrator performs.
 *
 * This is a **port** (in hexagonal / ports-and-adapters terms). It must
 * NOT import anything from `@invoker/data-store`. Adapters that implement
 * this interface live in other packages.
 *
 * Every method corresponds 1-to-1 with a `this.persistence.*` write call
 * inside orchestrator.ts.
 */

import type { TaskState, TaskStateChanges, Attempt } from '@invoker/workflow-graph';

// ── Workflow value types (inline in OrchestratorPersistence today) ────

export interface WorkflowRecord {
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
}

export interface WorkflowChanges {
  status?: string;
  updatedAt?: string;
  baseBranch?: string;
  generation?: number;
  mergeMode?: 'manual' | 'automatic' | 'external_review';
}

export type AttemptChanges = Partial<
  Pick<
    Attempt,
    | 'status'
    | 'startedAt'
    | 'completedAt'
    | 'exitCode'
    | 'error'
    | 'lastHeartbeatAt'
    | 'branch'
    | 'commit'
    | 'summary'
    | 'workspacePath'
    | 'agentSessionId'
    | 'containerId'
    | 'mergeConflict'
  >
>;

export type AttemptFailPatch = Partial<
  Pick<Attempt, 'status' | 'exitCode' | 'error' | 'completedAt'>
>;

// ── Port interface ───────────────────────────────────────────

export interface TaskRepository {
  // ── Workflow writes ──

  /** Persist a new workflow. */
  saveWorkflow(workflow: WorkflowRecord): void;

  /** Update mutable fields on an existing workflow. */
  updateWorkflow(workflowId: string, changes: WorkflowChanges): void;

  /** Delete a single workflow and its associated tasks. */
  deleteWorkflow(workflowId: string): void;

  /** Delete every workflow and task in the store. */
  deleteAllWorkflows(): void;

  // ── Task writes ──

  /** Insert a new task into a workflow. */
  saveTask(workflowId: string, task: TaskState): void;

  /** Apply a partial update to an existing task. */
  updateTask(taskId: string, changes: TaskStateChanges): void;

  /** Persist a task lifecycle event for auditing / replay. */
  logEvent(taskId: string, eventType: string, payload?: unknown): void;

  // ── Attempt writes ──

  /** Insert a new execution attempt. */
  saveAttempt(attempt: Attempt): void;

  /** Apply a partial update to an existing attempt. */
  updateAttempt(attemptId: string, changes: AttemptChanges): void;

  /**
   * Atomically fail a task and its latest attempt in a single
   * transaction. Implementations that lack transactional support may
   * fall back to sequential `updateTask` + `updateAttempt` calls.
   */
  failTaskAndAttempt(
    taskId: string,
    taskChanges: TaskStateChanges,
    attemptPatch: AttemptFailPatch,
  ): void;
}
