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
  | 'fixing_with_ai'
  | 'completed'
  | 'failed'
  | 'needs_input'
  | 'blocked'
  | 'review_ready'
  | 'awaiting_approval'
  | 'stale';

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
  readonly featureBranch?: string;
  readonly familiarType?: string;
  readonly dockerImage?: string;
  readonly remoteTargetId?: string;
  readonly autoFix?: boolean;
  readonly isMergeNode?: boolean;
  readonly summary?: string;
  readonly problem?: string;
  readonly approach?: string;
  readonly testPlan?: string;
  readonly reproCommand?: string;
  /** Name of the execution agent to use (e.g. 'claude', 'codex'). Defaults to 'claude'. */
  readonly executionAgent?: string;
  /** Cross-workflow prerequisites for this task. */
  readonly externalDependencies?: readonly ExternalDependency[];
}

export interface ExternalDependency {
  readonly workflowId: string;
  /** Optional task selector within the external workflow. Omit to depend on that workflow's merge gate. */
  readonly taskId?: string;
  readonly requiredStatus: 'completed';
  /** review_ready (default): merge gate review_ready/awaiting_approval/completed. approved: wait for completed. */
  readonly gatePolicy?: 'approved' | 'review_ready';
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
  readonly agentSessionId?: string;
  readonly lastAgentSessionId?: string;
  readonly agentName?: string;
  readonly lastAgentName?: string;
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
  readonly selectedAttemptId?: string;
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

// ── Attempt Status ──────────────────────────────────────────

export type AttemptStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'needs_input'
  | 'superseded';

// ── Attempt (immutable execution record) ────────────────────

export interface Attempt {
  readonly id: string;                      // e.g., "taskA-a3f1c0e2"
  readonly nodeId: string;

  // ── Input snapshot ──
  readonly snapshotCommit?: string;
  readonly baseBranch?: string;
  readonly upstreamAttemptIds: readonly string[];

  // ── Overrides (per-attempt variation of node config) ──
  readonly commandOverride?: string;
  readonly promptOverride?: string;

  // ── Execution state ──
  readonly status: AttemptStatus;
  readonly startedAt?: Date;
  readonly completedAt?: Date;
  readonly exitCode?: number;
  readonly error?: string;
  readonly lastHeartbeatAt?: Date;

  // ── Output ──
  readonly branch?: string;
  readonly commit?: string;
  readonly summary?: string;
  readonly workspacePath?: string;
  readonly agentSessionId?: string;
  readonly containerId?: string;

  // ── Lineage ──
  readonly supersedesAttemptId?: string;
  readonly createdAt: Date;

  // ── Merge conflict ──
  readonly mergeConflict?: {
    readonly failedBranch: string;
    readonly conflictFiles: readonly string[];
  };
}

// ── Helper to create a new Attempt ──────────────────────────

export function createAttempt(
  nodeId: string,
  opts: Partial<Omit<Attempt, 'id' | 'nodeId' | 'createdAt'>> = {},
): Attempt {
  const shortId = crypto.randomUUID().slice(0, 8);
  return {
    id: `${nodeId}-a${shortId}`,
    nodeId,
    status: 'pending',
    upstreamAttemptIds: [],
    createdAt: new Date(),
    ...opts,
  };
}
