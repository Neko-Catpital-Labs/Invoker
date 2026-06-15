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

import type { TaskState, TaskStateChanges, Attempt, WorkflowDerivedStatus, ExternalDependency, ExternalDependencyChange, DetachedExternalDependency } from '@invoker/workflow-graph';

// ── Workflow value types (inline in OrchestratorPersistence today) ────

export interface WorkflowRecord {
  id: string;
  name: string;
  description?: string;
  visualProof?: boolean;
  status: WorkflowDerivedStatus;
  createdAt: string;
  updatedAt: string;
  repoUrl?: string;
  onFinish?: string;
  baseBranch?: string;
  featureBranch?: string;
  mergeMode?: 'manual' | 'automatic' | 'external_review';
  externalDependencies?: ExternalDependency[];
  externalDependencyChanges?: ExternalDependencyChange[];
  detachedExternalDependencies?: DetachedExternalDependency[];
}

export interface WorkflowChanges {
  name?: string;
  description?: string;
  visualProof?: boolean;
  planFile?: string;
  repoUrl?: string;
  intermediateRepoUrl?: string;
  branch?: string;
  onFinish?: string;
  updatedAt?: string;
  baseBranch?: string;
  featureBranch?: string;
  generation?: number;
  mergeMode?: 'manual' | 'automatic' | 'external_review';
  reviewProvider?: string;
  /**
   * Presence semantics: a key explicitly set to `undefined` clears the
   * stored value (NULL column); an absent key leaves it unchanged.
   * `detachWorkflowInternal` relies on this to clear a dependent's last
   * external dependency when the upstream workflow is detached or deleted.
   */
  externalDependencies?: ExternalDependency[];
  /** Same presence semantics as `externalDependencies`. */
  externalDependencyChanges?: ExternalDependencyChange[];
  /**
   * Read-only provenance for detached upstream edges. Same presence
   * semantics as `externalDependencies`. Never consulted by the scheduler.
   */
  detachedExternalDependencies?: DetachedExternalDependency[];
}

export type AttemptChanges = Partial<
  Pick<
    Attempt,
    | 'claimedAt'
    | 'status'
    | 'startedAt'
    | 'completedAt'
    | 'exitCode'
    | 'error'
    | 'lastHeartbeatAt'
    | 'leaseExpiresAt'
    | 'branch'
    | 'commit'
    | 'summary'
    | 'queuePriority'
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
  /**
   * Execute a group of writes atomically when the backing store supports it.
   * Adapters without transactions may simply execute the callback inline.
   */
  runInTransaction<T>(work: () => T): T;

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
   * Atomically claim an attempt for launch. Returns false when another
   * dispatcher already owns an active claim for the same attempt.
   */
  claimAttemptForLaunch?(attemptId: string, changes: AttemptChanges, now: Date): boolean;

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
