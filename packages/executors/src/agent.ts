/**
 * ExecutionAgent / PlanningAgent — Pluggable AI agent interfaces.
 *
 * Familiars own the spawn lifecycle (stdio, exit handling, worktree/container setup).
 * Agents only provide command specs. This keeps the abstraction thin:
 * agents say *what* to run, familiars decide *how* to run it.
 */

// ── Execution Agent ──────────────────────────────────────────

export interface AgentCommandSpec {
  cmd: string;
  args: string[];
  sessionId?: string;
  fullPrompt?: string;
}

export const DEFAULT_EXECUTION_AGENT = 'claude';

export interface ExecutionAgent {
  readonly name: string;
  readonly stdinMode: 'ignore' | 'pipe';
  /** Tail command for Linux terminal launch (e.g. 'exec_bash' or 'pause'). */
  readonly linuxTerminalTail?: 'exec_bash' | 'pause';
  buildCommand(fullPrompt: string): AgentCommandSpec;
  buildResumeArgs(sessionId: string): { cmd: string; args: string[] };
  /** Build a command spec for a fix/conflict-resolution prompt. */
  buildFixCommand?(prompt: string): AgentCommandSpec;
  getContainerRequirements?(): {
    mounts: Array<{ hostPath: string; containerPath: string; readonly?: boolean }>;
    env: Record<string, string>;
  };
}

// ── Planning Agent ───────────────────────────────────────────

export interface PlanningAgent {
  readonly name: string;
  buildPlanningCommand(prompt: string): { command: string; args: string[] };
}
