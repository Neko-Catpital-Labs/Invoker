import type { WorkRequest, WorkResponse } from '@invoker/contracts';

export type Unsubscribe = () => void;

export interface ExecutorHandle {
  executionId: string;
  taskId: string;
  agentSessionId?: string;
  containerId?: string;
  workspacePath?: string;
  branch?: string;
  /** Optional display-only text rendered before terminal output. */
  displayBridge?: string;
}

export const MAX_TERMINAL_DISPLAY_BRIDGE_CHARS = 4096;

export function normalizeTerminalDisplayBridge(displayBridge: string | undefined): string | undefined {
  if (!displayBridge) return undefined;
  const withTrailingNewline = displayBridge.endsWith('\n') ? displayBridge : `${displayBridge}\n`;
  if (withTrailingNewline.length <= MAX_TERMINAL_DISPLAY_BRIDGE_CHARS) return withTrailingNewline;
  return `${withTrailingNewline.slice(0, MAX_TERMINAL_DISPLAY_BRIDGE_CHARS - 1)}\n`;
}

export interface TerminalSpec {
  /** Working directory for the terminal. Used when no command is specified. */
  cwd?: string;
  /** Command to execute inside the terminal (e.g., 'docker', 'ssh'). */
  command?: string;
  /** Arguments for the command. */
  args?: string[];
  /** Tail command for Linux terminal launch (e.g. 'exec_bash' or 'pause'). */
  linuxTerminalTail?: 'exec_bash' | 'pause';
  /**
   * Display-only context rendered as terminal output before the command starts.
   * Consumers must keep it inert: do not feed it to agents, argv, cwd, status,
   * lifecycle decisions, or task persistence.
   */
  displayBridge?: string;
}

export interface PersistedTaskMeta {
  taskId: string;
  runnerKind: string;
  agentSessionId?: string;
  /** Configured execution agent name (e.g. 'claude', 'codex'). Used for session resume. */
  executionAgent?: string;
  containerId?: string;
  workspacePath?: string;
  branch?: string;
  /** Optional display-only text supplied by a caller reconstructing a terminal spec. */
  displayBridge?: string;
}

export interface Executor {
  readonly type: string;
  start(request: WorkRequest): Promise<ExecutorHandle>;
  kill(handle: ExecutorHandle): Promise<void>;
  sendInput(handle: ExecutorHandle, input: string): void;
  onOutput(handle: ExecutorHandle, cb: (data: string) => void): Unsubscribe;
  onComplete(handle: ExecutorHandle, cb: (response: WorkResponse) => void): Unsubscribe;
  onHeartbeat(handle: ExecutorHandle, cb: (taskId: string) => void): Unsubscribe;
  getTerminalSpec(handle: ExecutorHandle): TerminalSpec | null;
  /**
   * Reconstruct a TerminalSpec from persisted DB metadata (no in-memory handle required).
   * Throws if the workspace path no longer exists on disk.
   */
  getRestoredTerminalSpec(meta: PersistedTaskMeta): TerminalSpec;
  destroyAll(): Promise<void>;
}
