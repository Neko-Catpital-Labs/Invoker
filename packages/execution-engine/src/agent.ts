/**
 * ExecutionAgent / PlanningAgent — Pluggable AI agent interfaces.
 *
 * Executors own the spawn lifecycle (stdio, exit handling, worktree/container setup).
 * Agents only provide command specs. This keeps the abstraction thin:
 * agents say *what* to run, executors decide *how* to run it.
 */

// ── Execution Agent ──────────────────────────────────────────

export interface AgentCommandSpec {
  cmd: string;
  args: string[];
  sessionId?: string;
  fullPrompt?: string;
}

export interface AgentCommandBuildOptions {
  executionModel?: string;
}

export const DEFAULT_EXECUTION_AGENT = 'claude';

export interface ExecutionAgent {
  readonly name: string;
  readonly stdinMode: 'ignore' | 'pipe';
  /** Tail command for Linux terminal launch (e.g. 'exec_bash' or 'pause'). */
  readonly linuxTerminalTail?: 'exec_bash' | 'pause';

  /**
   * Root directory where this agent's bundled skills are installed.
   * Example: ~/.claude/skills for the Claude agent.
   * Undefined when the agent has no bundled skill support.
   */
  readonly bundledSkillRoot?: string;

  /**
   * Skill names this agent bundles (e.g. ['make-pr']).
   * The registry uses this list for capability-based lookup.
   * Each name corresponds to a subdirectory `invoker-{name}` under bundledSkillRoot.
   */
  readonly bundledSkills?: readonly string[];

  buildCommand(fullPrompt: string, options?: AgentCommandBuildOptions): AgentCommandSpec;
  buildResumeArgs(sessionId: string): { cmd: string; args: string[] };
  /** Build a command spec for a fix/conflict-resolution prompt. */
  buildFixCommand?(prompt: string, options?: AgentCommandBuildOptions): AgentCommandSpec;
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
