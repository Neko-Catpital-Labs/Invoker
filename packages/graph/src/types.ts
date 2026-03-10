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

// ── Task State ──────────────────────────────────────────────

export interface TaskState {
  readonly id: string;
  readonly description: string;
  readonly status: TaskStatus;
  readonly dependencies: readonly string[];

  // Blocking info
  readonly blockedBy?: string;

  // Input
  readonly inputPrompt?: string;

  // Exit info
  readonly exitCode?: number;
  readonly error?: string;

  // Timestamps
  readonly createdAt: Date;
  readonly startedAt?: Date;
  readonly completedAt?: Date;

  // Worker protocol correlation
  readonly actionRequestId?: string;

  // Git-backed context (Beads-inspired)
  readonly summary?: string;
  readonly problem?: string;
  readonly approach?: string;
  readonly testPlan?: string;
  readonly reproCommand?: string;

  // Git tracking
  readonly branch?: string;
  readonly commit?: string;
  readonly parentTask?: string;

  // Execution directives
  readonly command?: string;
  readonly prompt?: string;

  // Manual approval
  readonly requiresManualApproval?: boolean;

  // Experiment fields
  readonly pivot?: boolean;
  readonly experiments?: readonly string[];
  readonly selectedExperiment?: string;
  readonly experimentPrompt?: string;
  readonly experimentVariants?: readonly ExperimentVariant[];

  // Reconciliation fields
  readonly isReconciliation?: boolean;
  readonly experimentResults?: readonly ExperimentResultEntry[];

  // Repository info
  readonly repoUrl?: string;
  readonly featureBranch?: string;

  // Familiar selection (e.g. 'local', 'worktree', 'docker')
  readonly familiarType?: string;

  // Claude session ID for resuming terminal sessions
  readonly claudeSessionId?: string;

  // Workspace path where the task executed (for session recovery)
  readonly workspacePath?: string;

  // Docker container ID for terminal reconnection
  readonly containerId?: string;

  // Auto-fix support
  readonly autoFix?: boolean;
  readonly maxFixAttempts?: number;
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

// ── Task Delta (for UI updates) ─────────────────────────────

export type TaskDelta =
  | { readonly type: 'created'; readonly task: TaskState }
  | { readonly type: 'updated'; readonly taskId: string; readonly changes: Partial<TaskState> }
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

// ── Task Create Options ─────────────────────────────────────

export interface TaskCreateOptions {
  parentTask?: string;
  command?: string;
  prompt?: string;
  experimentPrompt?: string;
  pivot?: boolean;
  experimentVariants?: ExperimentVariant[];
  isReconciliation?: boolean;
  requiresManualApproval?: boolean;
  repoUrl?: string;
  featureBranch?: string;
  familiarType?: string;
  autoFix?: boolean;
  maxFixAttempts?: number;
  summary?: string;
  problem?: string;
  approach?: string;
  testPlan?: string;
  reproCommand?: string;
}

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
    ...options,
  };
}
