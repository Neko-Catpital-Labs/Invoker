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
  | 'closed'
  | 'needs_input'
  | 'blocked'
  | 'review_ready'
  | 'awaiting_approval'
  | 'stale';

// ── Task Config (definition / spec) ────────────────────────
// Copied wholesale when cloning/forking: clone.config = original.config

export interface BaseTaskConfig {
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
  /** Execution pool identifier for shared queue/drain scheduling across substrates. */
  readonly poolId?: string;
  /** Legacy direct SSH pool member selection used by editable runner controls. */
  readonly poolMemberId?: string;
  /**
   * Fix-session prompt override carried on the failed task across the
   * `failed` → `fixing_with_ai` → `failed` cycle (Step 10 of the
   * task-invalidation roadmap). Mutating either `fixPrompt` or
   * `fixContext` routes through `Orchestrator.editTaskFixContext`
   * (`MUTATION_POLICIES.fixContext` → `retryTask` / task scope) and
   * retries from the reverted failed-state baseline.
   */
  readonly fixPrompt?: string;
  /**
   * Fix-session context override (e.g. extra notes/files surfaced to the
   * fix agent) carried alongside `fixPrompt`. See `fixPrompt`.
   */
  readonly fixContext?: string;
}

export interface WorktreeTaskConfig extends BaseTaskConfig {
  readonly runnerKind?: 'worktree';
  readonly dockerImage?: never;
}

export interface DockerTaskConfig extends BaseTaskConfig {
  readonly runnerKind: 'docker';
  readonly dockerImage?: string;
}

export interface SshTaskConfig extends BaseTaskConfig {
  readonly runnerKind: 'ssh';
  readonly dockerImage?: never;
}

/** Internal-only config for merge gate nodes. */
export interface MergeTaskConfig extends BaseTaskConfig {
  readonly runnerKind: 'merge';
  readonly dockerImage?: never;
}

export type TaskConfig = WorktreeTaskConfig | DockerTaskConfig | SshTaskConfig | MergeTaskConfig;

export interface ExternalDependency {
  readonly workflowId: string;
  /** Optional task selector within the external workflow. Omit to depend on that workflow's merge gate. */
  readonly taskId?: string;
  readonly requiredStatus: 'completed';
  /** review_ready (default): merge gate review_ready/awaiting_approval/completed count as satisfied. completed: strict — only 'completed' satisfies. */
  readonly gatePolicy?: 'completed' | 'review_ready';
}

export interface ExternalDependencyChange {
  readonly before?: ExternalDependency;
  readonly after?: ExternalDependency;
  readonly changedAt: string;
  readonly changedBy?: string;
}

// ── Remote lease metadata ──────────────────────────────────
// Durable record of an on-demand remote lease backing a task/attempt.
// Provider-tagged so future providers can extend the union without breaking
// existing consumers. Used for cleanup and terminal restore after restarts.

export interface CrabboxRemoteLeaseMetadata {
  readonly provider: 'crabbox';
  /** Crabbox lease identifier used for status/stop calls. */
  readonly leaseId: string;
  /** Human-readable lease slug. */
  readonly slug: string;
  /** Crabbox target identifier the lease was created from. */
  readonly targetId: string;
  /** SSH host of the leased box. */
  readonly sshHost: string;
  /** SSH user for the leased box. */
  readonly sshUser: string;
  /** SSH port for the leased box. */
  readonly sshPort: number;
  /** Path to the SSH identity file used to reach the leased box. */
  readonly sshKeyPath: string;
  /** ISO timestamp at which the lease expires. */
  readonly expiresAt: string;
  /** When to stop the box after the task finishes (e.g. `'5m'`). */
  readonly stopAfter?: string;
  /** When true, the box is kept alive on task failure for debugging. */
  readonly keepOnFailure?: boolean;
}

/** Durable metadata for an on-demand remote lease. Provider-tagged union. */
export type RemoteLeaseMetadata = CrabboxRemoteLeaseMetadata;

// ── Task Execution (runtime state) ─────────────────────────
// Never copied when cloning. Reset on restart.

export type TaskRunPhase = 'launching' | 'executing';
export type TaskHeartbeatSource = 'executor' | 'remote_workload';

export interface TaskExecution {
  readonly generation?: number;
  readonly blockedBy?: string;
  readonly inputPrompt?: string;
  readonly exitCode?: number;
  readonly error?: string;
  readonly protocolErrorCode?: string;
  readonly protocolErrorMessage?: string;
  readonly startedAt?: Date;
  readonly completedAt?: Date;
  readonly lastHeartbeatAt?: Date;
  readonly remoteHeartbeatAt?: Date;
  readonly heartbeatSource?: TaskHeartbeatSource;
  readonly actionRequestId?: string;
  readonly branch?: string;
  readonly commit?: string;
  readonly fixedIntegrationSha?: string;
  readonly fixedIntegrationRecordedAt?: Date;
  readonly fixedIntegrationSource?: string;
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
  readonly phase?: TaskRunPhase;
  readonly launchStartedAt?: Date;
  readonly launchCompletedAt?: Date;
  readonly mergeConflict?: {
    readonly failedBranch: string;
    readonly conflictFiles: readonly string[];
  };
  readonly selectedAttemptId?: string;
  readonly autoFixAttempts?: number;
  /**
   * Durable record of the remote lease backing this task's execution, if any.
   * Survives restarts so the lease can be cleaned up and the terminal restored.
   */
  readonly remoteLeaseMetadata?: RemoteLeaseMetadata;
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
  readonly taskStateVersion: number;
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
  readonly description?: string;
  readonly status?: TaskStatus;
  readonly dependencies?: readonly string[];
  readonly config?: Partial<TaskConfig>;
  readonly execution?: Partial<TaskExecution>;
}

// ── Task Delta (for UI updates) ─────────────────────────────

export type TaskDelta =
  | { readonly type: 'created'; readonly task: TaskState; readonly streamSequence?: number }
  | { readonly type: 'updated'; readonly taskId: string; readonly changes: TaskStateChanges; readonly taskStateVersion: number; readonly previousTaskStateVersion: number; readonly streamSequence?: number }
  | { readonly type: 'removed'; readonly taskId: string; readonly previousTaskStateVersion: number; readonly streamSequence?: number };

// ── Task Create Options (alias for TaskConfig) ──────────────

export type TaskCreateOptions = TaskConfig;

function resolveInitialTaskTimestamp(): Date {
  if (process.env.NODE_ENV === 'test' && process.env.INVOKER_TEST_FIXED_NOW) {
    return new Date(process.env.INVOKER_TEST_FIXED_NOW);
  }
  return new Date();
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
    createdAt: resolveInitialTaskTimestamp(),
    config: { ...options },
    execution: { generation: 0 },
    taskStateVersion: 1,
  };
}

// ── Attempt Status ──────────────────────────────────────────

export type AttemptStatus =
  | 'pending'
  | 'claimed'
  | 'running'
  | 'completed'
  | 'failed'
  | 'needs_input'
  | 'superseded';

// ── Attempt (immutable execution record) ────────────────────

export interface Attempt {
  readonly id: string;                      // e.g., "taskA-a3f1c0e2"
  readonly nodeId: string;
  readonly queuePriority: number;

  // ── Input snapshot ──
  readonly snapshotCommit?: string;
  readonly baseBranch?: string;
  readonly upstreamAttemptIds: readonly string[];

  // ── Overrides (per-attempt variation of node config) ──
  readonly commandOverride?: string;
  readonly promptOverride?: string;

  // ── Execution state ──
  readonly status: AttemptStatus;
  readonly claimedAt?: Date;
  readonly startedAt?: Date;
  readonly completedAt?: Date;
  readonly exitCode?: number;
  readonly error?: string;
  readonly lastHeartbeatAt?: Date;
  readonly leaseExpiresAt?: Date;

  // ── Output ──
  readonly branch?: string;
  readonly commit?: string;
  readonly summary?: string;
  readonly workspacePath?: string;
  readonly agentSessionId?: string;
  readonly containerId?: string;
  /** Durable record of the remote lease backing this attempt, if any. */
  readonly remoteLeaseMetadata?: RemoteLeaseMetadata;

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
    queuePriority: 0,
    status: 'pending',
    upstreamAttemptIds: [],
    createdAt: new Date(),
    ...opts,
  };
}
