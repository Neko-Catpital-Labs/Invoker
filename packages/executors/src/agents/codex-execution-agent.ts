/**
 * CodexExecutionAgent — ExecutionAgent implementation for OpenAI Codex CLI.
 *
 * Agents provide command specs; familiars own the spawn lifecycle.
 */

import { randomUUID } from 'node:crypto';
import type { ExecutionAgent, AgentCommandSpec } from '../agent.js';

export interface CodexExecutionAgentConfig {
  /** Command to invoke the Codex CLI. Default: 'codex'. */
  command?: string;
  /** Run in full-auto mode (no interactive prompts). Default: true. */
  fullAuto?: boolean;
}

export class CodexExecutionAgent implements ExecutionAgent {
  readonly name = 'codex';
  readonly stdinMode = 'ignore' as const;
  readonly linuxTerminalTail = 'exec_bash' as const;

  private readonly command: string;
  private readonly fullAuto: boolean;

  constructor(config: CodexExecutionAgentConfig = {}) {
    this.command = config.command ?? 'codex';
    this.fullAuto = config.fullAuto ?? true;
  }

  buildCommand(fullPrompt: string): AgentCommandSpec {
    const sessionId = randomUUID();
    const args = ['exec', '--json'];
    if (this.fullAuto) args.push('--full-auto');
    args.push(fullPrompt);
    return { cmd: this.command, args, sessionId, fullPrompt };
  }

  buildResumeArgs(sessionId: string): { cmd: string; args: string[] } {
    return {
      cmd: this.command,
      args: ['resume', sessionId],
    };
  }

  buildFixCommand(prompt: string): AgentCommandSpec {
    const sessionId = randomUUID();
    const args = ['exec', '--json'];
    if (this.fullAuto) args.push('--full-auto');
    args.push(prompt);
    return { cmd: this.command, args, sessionId };
  }
}
