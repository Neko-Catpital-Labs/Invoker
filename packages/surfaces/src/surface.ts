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
  | { type: 'get_status' }
  | { type: 'start_plan'; planText: string };

// ── Events (Orchestrator → Surface) ────────────────────────

export interface WorkflowStatus {
  total: number;
  completed: number;
  failed: number;
  running: number;
  pending: number;
}

export type SurfaceEvent =
  | { type: 'task_delta'; delta: TaskDelta }
  | { type: 'workflow_status'; status: WorkflowStatus }
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
