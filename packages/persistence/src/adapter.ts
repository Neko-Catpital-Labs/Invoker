/**
 * PersistenceAdapter — Interface for task/workflow storage.
 *
 * The core orchestrator depends on this interface, not on SQLite directly.
 * This allows swapping storage backends (in-memory, SQLite, etc.)
 */

import type { TaskState, TaskStateChanges, PlanDefinition, Attempt } from '@invoker/core';

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
  branch?: string;
  onFinish?: 'none' | 'merge' | 'pull_request';
  baseBranch?: string;
  featureBranch?: string;
  mergeMode?: 'manual' | 'automatic' | 'github';
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

  // Attempts
  saveAttempt(attempt: Attempt): void;
  loadAttempts(nodeId: string): Attempt[];
  loadAttempt(attemptId: string): Attempt | undefined;
  updateAttempt(attemptId: string, changes: Partial<Pick<Attempt, 'status' | 'startedAt' | 'completedAt' | 'exitCode' | 'error' | 'lastHeartbeatAt' | 'branch' | 'commit' | 'summary' | 'workspacePath' | 'claudeSessionId' | 'containerId' | 'mergeConflict'>>): void;
  getNextAttemptNumber(nodeId: string): number;

  // Lifecycle
  close(): void;
}
