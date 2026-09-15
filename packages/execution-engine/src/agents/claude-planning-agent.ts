import type { PlanningAgent } from '../agent.js';

export interface ClaudePlanningAgentConfig {
  /** Command to invoke the Claude Code CLI. Default: 'claude'. */
  command?: string;
}

export class ClaudePlanningAgent implements PlanningAgent {
  readonly name = 'claude';

  private readonly command: string;

  constructor(config: ClaudePlanningAgentConfig = {}) {
    this.command = config.command ?? 'claude';
  }

  buildPlanningCommand(
    prompt: string,
    options?: { model?: string },
  ): { command: string; args: string[] } {
    return {
      command: this.command,
      args: [
        '--dangerously-skip-permissions',
        ...(options?.model ? ['--model', options.model] : []),
        '-p',
        prompt,
      ],
    };
  }
}
