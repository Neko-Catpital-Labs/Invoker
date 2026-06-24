/**
 * PersistenceAdapter — Interface for task/workflow storage.
 *
 * The core orchestrator depends on this interface, not on SQLite directly.
 * This allows swapping storage backends (in-memory, SQLite, etc.)
 */

import type { TaskState, TaskStateChanges, PlanDefinition, Attempt, WorkflowDerivedStatus, WorkflowRollup, ExternalDependency, ExternalDependencyChange, DetachedExternalDependency } from '@invoker/workflow-core';
import type { SearchResultItem, SearchOptions } from '@invoker/contracts';

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

// ── Workflow Channel Types (Slack workflow↔channel mapping) ─

export interface WorkflowChannel {
  workflowId: string;
  channelId: string;
  requestedBy?: string;
  lobbyChannelId?: string;
  lobbyThreadTs?: string;
  harnessPreset?: string;
  repoUrl?: string;
  createdAt: string;
}

// ── Workflow Types ──────────────────────────────────────────

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  visualProof?: boolean;
  status: WorkflowDerivedStatus;
  rollup?: WorkflowRollup;
  planFile?: string;
  repoUrl?: string;
  intermediateRepoUrl?: string;
  branch?: string;
  onFinish?: 'none' | 'merge' | 'pull_request';
  baseBranch?: string;
  featureBranch?: string;
  mergeMode?: 'manual' | 'automatic' | 'external_review';
  reviewProvider?: string;
  externalDependencies?: ExternalDependency[];
  externalDependencyChanges?: ExternalDependencyChange[];
  /** Read-only provenance for dependencies removed by `detachWorkflow`. Never re-read by scheduling. */
  detachedExternalDependencies?: DetachedExternalDependency[];
  generation?: number;
  createdAt: string;
  updatedAt: string;
}
export type WorkflowSaveInput = Omit<Workflow, 'status' | 'rollup'>;


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

export interface WorkflowTaskSnapshot {
  workflows: Workflow[];
  tasks: TaskState[];
  tasksByWorkflowId: Map<string, TaskState[]>;
}

export interface LaunchDispatchInvalidationRow {
  id: number;
  taskId: string;
  attemptId: string;
  workflowId: string;
  state: string;
  generation: number;
}

export interface ExecutionResourceLeaseReleaseRow {
  resourceKey: string;
  resourceType: string;
  holderId: string;
  taskId?: string;
}

export interface PersistenceAdapter {
  // Workflows
  saveWorkflow(workflow: WorkflowSaveInput): void;
  updateWorkflow(workflowId: string, changes: Partial<Pick<Workflow, 'name' | 'description' | 'visualProof' | 'planFile' | 'repoUrl' | 'intermediateRepoUrl' | 'branch' | 'onFinish' | 'baseBranch' | 'featureBranch' | 'mergeMode' | 'reviewProvider' | 'externalDependencies' | 'externalDependencyChanges' | 'detachedExternalDependencies' | 'generation' | 'updatedAt'>>): void;
  loadWorkflow(workflowId: string): Workflow | undefined;
  listWorkflows(): Workflow[];
  searchWorkflowsAndTasks(query: string, opts?: SearchOptions): SearchResultItem[];

  // Tasks
  saveTask(workflowId: string, task: TaskState): void;
  updateTask(taskId: string, changes: TaskStateChanges): void;
  loadTasks(workflowId: string): TaskState[];
  loadWorkflowTaskSnapshot?(): WorkflowTaskSnapshot;
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
  getEvents(taskId: string, sortBy: 'asc' | 'desc', limit: number): TaskEvent[];

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

  // Workflow channels (Slack workflow↔channel mapping)
  saveWorkflowChannel(rec: WorkflowChannel): void;
  loadWorkflowChannelByWorkflowId(workflowId: string): WorkflowChannel | undefined;
  loadWorkflowChannelByChannelId(channelId: string): WorkflowChannel | undefined;
  listWorkflowChannels(): WorkflowChannel[];
  deleteWorkflowChannel(workflowId: string): void;

  // Task output (stdout/stderr persistence)
  appendTaskOutput(taskId: string, data: string): void;
  getTaskOutput(taskId: string): string;

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

  abandonLaunchDispatchesForTasks(
    taskIds: readonly string[],
    reason: string,
    nowIso?: string,
  ): LaunchDispatchInvalidationRow[];
  releaseExecutionResourceLeasesForTasks(
    taskIds: readonly string[],
    reason: string,
    nowIso?: string,
  ): ExecutionResourceLeaseReleaseRow[];

  // Agent queries
  /** Read the configured execution agent name for a task (e.g. 'claude', 'codex'). */
  getExecutionAgent?(taskId: string): string | null;

  // Lifecycle
  close(): void;
}
