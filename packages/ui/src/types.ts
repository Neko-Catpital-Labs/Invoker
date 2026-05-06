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
  | 'review_ready'
  | 'awaiting_approval'
  | 'stale';

// ── Experiment Types ────────────────────────────────────────

export interface ExperimentVariant {
  readonly id: string;
  readonly description: string;
  readonly prompt?: string;
}

export interface ExperimentResultEntry {
  readonly id: string;
  readonly status: 'completed' | 'failed';
  readonly summary?: string;
  readonly exitCode?: number;
}

export interface ExternalDependency {
  readonly workflowId: string;
  /** Optional task selector within the external workflow. Omit to depend on that workflow's merge gate. */
  readonly taskId?: string;
  readonly requiredStatus: 'completed';
  readonly gatePolicy?: 'completed' | 'review_ready';
}

export interface ExternalGatePolicyUpdate {
  workflowId: string;
  taskId?: string;
  gatePolicy: 'completed' | 'review_ready';
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
  readonly executorType?: string;
  readonly autoFix?: boolean;
  readonly remoteTargetId?: string;
  readonly isMergeNode?: boolean;
  readonly executionAgent?: string;
  readonly autoFixRetries?: number;
  readonly summary?: string;
  readonly problem?: string;
  readonly approach?: string;
  readonly testPlan?: string;
  readonly reproCommand?: string;
  readonly externalDependencies?: readonly ExternalDependency[];
}

// ── Task Execution (runtime fields) ────────────────────────

export interface TaskExecution {
  readonly phase?: 'launching' | 'executing';
  readonly generation?: number;
  readonly blockedBy?: string;
  readonly inputPrompt?: string;
  readonly exitCode?: number;
  readonly error?: string;
  readonly startedAt?: Date;
  readonly completedAt?: Date;
  readonly lastHeartbeatAt?: Date;
  readonly launchStartedAt?: Date;
  readonly launchCompletedAt?: Date;
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
  readonly autoFixAttempts?: number;
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
  | { readonly type: 'updated'; readonly taskId: string; readonly changes: TaskStateChanges; readonly taskStateVersion: number; readonly previousTaskStateVersion: number }
  | { readonly type: 'removed'; readonly taskId: string; readonly previousTaskStateVersion: number };

// ── Workflow Metadata ────────────────────────────────────────

export interface WorkflowMeta {
  id: string;
  name: string;
  status: string;
  baseBranch?: string;
  featureBranch?: string;
  onFinish?: string;
  mergeMode?: string;
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
  executorType?: string;
  autoFix?: boolean;
  executionAgent?: string;
}

// ── IPC Bridge API ──────────────────────────────────────────
// InvokerAPI is derived from the IPC channel registry in @invoker/contracts.

export type { InvokerAPI, ClaudeMessage, AgentSessionData } from '@invoker/contracts';

import type { InvokerAPI } from '@invoker/contracts';

// ── Augment global Window ───────────────────────────────────

declare global {
  interface Window {
    invoker: InvokerAPI;
    __INVOKER_BOOTSTRAP__?: {
      tasks?: TaskState[];
      workflows?: WorkflowMeta[];
      initialWorkflowId?: string | null;
      appStartedAtEpochMs?: number;
    };
  }
}
