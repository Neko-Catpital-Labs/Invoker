/**
 * UI type definitions.
 *
 * Re-declares the types from @invoker/core and @invoker/app to avoid
 * importing Electron dependencies into the renderer process.
 */

// ── Task Status ─────────────────────────────────────────────

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'needs_input'
  | 'blocked'
  | 'awaiting_approval'
  | 'stale';

// ── Experiment Types ────────────────────────────────────────

export interface ExperimentVariant {
  readonly id: string;
  readonly description: string;
  readonly prompt: string;
}

export interface ExperimentResultEntry {
  readonly id: string;
  readonly status: 'completed' | 'failed';
  readonly summary?: string;
  readonly exitCode?: number;
}

// ── Task State ──────────────────────────────────────────────

export interface TaskState {
  readonly id: string;
  readonly description: string;
  readonly status: TaskStatus;
  readonly dependencies: readonly string[];
  readonly workflowId?: string;
  readonly blockedBy?: string;
  readonly inputPrompt?: string;
  readonly exitCode?: number;
  readonly error?: string;
  readonly createdAt: Date;
  readonly startedAt?: Date;
  readonly completedAt?: Date;
  readonly actionRequestId?: string;
  readonly summary?: string;
  readonly problem?: string;
  readonly approach?: string;
  readonly testPlan?: string;
  readonly reproCommand?: string;
  readonly branch?: string;
  readonly commit?: string;
  readonly parentTask?: string;
  readonly command?: string;
  readonly prompt?: string;
  readonly requiresManualApproval?: boolean;
  readonly pivot?: boolean;
  readonly experiments?: readonly string[];
  readonly selectedExperiment?: string;
  readonly experimentPrompt?: string;
  readonly experimentVariants?: readonly ExperimentVariant[];
  readonly isReconciliation?: boolean;
  readonly experimentResults?: readonly ExperimentResultEntry[];
  readonly repoUrl?: string;
  readonly featureBranch?: string;
  readonly isMergeNode?: boolean;
}

// ── Task Delta ──────────────────────────────────────────────

export type TaskDelta =
  | { readonly type: 'created'; readonly task: TaskState }
  | { readonly type: 'updated'; readonly taskId: string; readonly changes: Partial<TaskState> }
  | { readonly type: 'removed'; readonly taskId: string };

// ── Workflow Status ─────────────────────────────────────────

export interface WorkflowStatus {
  total: number;
  completed: number;
  failed: number;
  running: number;
  pending: number;
}

// ── Task Output Data ────────────────────────────────────────

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

// ── Plan Definition (simplified for UI) ─────────────────────

export interface PlanTask {
  id: string;
  description: string;
  dependencies?: string[];
  command?: string;
  prompt?: string;
  requiresManualApproval?: boolean;
  pivot?: boolean;
  experimentVariants?: ExperimentVariant[];
}

export interface PlanDefinition {
  name: string;
  tasks: PlanTask[];
  onFinish?: 'none' | 'merge' | 'pull_request';
}

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

// ── IPC Bridge API ──────────────────────────────────────────

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

  // External terminal launcher
  openTerminal: (taskId: string) => Promise<{ opened: boolean; reason?: string }>;

  // Workflow management
  resumeWorkflow: () => Promise<{ workflow: { id: string; name: string; status: string }; taskCount: number; startedCount: number } | null>;
  listWorkflows: () => Promise<Array<{ id: string; name: string; status: string; createdAt: string; updatedAt: string }>>;
  loadWorkflow: (workflowId: string) => Promise<{ workflow: unknown; tasks: unknown[] }>;
  onWorkflowsChanged: (cb: (workflows: unknown[]) => void) => () => void;
  deleteAllWorkflows: () => Promise<void>;
  cleanupWorktrees: () => Promise<{ removed: string[]; errors: string[] }>;
}

// ── Augment global Window ───────────────────────────────────

declare global {
  interface Window {
    invoker: InvokerAPI;
  }
}
