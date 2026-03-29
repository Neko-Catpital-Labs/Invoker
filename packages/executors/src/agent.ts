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

export interface ExecutionAgent {
  readonly name: string;
  readonly stdinMode: 'ignore' | 'pipe';
  buildCommand(fullPrompt: string): AgentCommandSpec;
  buildResumeArgs(sessionId: string): { cmd: string; args: string[] };
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
