/**
 * CodexExecutionAgent — ExecutionAgent implementation for OpenAI Codex CLI.
 *
 * Agents provide command specs; familiars own the spawn lifecycle.
 *
 * Known issue: `codex exec --json` exits 0 when the agent turn completes,
 * NOT when the task succeeds. Codex can fail to verify its fix (e.g. EPERM
 * blocking test execution) and still exit 0. Callers that check only the
 * exit code will treat an unverified fix as successful.
 */

import { randomUUID } from 'node:crypto';
import type { ExecutionAgent, AgentCommandSpec } from '../agent.js';

export interface CodexExecutionAgentConfig {
  /** Command to invoke the Codex CLI. Default: 'codex'. */
  command?: string;
  /**
   * Run in full-auto mode (sandboxed workspace-write + on-request approvals).
   * Ignored when bypassApprovalsAndSandbox is true.
   */
  fullAuto?: boolean;
  /**
   * Run without Codex sandbox/approval gating.
   * Default: true (Invoker already isolates work in managed workspaces).
   */
  bypassApprovalsAndSandbox?: boolean;
}

export class CodexExecutionAgent implements ExecutionAgent {
  readonly name = 'codex';
  readonly stdinMode = 'ignore' as const;
  readonly linuxTerminalTail = 'exec_bash' as const;

  private readonly command: string;
  private readonly fullAuto: boolean;
  private readonly bypassApprovalsAndSandbox: boolean;

  constructor(config: CodexExecutionAgentConfig = {}) {
    this.command = config.command ?? 'codex';
    this.bypassApprovalsAndSandbox = config.bypassApprovalsAndSandbox ?? true;
    this.fullAuto = config.fullAuto ?? true;
  }

  buildCommand(fullPrompt: string): AgentCommandSpec {
    const sessionId = randomUUID();
    const args = ['exec', '--json'];
    if (this.bypassApprovalsAndSandbox) args.push('--dangerously-bypass-approvals-and-sandbox');
    else if (this.fullAuto) args.push('--full-auto');
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
    if (this.bypassApprovalsAndSandbox) args.push('--dangerously-bypass-approvals-and-sandbox');
    else if (this.fullAuto) args.push('--full-auto');
    args.push(prompt);
    return { cmd: this.command, args, sessionId };
  }
}
