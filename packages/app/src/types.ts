/**
 * IPC Bridge Types — Shared between preload and renderer.
 *
 * Defines the shape of the `window.invoker` API exposed via contextBridge.
 * The renderer uses these types; the main process implements them via ipcMain.handle.
 */

import type { TaskState, TaskDelta, TaskStateChanges } from '@invoker/core';


// ── Task Replacement ────────────────────────────────────────

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

// ── Workflow Metadata ────────────────────────────────────────

export interface WorkflowMeta {
  id: string;
  name: string;
  status: string;
  baseBranch?: string;
  featureBranch?: string;
  onFinish?: string;
  mergeMode?: string;
}

// ── Workflow Status ──────────────────────────────────────────

export interface WorkflowStatus {
  total: number;
  completed: number;
  failed: number;
  running: number;
  pending: number;
}

// ── Task Output Data ─────────────────────────────────────────

export interface TaskOutputData {
  taskId: string;
  data: string;
}

// ── Activity Log ────────────────────────────────────────────

export interface ActivityLogEntry {
  id: number;
  timestamp: string;
  source: string;
  level: string;
  message: string;
}

// ── Claude Session Messages ─────────────────────────────────

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

// ── IPC Bridge API ───────────────────────────────────────────

export interface InvokerAPI {
  getClaudeSession: (sessionId: string) => Promise<ClaudeMessage[] | null>;
  loadPlan: (planText: string) => Promise<void>;
  start: () => Promise<TaskState[]>;
  stop: () => Promise<void>;
  clear: () => Promise<void>;
  getTasks: () => Promise<{ tasks: TaskState[]; workflows: WorkflowMeta[] }>;
  getStatus: () => Promise<WorkflowStatus>;
  provideInput: (taskId: string, input: string) => Promise<void>;
  approve: (taskId: string) => Promise<void>;
  reject: (taskId: string, reason?: string) => Promise<void>;
  selectExperiment: (taskId: string, experimentId: string | string[]) => Promise<void>;
  restartTask: (taskId: string) => Promise<void>;
  editTaskCommand: (taskId: string, newCommand: string) => Promise<void>;
  editTaskType: (taskId: string, familiarType: string, remoteTargetId?: string) => Promise<void>;
  getRemoteTargets: () => Promise<string[]>;
  replaceTask: (taskId: string, replacementTasks: TaskReplacementDef[]) => Promise<TaskState[]>;
  onTaskDelta: (cb: (delta: TaskDelta) => void) => () => void;
  onTaskOutput: (cb: (data: TaskOutputData) => void) => () => void;
  onActivityLog: (cb: (entries: ActivityLogEntry[]) => void) => () => void;
  getActivityLogs: () => Promise<ActivityLogEntry[]>;
  getEvents: (taskId: string) => Promise<Array<{ id: number; taskId: string; eventType: string; payload?: string; createdAt: string }>>;
  getTaskOutput: (taskId: string) => Promise<string>;

  // External terminal launcher
  openTerminal: (taskId: string) => Promise<{ opened: boolean; reason?: string }>;

  // Workflow management
  resumeWorkflow: () => Promise<{ workflow: { id: string; name: string; status: string }; taskCount: number; startedCount: number } | null>;
  listWorkflows: () => Promise<Array<{ id: string; name: string; status: string; createdAt: string; updatedAt: string }>>;
  loadWorkflow: (workflowId: string) => Promise<{ workflow: unknown; tasks: unknown[] }>;
  onWorkflowsChanged: (cb: (workflows: unknown[]) => void) => () => void;
  deleteAllWorkflows: () => Promise<void>;
  deleteWorkflow: (workflowId: string) => Promise<void>;
  getAllCompletedTasks: () => Promise<Array<TaskState & { workflowName: string }>>;
  cleanupWorktrees: () => Promise<{ removed: string[]; errors: string[] }>;

  // Restart entire workflow with generation bump (fresh branch hashes)
  restartWorkflow: (workflowId: string) => Promise<void>;

  // Rebase & Retry for merge gates
  rebaseAndRetry: (mergeTaskId: string) => Promise<{
    success: boolean;
    rebasedBranches: string[];
    errors: string[];
  }>;

  // Change merge target branch for a workflow
  setMergeBranch: (workflowId: string, baseBranch: string) => Promise<void>;

  // Approve manual merge: perform final merge of featureBranch into baseBranch
  approveMerge: (workflowId: string) => Promise<void>;

  // Resolve merge conflict with Claude and restart task
  resolveConflict: (taskId: string) => Promise<void>;
  fixWithClaude: (taskId: string) => Promise<void>;
  setMergeMode: (workflowId: string, mergeMode: string) => Promise<void>;
  checkPrStatuses: () => Promise<void>;
  checkPrStatus: () => Promise<void>;

  // Cancel task with DAG cascade
  cancelTask: (taskId: string) => Promise<{ cancelled: string[]; runningCancelled: string[] }>;

  // Queue status with utilization details
  getQueueStatus: () => Promise<{
    maxUtilization: number;
    runningUtilization: number;
    running: Array<{ taskId: string; utilization: number; description: string }>;
    queued: Array<{ taskId: string; priority: number; utilization: number; description: string }>;
  }>;

  /** Test-only (NODE_ENV=test): persist task updates and push deltas without running the executor. */
  injectTaskStates?: (updates: Array<{ taskId: string; changes: TaskStateChanges }>) => Promise<void>;
}

// ── Augment global Window ────────────────────────────────────

declare global {
  interface Window {
    invoker: InvokerAPI;
  }
}
