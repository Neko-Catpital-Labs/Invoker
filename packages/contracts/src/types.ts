/**
 * Worker Protocol Types
 *
 * Bazel-inspired request/response protocol for task execution.
 * Orchestrator writes a WorkRequest; executor runs the action;
 * executor returns a WorkResponse (via callback or IPC).
 */

// ── Action Types ────────────────────────────────────────────

export type ActionType = 'command' | 'ai_task' | 'reconciliation';

// ── Work Request ────────────────────────────────────────────

export interface WorkRequestInputs {
  workspacePath?: string;
  /** Human-readable task description for commit messages. */
  description?: string;
  prompt?: string;
  command?: string;
  experimentBranches?: string[];
  experimentResults?: ExperimentResult[];
  /** URL of the git repository to clone and work in via RepoPool. */
  repoUrl?: string;
  /** Feature branch name to create/checkout in the pooled worktree. */
  featureBranch?: string;
  /** Summaries from completed upstream dependencies, providing context for this task. */
  upstreamContext?: Array<{taskId: string; description: string; summary?: string; commitHash?: string; commitMessage?: string}>;
  /** Experiment alternatives from upstream reconciliation tasks. */
  alternatives?: Array<{
    taskId: string;
    description: string;
    branch?: string;
    commitHash?: string;
    status: 'completed' | 'failed';
    exitCode?: number;
    summary?: string;
    selected?: boolean;
  }>;
  /** Branch names from completed upstream dependencies to merge into the worktree. */
  upstreamBranches?: string[];
  /**
   * Visible lifecycle tag (e.g. `g0.t1.aabc12345`) embedded in the branch name
   * to make every dispatch unique-by-construction across recreates and retries.
   * Replaces the legacy `salt` field that mixed lifecycle context into the
   * content-hash itself.
   */
  lifecycleTag?: string;
  /** Workflow base branch — worktrees are created from this ref instead of HEAD. */
  baseBranch?: string;
  /** Name of the execution agent to use (e.g. 'claude', 'codex'). Defaults to 'claude'. */
  executionAgent?: string;
  /** When true, executors must not reuse existing task worktrees for this run. */
  freshWorkspace?: boolean;
}

export interface WorkRequest {
  requestId: string;
  actionId: string;
  /** Stable runtime execution identity for attempt-centric flows. */
  attemptId?: string;
  executionGeneration: number;
  actionType: ActionType;
  inputs: WorkRequestInputs;
  callbackUrl: string;
  timestamps: {
    createdAt: string; // ISO 8601
    startedAt?: string;
    completedAt?: string;
  };
}

// ── Work Response ───────────────────────────────────────────

export type ResponseStatus =
  | 'completed'
  | 'failed'
  | 'needs_input'
  | 'spawn_experiments'
  | 'select_experiment';

export interface WorkResponseOutputs {
  exitCode?: number;
  error?: string;
  summary?: string;
  commitHash?: string;
  agentSessionId?: string;
  /** Name of the ExecutionAgent that produced this session. */
  agentName?: string;
  /** Branch the executor used — persisted at completion to close the write-once gap. */
  branch?: string;
}

export interface SpawnExperimentsRequest {
  description: string;
  variants: ExperimentVariantDef[];
}

export interface ExperimentVariantDef {
  id: string;
  description?: string;
  prompt?: string;
  command?: string;
}

export interface SelectExperimentRequest {
  experimentId: string;
}

export interface DagMutation {
  spawnExperiments?: SpawnExperimentsRequest;
  selectExperiment?: SelectExperimentRequest;
}

export interface WorkResponse {
  requestId: string;
  actionId: string;
  /** Stable runtime execution identity for attempt-centric flows. */
  attemptId?: string;
  executionGeneration: number;
  status: ResponseStatus;
  outputs: WorkResponseOutputs;
  dagMutation?: DagMutation;
}

// ── Shared sub-types ────────────────────────────────────────

export interface ExperimentResult {
  id: string;
  status: 'completed' | 'failed';
  summary?: string;
  exitCode?: number;
}

// ── Factory ─────────────────────────────────────────────────

export function createWorkRequest(
  requestId: string,
  actionId: string,
  executionGeneration: number,
  actionType: ActionType,
  inputs: WorkRequestInputs,
  callbackUrl: string,
  attemptId?: string,
): WorkRequest {
  return {
    requestId,
    actionId,
    ...(attemptId ? { attemptId } : {}),
    executionGeneration,
    actionType,
    inputs,
    callbackUrl,
    timestamps: {
      createdAt: new Date().toISOString(),
    },
  };
}
