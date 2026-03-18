/**
 * Core task types for the Invoker orchestration engine.
 *
 * These types are intentionally executor-agnostic: no Docker container IDs,
 * no image names, no workspace paths. Those live in the executor layer.
 */

// ── Task Status FSM ─────────────────────────────────────────

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'needs_input'
  | 'blocked'
  | 'awaiting_approval'
  | 'stale';

// ── Utilization Constants ────────────────────────────────────

/** Task demands exclusive execution — nothing else runs alongside it. */
export const UTILIZATION_MAX = 2147483647;

// ── Task Config (definition / spec) ────────────────────────
// Copied wholesale when cloning/forking: clone.config = original.config

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
  readonly maxFixAttempts?: number;
  readonly isMergeNode?: boolean;
  readonly summary?: string;
  readonly problem?: string;
  readonly approach?: string;
  readonly testPlan?: string;
  readonly reproCommand?: string;
  readonly utilization?: number;
}

// ── Task Execution (runtime state) ─────────────────────────
// Never copied when cloning. Reset on restart.

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
  readonly claudeSessionId?: string;
  readonly workspacePath?: string;
  readonly containerId?: string;
  readonly experiments?: readonly string[];
  readonly selectedExperiment?: string;
  readonly selectedExperiments?: readonly string[];
  readonly experimentResults?: readonly ExperimentResultEntry[];
  readonly pendingFixError?: string;
  readonly mergeConflict?: {
    readonly failedBranch: string;
    readonly conflictFiles: readonly string[];
  };
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

export interface ExperimentVariant {
  readonly id: string;
  readonly description: string;
  readonly prompt?: string;
  readonly command?: string;
}

export interface ExperimentResultEntry {
  readonly id: string;
  readonly status: 'completed' | 'failed';
  readonly summary?: string;
  readonly exitCode?: number;
}

// ── Task State Changes (for updates / deltas) ───────────────

export interface TaskStateChanges {
  readonly status?: TaskStatus;
  readonly dependencies?: readonly string[];
  readonly config?: Partial<TaskConfig>;
  readonly execution?: Partial<TaskExecution>;
}

// ── Task Delta (for UI updates) ─────────────────────────────

export type TaskDelta =
  | { readonly type: 'created'; readonly task: TaskState }
  | { readonly type: 'updated'; readonly taskId: string; readonly changes: TaskStateChanges }
  | { readonly type: 'removed'; readonly taskId: string };

// ── Task Transition (audit log entry) ───────────────────────

export interface TaskTransition {
  readonly from: TaskStatus;
  readonly to: TaskStatus;
  readonly taskId: string;
  readonly timestamp: Date;
}

// ── Side Effects ────────────────────────────────────────────

export type SideEffect =
  | { readonly type: 'tasks_ready'; readonly taskIds: readonly string[] }
  | { readonly type: 'tasks_blocked'; readonly taskIds: readonly string[]; readonly blockedBy: string }
  | { readonly type: 'reconciliation_triggered'; readonly taskId: string };

// ── Transition Result ───────────────────────────────────────

export interface TransitionResult {
  readonly task: TaskState;
  readonly delta: TaskDelta;
  readonly transition: TaskTransition;
  readonly sideEffects: readonly SideEffect[];
}

// ── Task Create Options (alias for TaskConfig) ──────────────

export type TaskCreateOptions = Partial<TaskConfig>;

// ── Helper to create a new TaskState ────────────────────────

export function createTaskState(
  id: string,
  description: string,
  dependencies: string[],
  options: TaskCreateOptions = {},
): TaskState {
  return {
    id,
    description,
    status: 'pending',
    dependencies: [...dependencies],
    createdAt: new Date(),
    config: { ...options },
    execution: {},
  };
}
