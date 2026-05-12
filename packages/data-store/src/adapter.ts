/**
 * PersistenceAdapter — Interface for task/workflow storage.
 *
 * The core orchestrator depends on this interface, not on SQLite directly.
 * This allows swapping storage backends (in-memory, SQLite, etc.)
 */

import type { TaskState, TaskStateChanges, PlanDefinition, Attempt } from '@invoker/workflow-core';

// ── Conversation Types ─────────────────────────────────────

export interface Conversation {
  threadTs: string;
  channelId: string;
  userId: string;
  extractedPlan: string | null;   // JSON-serialized PlanDefinition
  planSubmitted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessage {
  id: number;
  threadTs: string;
  seq: number;
  role: 'user' | 'assistant';
  content: string;                // JSON-serialized MessageParam content
  createdAt: string;
}

// ── Workflow Types ──────────────────────────────────────────

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  visualProof?: boolean;
  status: 'running' | 'completed' | 'failed';
  planFile?: string;
  repoUrl?: string;
  intermediateRepoUrl?: string;
  branch?: string;
  onFinish?: 'none' | 'merge' | 'pull_request';
  baseBranch?: string;
  featureBranch?: string;
  mergeMode?: 'manual' | 'automatic' | 'external_review';
  reviewProvider?: string;
  generation?: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskEvent {
  id: number;
  taskId: string;
  eventType: string;
  payload?: string;
  createdAt: string;
}

export interface ActivityLogEntry {
  id: number;
  timestamp: string;
  source: string;
  level: string;
  message: string;
}

/**
 * Structured options for a failure-diagnostic block appended to task_output.
 *
 * The block is intentionally human-readable and append-only: it does not
 * mutate the task row, so post-mortem inspection always sees the coarse
 * terminal error state (e.g. "Application quit") next to the concrete
 * diagnostics captured at the moment the failure was synthesized.
 */
export interface TaskFailureDiagnosticOptions {
  /** Short identifier for the failure path — e.g. "app-shutdown" or "executor-startup". */
  reason: string;
  /** Task status observed at the moment the diagnostic was captured. */
  status?: string;
  /** Concrete error/stderr message captured from the executor or task state. */
  error?: string;
  /** Optional executor exit code, if known. */
  exitCode?: number | null;
  /**
   * Concrete supplementary message (e.g. the synthetic shutdown reason
   * "Application quit") to include verbatim so future readers know what
   * collapsed the task to its terminal state.
   */
  message?: string;
  /**
   * Whether to read the recent spool tail and inline it into the block.
   * Defaults to true. The tail is truncated to {@link tailCharLimit} chars.
   */
  includeOutputTail?: boolean;
  /** Maximum tail size in characters. Defaults to 4_000. */
  tailCharLimit?: number;
}

export interface PersistenceAdapter {
  // Workflows
  saveWorkflow(workflow: Workflow): void;
  updateWorkflow(workflowId: string, changes: Partial<Pick<Workflow, 'status' | 'updatedAt' | 'baseBranch' | 'generation' | 'mergeMode'>>): void;
  loadWorkflow(workflowId: string): Workflow | undefined;
  listWorkflows(): Workflow[];

  // Tasks
  saveTask(workflowId: string, task: TaskState): void;
  updateTask(taskId: string, changes: TaskStateChanges): void;
  loadTasks(workflowId: string): TaskState[];
  /** Authoritative single-task read by ID, suitable for recovery workflows. */
  loadTask(taskId: string): TaskState | undefined;
  getAllTaskIds(): string[];
  getAllTaskBranches(): string[];
  deleteAllTasks(workflowId: string): void;
  deleteAllWorkflows(): void;
  deleteWorkflow(workflowId: string): void;

  // Events (audit trail)
  logEvent(taskId: string, eventType: string, payload?: unknown): void;
  getEvents(taskId: string): TaskEvent[];

  // Conversations (Slack thread-based)
  saveConversation(conversation: Conversation): void;
  loadConversation(threadTs: string): Conversation | undefined;
  updateConversation(threadTs: string, changes: Partial<Pick<Conversation, 'extractedPlan' | 'planSubmitted' | 'updatedAt'>>): void;
  deleteConversation(threadTs: string): void;

  // Conversation queries
  listActiveConversations(): Conversation[];
  deleteConversationsOlderThan(cutoffIso: string): number;

  // Conversation messages
  appendMessage(threadTs: string, role: 'user' | 'assistant', content: string): void;
  loadMessages(threadTs: string): ConversationMessage[];

  // Task output (stdout/stderr persistence)
  appendTaskOutput(taskId: string, data: string): void;
  getTaskOutput(taskId: string): string;

  /**
   * Append a compact failure-diagnostic block to durable task output.
   * Used by synthetic owner-shutdown and executor startup-failure paths so
   * post-mortem retrieval keeps concrete details (status, error, exit code,
   * recent output tail) alongside the coarse terminal error state recorded
   * on the task row.
   */
  appendFailureDiagnostic(taskId: string, opts: TaskFailureDiagnosticOptions): void;

  // Attempts
  saveAttempt(attempt: Attempt): void;
  loadAttempts(nodeId: string): Attempt[];
  loadAttempt(attemptId: string): Attempt | undefined;
  updateAttempt(attemptId: string, changes: Partial<Pick<Attempt, 'status' | 'claimedAt' | 'startedAt' | 'completedAt' | 'exitCode' | 'error' | 'lastHeartbeatAt' | 'leaseExpiresAt' | 'branch' | 'commit' | 'summary' | 'queuePriority' | 'workspacePath' | 'agentSessionId' | 'containerId' | 'mergeConflict'>>): void;

  /**
   * Atomically update a task's state and fail its running attempt (if any).
   * Wraps both updates in a transaction to prevent partial writes.
   */
  failTaskAndAttempt(
    taskId: string,
    taskChanges: TaskStateChanges,
    attemptPatch: Partial<Pick<Attempt, 'status' | 'exitCode' | 'error' | 'completedAt'>>
  ): void;

  // Agent queries
  /** Read the configured execution agent name for a task (e.g. 'claude', 'codex'). */
  getExecutionAgent?(taskId: string): string | null;

  // Lifecycle
  close(): void;
}
