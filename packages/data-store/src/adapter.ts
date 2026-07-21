/**
 * PersistenceAdapter — Interface for task/workflow storage.
 *
 * The core orchestrator depends on this interface, not on SQLite directly.
 * This allows swapping storage backends (in-memory, SQLite, etc.)
 */

import type { TaskState, TaskStateChanges, PlanDefinition, Attempt, WorkflowDerivedStatus, WorkflowRollup, ExternalDependency, ExternalDependencyChange, DetachedExternalDependency } from '@invoker/workflow-core';
import type { InAppPlanningChatLine, InAppPlanningPlanSummary, InAppPlanningSessionStatus, PlanningTerminalMode, SearchResultItem, SearchOptions } from '@invoker/contracts';
import type { CostAttributionAttempt } from './attempt-read-models.js';


export type ConversationMode = 'agent' | 'plan';
// ── Conversation Types ─────────────────────────────────────

export interface Conversation {
  threadTs: string;
  channelId: string;
  userId: string;
  mode?: ConversationMode;
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

/**
 * Result of resolving a published PR back to its Invoker workflow via the merge
 * node. The PR↔workflow link lives only on the `__merge__<workflowId>` task
 * (`review_id` / `review_url`), so this is the single read-only lookup the PR
 * cron jobs use to map a GitHub PR number to a local workflow.
 */
export interface ReviewGateLookup {
  workflowId: string;
  mergeTaskId: string;
  reviewId?: string;
  reviewUrl?: string;
  branch?: string;
  baseBranch?: string;
  workflowStatus: WorkflowDerivedStatus;
  workflowGeneration: number;
  mergeTaskStatus?: string;
  selectedAttemptId?: string;
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

export type WorkerActionStatus =
  | 'queued'
  | 'pending'
  | 'running'
  | 'needs_input'
  | 'review_ready'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'abandoned'
  | 'cancelled';

export interface TaskEventListFilters {
  taskId?: string;
  eventTypes?: readonly string[];
  sortBy?: 'asc' | 'desc';
  limit?: number;
}

export interface WorkerActionRecord {
  id: string;
  workerKind: string;
  actionType: string;
  workflowId?: string;
  taskId?: string;
  subjectType: string;
  subjectId: string;
  externalKey: string;
  status: WorkerActionStatus;
  attemptCount: number;
  intentId?: string;
  agentName?: string;
  executionModel?: string;
  sessionId?: string;
  summary?: string;
  payload?: unknown;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface WorkerDesiredStateRecord {
  workerKind: string;
  desiredEnabled: boolean;
  updatedAt: string;
}

export interface WorkerActionWrite {
  /** Insert-only row id. Updates are keyed by workerKind/externalKey and reject a different id. */
  id: string;
  workerKind: string;
  actionType: string;
  workflowId?: string;
  taskId?: string;
  subjectType: string;
  subjectId: string;
  externalKey: string;
  status: WorkerActionStatus;
  attemptCount?: number;
  intentId?: string;
  agentName?: string;
  executionModel?: string;
  sessionId?: string;
  summary?: string;
  payload?: unknown;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
}

export interface WorkerActionListFilters {
  workflowId?: string;
  taskId?: string;
  workerKind?: string;
  status?: WorkerActionStatus | string;
  decision?: 'act' | 'skip';
  limit?: number;
  offset?: number;
}

export interface TerminalSessionRecord {
  sessionId: string;
  taskId: string;
  targetKey: string;
  status: 'running' | 'exited';
  exitCode?: number;
  cwd?: string;
  command?: string;
  args?: string[];
  linuxTerminalTail?: 'exec_bash' | 'pause';
  mode: 'spawn' | 'attached';
  attached: boolean;
  outputSnapshot: string;
  createdAt: string;
  updatedAt: string;
}

export type TerminalSessionPatch = Partial<
  Pick<TerminalSessionRecord, 'status' | 'exitCode' | 'outputSnapshot' | 'updatedAt'>
>;

export interface InAppPlanningSessionRecord {
  id: string;
  title: string;
  presetKey: string;
  status: InAppPlanningSessionStatus;
  messages: InAppPlanningChatLine[];
  draftPlanSummary?: InAppPlanningPlanSummary;
  draftPlanText?: string;
  submittedWorkflowId?: string;
  submittedPlanName?: string;
  terminalMode?: PlanningTerminalMode;
  terminalSessionId?: string;
  terminalStatus?: 'running' | 'exited';
  terminalExitCode?: number;
  terminalOutputSnapshot?: string;
  terminalUpdatedAt?: string;
  pendingResponse: boolean;
  createdAt: string;
  updatedAt: string;
}

export type InAppPlanningSessionPatch = Partial<Pick<
  InAppPlanningSessionRecord,
  | 'title'
  | 'status'
  | 'messages'
  | 'draftPlanSummary'
  | 'draftPlanText'
  | 'submittedWorkflowId'
  | 'submittedPlanName'
  | 'terminalMode'
  | 'terminalSessionId'
  | 'terminalStatus'
  | 'terminalExitCode'
  | 'terminalOutputSnapshot'
  | 'terminalUpdatedAt'
  | 'pendingResponse'
  | 'updatedAt'
>>;

export interface PersistenceAdapter {
  // Workflows
  saveWorkflow(workflow: WorkflowSaveInput): void;
  updateWorkflow(workflowId: string, changes: Partial<Pick<Workflow, 'name' | 'description' | 'visualProof' | 'planFile' | 'repoUrl' | 'intermediateRepoUrl' | 'branch' | 'onFinish' | 'baseBranch' | 'featureBranch' | 'mergeMode' | 'reviewProvider' | 'externalDependencies' | 'externalDependencyChanges' | 'detachedExternalDependencies' | 'generation' | 'updatedAt'>>): void;
  loadWorkflow(workflowId: string): Workflow | undefined;
  listWorkflows(): Workflow[];
  searchWorkflowsAndTasks(query: string, opts?: SearchOptions): SearchResultItem[];
  /** Resolve a GitHub PR number back to its Invoker workflow via the merge node. */
  findReviewGateByPr(pr: string): ReviewGateLookup | undefined;

  // Tasks
  saveTask(workflowId: string, task: TaskState): void;
  updateTask(taskId: string, changes: TaskStateChanges): void;
  loadTasks(workflowId: string): TaskState[];
  loadWorkflowTaskSnapshot?(): WorkflowTaskSnapshot;
  /** Authoritative single-task read by ID, suitable for recovery workflows. */
  loadTask(taskId: string): TaskState | undefined;
  /** Delete one task and its task-owned rows. */
  deleteTask(taskId: string): void;
  getAllTaskIds(): string[];
  getAllTaskBranches(): string[];
  deleteAllTasks(workflowId: string): void;
  deleteAllWorkflows(): void;
  deleteWorkflow(workflowId: string): void;
  /** All non-pending tasks (or pending with events), with workflow name and event aggregates. */
  loadAllHistoryTasks(): Array<TaskState & { workflowName: string; lastEventAt: string | null; eventCount: number }>;
  /** Legacy completed-only history list. Prefer loadAllHistoryTasks for the History view. */
  loadAllCompletedTasks(): Array<TaskState & { workflowName: string }>;

  // Events (audit trail)
  logEvent(taskId: string, eventType: string, payload?: unknown): void;
  /** Unbounded history — internal/tests only. Public IPC must use the limited overload. */
  getEvents(taskId: string): TaskEvent[];
  getEvents(taskId: string, sortBy: 'asc' | 'desc', limit: number, beforeId?: number): TaskEvent[];
  getEventsByTypes?(eventTypes: readonly string[], sortBy: 'asc' | 'desc', limit: number): TaskEvent[];
  countEventsByTypes?(eventTypes: readonly string[]): Array<{
    eventType: string;
    count: number;
    lastCreatedAt: string | null;
  }>;
  listTaskEvents?(filters?: TaskEventListFilters): TaskEvent[];

  // Worker actions (durable worker-owned action state/history)
  getWorkerAction(workerKind: string, externalKey: string): WorkerActionRecord | undefined;
  upsertWorkerAction(action: WorkerActionWrite): WorkerActionRecord;
  listWorkerActions(filters?: WorkerActionListFilters): WorkerActionRecord[];
  getWorkerDesiredState(workerKind: string): WorkerDesiredStateRecord | undefined;
  setWorkerDesiredState(workerKind: string, desiredEnabled: boolean): WorkerDesiredStateRecord;
  listWorkerDesiredStates(): WorkerDesiredStateRecord[];

  // Conversations (Slack thread-based)
  saveConversation(conversation: Conversation): void;
  loadConversation(threadTs: string): Conversation | undefined;
  updateConversation(threadTs: string, changes: Partial<Pick<Conversation, 'mode' | 'extractedPlan' | 'planSubmitted' | 'updatedAt'>>): void;
  deleteConversation(threadTs: string): void;

  // Conversation queries
  listActiveConversations(): Conversation[];
  deleteConversationsOlderThan(cutoffIso: string): number;

  // Conversation messages
  appendMessage(threadTs: string, role: 'user' | 'assistant', content: string): void;
  countMessages(threadTs: string): number;
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
  loadCostAttributionAttempts(nodeId: string): CostAttributionAttempt[];
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
