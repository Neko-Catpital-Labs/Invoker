import type { PlanningAgent } from '../agent.js';

export interface OmpPlanningAgentConfig {
  command?: string;
}

export class OmpPlanningAgent implements PlanningAgent {
  readonly name = 'omp';

  private readonly command: string;

  constructor(config: OmpPlanningAgentConfig = {}) {
    this.command = config.command ?? 'omp';
  }

  buildPlanningCommand(
    prompt: string,
    options?: { model?: string },
  ): { command: string; args: string[] } {
    return {
      command: this.command,
      args: [
        '--no-title',
        '--auto-approve',
        ...(options?.model ? ['--model', options.model] : []),
        '-p',
        prompt,
      ],
    };
  }
}
