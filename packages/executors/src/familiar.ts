import type { WorkRequest, WorkResponse } from '@invoker/protocol';

export type Unsubscribe = () => void;

export interface FamiliarHandle {
  executionId: string;
  taskId: string;
  claudeSessionId?: string;
  containerId?: string;
  workspacePath?: string;
  branch?: string;
}

export interface TerminalSpec {
  /** Working directory for the terminal. Used when no command is specified. */
  cwd?: string;
  /** Command to execute inside the terminal (e.g., 'docker', 'ssh'). */
  command?: string;
  /** Arguments for the command. */
  args?: string[];
}

export interface PersistedTaskMeta {
  taskId: string;
  familiarType: string;
  claudeSessionId?: string;
  containerId?: string;
  workspacePath?: string;
}

export interface Familiar {
  readonly type: string;
  start(request: WorkRequest): Promise<FamiliarHandle>;
  kill(handle: FamiliarHandle): Promise<void>;
  sendInput(handle: FamiliarHandle, input: string): void;
  onOutput(handle: FamiliarHandle, cb: (data: string) => void): Unsubscribe;
  onComplete(handle: FamiliarHandle, cb: (response: WorkResponse) => void): Unsubscribe;
  getTerminalSpec(handle: FamiliarHandle): TerminalSpec | null;
  /**
   * Reconstruct a TerminalSpec from persisted DB metadata (no in-memory handle required).
   * Throws if the workspace path no longer exists on disk.
   */
  getRestoredTerminalSpec(meta: PersistedTaskMeta): TerminalSpec;
  destroyAll(): Promise<void>;
}
