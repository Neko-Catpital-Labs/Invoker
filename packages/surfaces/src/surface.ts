/**
 * Surface — Abstraction for bidirectional external interfaces (Slack, Discord, Linear).
 *
 * A Surface receives orchestrator events (outbound) and emits commands (inbound).
 * Each platform implements this interface. The host process (Electron main.ts)
 * wires surfaces to the Orchestrator and TaskRunner.
 */

import type { TaskDelta } from '@invoker/workflow-core';

// ── Commands (Surface → Orchestrator) ──────────────────────

export type SurfaceCommand =
  | { type: 'approve'; taskId: string }
  | { type: 'reject'; taskId: string; reason?: string }
  | { type: 'select_experiment'; taskId: string; experimentId: string }
  | { type: 'provide_input'; taskId: string; input: string }
  | { type: 'retry'; taskId: string }
  | { type: 'get_status'; workflowId?: string }
  | {
      type: 'start_plan';
      planText: string;
      repoUrl?: string;
      harnessPreset?: string;
      requestedBy?: string;
      lobbyChannel?: string;
      lobbyThreadTs?: string;
    };

// ── Workflow operations (Surface → Orchestrator, lobby command routing) ──

export type WorkflowOpName =
  | 'recreate'
  | 'rebase-recreate'
  | 'rebase-retry'
  | 'retry'
  | 'status'
  | 'cancel';

export type WorkflowOpTarget = { all: true } | { workflow: string };

export type WorkflowGatePolicy = 'completed' | 'review_ready';

export interface WorkflowGatePolicyUpdate {
  workflowId: string;
  taskId?: string;
  gatePolicy: WorkflowGatePolicy;
}

export interface WorkflowControlOp {
  operation: WorkflowOpName;
  target: WorkflowOpTarget;
}

export interface WorkflowGatePolicyOp {
  operation: 'gate-policy';
  target: WorkflowOpTarget;
  ownerTaskId?: string;
  updates: WorkflowGatePolicyUpdate[];
}

export type WorkflowOp = WorkflowControlOp | WorkflowGatePolicyOp;

export interface WorkflowOpResult {
  ok: boolean;
  summary: string;
}

/** Incremental progress for a bulk workflow op, streamed to the surface while it runs. */
export interface WorkflowOpProgress {
  /** Workflows processed so far (ok + failed). */
  done: number;
  /** Total workflows in this op. */
  total: number;
  /** Succeeded so far. */
  ok: number;
  /** Failed so far. */
  failed: number;
  /** The workflow currently being processed, when known. */
  current?: string;
}

// ── Events (Orchestrator → Surface) ────────────────────────

export interface WorkflowStatus {
  total: number;
  completed: number;
  failed: number;
  closed: number;
  running: number;
  pending: number;
}

export interface WorkflowProgressTask {
  id: string;
  name: string;
  status: string;
  phase?: string;
  reviewUrl?: string;
}

export interface WorkflowProgress {
  workflowId: string;
  name: string;
  counts: WorkflowStatus;
  percentComplete: number;
  tasks: WorkflowProgressTask[];
  prUrl?: string;
  reviewState?: string;
}

export type SurfaceEvent =
  | { type: 'task_delta'; delta: TaskDelta }
  | { type: 'workflow_status'; status: WorkflowStatus; workflowId?: string }
  | { type: 'workflow_progress'; progress: WorkflowProgress }
  | {
      type: 'workflow_created';
      workflowId: string;
      requestedBy?: string;
      lobbyChannel?: string;
      lobbyThreadTs?: string;
      harnessPreset?: string;
      repoUrl?: string;
    }
  | { type: 'error'; message: string };

// ── Logging ──────────────────────────────────────────────

export type LogFn = (source: string, level: string, message: string) => void;

// ── Interface ──────────────────────────────────────────────

export type CommandHandler = (command: SurfaceCommand) => void | Promise<void>;

export interface Surface {
  /** Unique identifier for this surface type (e.g. 'slack', 'discord'). */
  readonly type: string;

  /** Start the surface. Register event listeners, connect to external service. */
  start(onCommand: CommandHandler): Promise<void>;

  /** Push an event from the orchestrator to the surface. */
  handleEvent(event: SurfaceEvent): Promise<void>;

  /** Shut down the surface gracefully. */
  stop(): Promise<void>;
}
