import type { PlanningAgent } from '../agent.js';

export interface CodexPlanningAgentConfig {
  command?: string;
  fullAuto?: boolean;
  bypassApprovalsAndSandbox?: boolean;
}

export class CodexPlanningAgent implements PlanningAgent {
  readonly name = 'codex';

  private readonly command: string;
  private readonly fullAuto: boolean;
  private readonly bypassApprovalsAndSandbox: boolean;

  constructor(config: CodexPlanningAgentConfig = {}) {
    this.command = config.command ?? 'codex';
    this.fullAuto = config.fullAuto ?? true;
    this.bypassApprovalsAndSandbox = config.bypassApprovalsAndSandbox ?? false;
  }

  buildPlanningCommand(prompt: string, _options?: { model?: string }): { command: string; args: string[] } {
    const args = ['exec', '--json'];
    if (this.bypassApprovalsAndSandbox) args.push('--dangerously-bypass-approvals-and-sandbox');
    else if (this.fullAuto) args.push('--full-auto');
    args.push(prompt);
    return { command: this.command, args };
  }
}
