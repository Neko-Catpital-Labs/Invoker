/**
 * CodexExecutionAgent — ExecutionAgent implementation for OpenAI Codex CLI.
 *
 * Agents provide command specs; executors own the spawn lifecycle.
 *
 * Known issue: `codex exec --json` exits 0 when the agent turn completes,
 * NOT when the task succeeds. Codex can fail to verify its fix (e.g. EPERM
 * blocking test execution) and still exit 0. Callers that check only the
 * exit code will treat an unverified fix as successful.
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ExecutionAgent, AgentCommandSpec, AgentCommandBuildOptions } from '../agent.js';

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
  readonly bundledSkillRoot: string;
  readonly bundledSkills = ['make-pr'] as const;

  private readonly command: string;
  private readonly fullAuto: boolean;
  private readonly bypassApprovalsAndSandbox: boolean;

  constructor(config: CodexExecutionAgentConfig = {}) {
    this.command = config.command ?? 'codex';
    this.bypassApprovalsAndSandbox = config.bypassApprovalsAndSandbox ?? true;
    this.fullAuto = config.fullAuto ?? true;
    this.bundledSkillRoot = join(homedir(), '.codex', 'skills');
  }

  buildCommand(fullPrompt: string, options: AgentCommandBuildOptions = {}): AgentCommandSpec {
    const sessionId = randomUUID();
    const args = ['exec', '--json'];
    if (this.bypassApprovalsAndSandbox) args.push(...this.buildBypassArgs());
    else if (this.fullAuto) args.push('--full-auto');
    args.push(...this.buildModelArgs(options.executionModel), fullPrompt);
    return { cmd: this.command, args, sessionId, fullPrompt };
  }

  buildResumeArgs(sessionId: string): { cmd: string; args: string[] } {
    return {
      cmd: this.command,
      args: ['resume', ...this.buildBypassArgs(), sessionId],
    };
  }

  buildFixCommand(prompt: string, options: AgentCommandBuildOptions = {}): AgentCommandSpec {
    const sessionId = randomUUID();
    const args = ['exec', '--json'];
    if (this.bypassApprovalsAndSandbox) args.push(...this.buildBypassArgs());
    else if (this.fullAuto) args.push('--full-auto');
    args.push(...this.buildModelArgs(options.executionModel), prompt);
    return { cmd: this.command, args, sessionId };
  }

  private buildModelArgs(executionModel?: string): string[] {
    return executionModel ? ['--model', executionModel] : [];
  }

  private buildBypassArgs(): string[] {
    return this.bypassApprovalsAndSandbox
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : [];
  }
}
