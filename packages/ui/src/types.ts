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
  | 'fixing_with_ai'
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

// ── Task Config (plan-time / static fields) ────────────────

export interface TaskConfig {
  readonly workflowId?: string;
  readonly parentTask?: string;
  readonly command?: string;
  readonly prompt?: string;
  readonly experimentPrompt?: string;
  readonly pivot?: boolean;
  readonly experimentVariants?: readonly ExperimentVariant[];
  readonly isReconciliation?: boolean;
  readonly requiresManualApproval?: boolean;
  readonly repoUrl?: string;
  readonly featureBranch?: string;
  readonly familiarType?: string;
  readonly autoFix?: boolean;
  readonly remoteTargetId?: string;
  readonly isMergeNode?: boolean;
  readonly executionAgent?: string;
  readonly summary?: string;
  readonly problem?: string;
  readonly approach?: string;
  readonly testPlan?: string;
  readonly reproCommand?: string;
}

// ── Task Execution (runtime fields) ────────────────────────

export interface TaskExecution {
  readonly blockedBy?: string;
  readonly inputPrompt?: string;
  readonly exitCode?: number;
  readonly error?: string;
  readonly startedAt?: Date;
  readonly completedAt?: Date;
  readonly lastHeartbeatAt?: Date;
  readonly actionRequestId?: string;
  readonly branch?: string;
  readonly commit?: string;
  readonly agentSessionId?: string;
  readonly workspacePath?: string;
  readonly containerId?: string;
  readonly experiments?: readonly string[];
  readonly selectedExperiment?: string;
  readonly selectedExperiments?: readonly string[];
  readonly experimentResults?: readonly ExperimentResultEntry[];
  readonly pendingFixError?: string;
  readonly isFixingWithAI?: boolean;
  readonly reviewUrl?: string;
  readonly reviewId?: string;
  readonly reviewStatus?: string;
  readonly reviewProviderId?: string;
  readonly mergeConflict?: {
    readonly failedBranch: string;
    readonly conflictFiles: readonly string[];
  };
  readonly agentName?: string;
}

// ── Task State ──────────────────────────────────────────────

export interface TaskState {
  readonly id: string;
  readonly description: string;
  readonly status: TaskStatus;
  readonly dependencies: readonly string[];
  readonly createdAt: Date;
  readonly config: TaskConfig;
  readonly execution: TaskExecution;
}

// ── Task State Changes ──────────────────────────────────────

export interface TaskStateChanges {
  readonly status?: TaskStatus;
  readonly description?: string;
  readonly dependencies?: readonly string[];
  readonly config?: Partial<TaskConfig>;
  readonly execution?: Partial<TaskExecution>;
}

// ── Task Delta ──────────────────────────────────────────────

export type TaskDelta =
  | { readonly type: 'created'; readonly task: TaskState }
  | { readonly type: 'updated'; readonly taskId: string; readonly changes: TaskStateChanges }
  | { readonly type: 'removed'; readonly taskId: string };

// ── Workflow Metadata ────────────────────────────────────────

export interface WorkflowMeta {
  id: string;
  name: string;
  status: string;
  baseBranch?: string;
  featureBranch?: string;
  onFinish?: string;
  mergeMode?: 'manual' | 'automatic' | 'external_review';
  reviewProvider?: string;
}

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
  baseBranch?: string;
  mergeMode?: 'manual' | 'automatic' | 'external_review';
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
  executionAgent?: string;
}

// ── IPC Bridge API ──────────────────────────────────────────

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

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
  editTaskAgent: (taskId: string, agentName: string) => Promise<void>;
  getRemoteTargets: () => Promise<string[]>;
  getExecutionAgents: () => Promise<string[]>;
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
  deleteWorkflow: (workflowId: string) => Promise<void>;
  cleanupWorktrees: () => Promise<{ removed: string[]; errors: string[] }>;
  restartWorkflow: (workflowId: string) => Promise<void>;
  rebaseAndRetry: (mergeTaskId: string) => Promise<{
    success: boolean;
    rebasedBranches: string[];
    errors: string[];
  }>;
  setMergeBranch: (workflowId: string, baseBranch: string) => Promise<void>;
  approveMerge: (workflowId: string) => Promise<void>;
  resolveConflict: (taskId: string, agentName?: string) => Promise<void>;
  fixWithClaude: (taskId: string, agentName?: string) => Promise<void>;
  setMergeMode: (workflowId: string, mergeMode: string) => Promise<void>;
  checkPrStatuses: () => Promise<void>;

  // Cancel task with DAG cascade
  cancelTask: (taskId: string) => Promise<{ cancelled: string[]; runningCancelled: string[] }>;

  // Queue status
  getQueueStatus: () => Promise<{
    maxConcurrency: number;
    runningCount: number;
    running: Array<{ taskId: string; description: string }>;
    queued: Array<{ taskId: string; priority: number; description: string }>;
  }>;
}

// ── Augment global Window ───────────────────────────────────

declare global {
  interface Window {
    invoker: InvokerAPI;
  }
}
