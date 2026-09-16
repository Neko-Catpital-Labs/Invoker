import type { PlanningAgent } from '../agent.js';
import { createCodexSpendGateReader, type CodexSpendGateReader } from '../codex-spend-gate.js';

export interface CodexPlanningAgentConfig {
  command?: string;
  fullAuto?: boolean;
  bypassApprovalsAndSandbox?: boolean;
  spendGate?: CodexSpendGateReader;
}

export class CodexPlanningAgent implements PlanningAgent {
  readonly name = 'codex';

  private readonly command: string;
  private readonly fullAuto: boolean;
  private readonly bypassApprovalsAndSandbox: boolean;
  private readonly spendGate: CodexSpendGateReader;

  constructor(config: CodexPlanningAgentConfig = {}) {
    this.command = config.command ?? 'codex';
    this.fullAuto = config.fullAuto ?? true;
    this.bypassApprovalsAndSandbox = config.bypassApprovalsAndSandbox ?? false;
    this.spendGate = config.spendGate ?? createCodexSpendGateReader();
  }

  buildPlanningCommand(prompt: string, _options?: { model?: string }): { command: string; args: string[] } {
    this.spendGate.assertOpen();
    const args = ['exec', '--json'];
    if (this.bypassApprovalsAndSandbox) args.push('--dangerously-bypass-approvals-and-sandbox');
    else if (this.fullAuto) args.push('--sandbox', 'workspace-write');
    args.push(prompt);
    return { command: this.command, args };
  }
}
