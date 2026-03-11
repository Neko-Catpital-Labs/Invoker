/**
 * IPC Bridge Types — Shared between preload and renderer.
 *
 * Defines the shape of the `window.invoker` API exposed via contextBridge.
 * The renderer uses these types; the main process implements them via ipcMain.handle.
 */

import type { TaskState, TaskDelta } from '@invoker/core';
import type { PlanDefinition } from '@invoker/core';

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

// ── IPC Bridge API ───────────────────────────────────────────

export interface InvokerAPI {
  loadPlan: (plan: PlanDefinition) => Promise<void>;
  start: () => Promise<TaskState[]>;
  stop: () => Promise<void>;
  clear: () => Promise<void>;
  getTasks: () => Promise<TaskState[]>;
  getStatus: () => Promise<WorkflowStatus>;
  provideInput: (taskId: string, input: string) => Promise<void>;
  approve: (taskId: string) => Promise<void>;
  reject: (taskId: string, reason?: string) => Promise<void>;
  selectExperiment: (taskId: string, experimentId: string) => Promise<void>;
  restartTask: (taskId: string) => Promise<void>;
  editTaskCommand: (taskId: string, newCommand: string) => Promise<void>;
  editTaskType: (taskId: string, familiarType: string) => Promise<void>;
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
  getAllCompletedTasks: () => Promise<Array<TaskState & { workflowName: string }>>;
  cleanupWorktrees: () => Promise<{ removed: string[]; errors: string[] }>;

  // Rebase & Retry for merge gates
  rebaseAndRetry: (mergeTaskId: string) => Promise<{
    success: boolean;
    rebasedBranches: string[];
    errors: string[];
  }>;

  // Change merge target branch for a workflow
  setMergeBranch: (workflowId: string, baseBranch: string) => Promise<void>;
}

// ── Augment global Window ────────────────────────────────────

declare global {
  interface Window {
    invoker: InvokerAPI;
  }
}
