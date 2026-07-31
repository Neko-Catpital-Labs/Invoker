import { randomUUID } from 'node:crypto';
import type { ExecutionAgent } from './agent.js';
import type { SessionDriver } from './session-driver.js';

export interface HarnessSessionCommand {
  command: string;
  args: string[];
  sessionId: string;
}

export interface HarnessSessionDriver {
  readonly harness: string;
  /** True when `append` resumes the same agent session; false when it mints a fresh session every call. */
  readonly supportsSessionContinuity: boolean;
  start(prompt: string, options?: { model?: string }): HarnessSessionCommand;
  append(sessionId: string, prompt: string, options?: { model?: string }): HarnessSessionCommand;
  resolveSessionId?(
    rawStdout: string,
    command: HarnessSessionCommand,
    options: { startedNewSession: boolean },
  ): string | undefined;
}

export class ExecutionHarnessSessionDriver implements HarnessSessionDriver {
  readonly harness: string;
  readonly supportsSessionContinuity = true;

  constructor(
    private readonly agent: ExecutionAgent,
    private readonly sessionDriver?: Pick<SessionDriver, 'extractSessionId'>,
    private readonly mcpConfigPath?: string,
  ) {
    this.harness = agent.name;
  }

  start(prompt: string, options?: { model?: string }): HarnessSessionCommand {
    const command = this.agent.buildCommand(prompt, { executionModel: options?.model });
    if (!command.sessionId) {
      throw new Error(`Harness "${this.agent.name}" did not return a session id.`);
    }
    return {
      command: command.cmd,
      args: this.withMcpConfig(command.args),
      sessionId: command.sessionId,
    };
  }

  append(sessionId: string, prompt: string, options?: { model?: string }): HarnessSessionCommand {
    const resumed = this.agent.buildResumeArgs(sessionId);
    return {
      command: resumed.cmd,
      args: this.withMcpConfig(this.appendPromptArgs(resumed.args, prompt, options?.model)),
      sessionId,
    };
  }

  resolveSessionId(
    rawStdout: string,
    command: HarnessSessionCommand,
    options: { startedNewSession: boolean },
  ): string | undefined {
    const extracted = this.sessionDriver?.extractSessionId?.(rawStdout);
    if (extracted) return extracted;
    if (options.startedNewSession && this.agent.name === 'codex') {
      throw new Error(
        'Harness "codex" did not emit a resumable session id (thread.started.thread_id); '
        + `refusing to persist provisional session id "${command.sessionId}".`,
      );
    }
    return command.sessionId;
  }

  private withMcpConfig(args: string[]): string[] {
    if (!this.mcpConfigPath) return args;
    switch (this.agent.name) {
      case 'claude':
        return ['--mcp-config', this.mcpConfigPath, ...args];
      case 'codex':
        return [...args, '-c', 'mcp_servers.invoker.command="invoker-cli"', '-c', 'mcp_servers.invoker.args=["mcp"]'];
      default:
        return args;
    }
  }

  private appendPromptArgs(resumeArgs: string[], prompt: string, model?: string): string[] {
    switch (this.agent.name) {
      case 'claude':
        return [...resumeArgs, ...(model ? ['--model', model] : []), '-p', prompt];
      case 'codex':
        return ['exec', 'resume', ...resumeArgs.slice(1), ...(model ? ['--model', model] : []), prompt];
      case 'omp':
        return [...resumeArgs, ...(model ? ['--model', model] : []), '-p', prompt];
      default:
        throw new Error(`Harness "${this.agent.name}" does not support non-interactive session append.`);
    }
  }
}

export class ReplayHarnessSessionDriver implements HarnessSessionDriver {
  readonly supportsSessionContinuity = false;

  constructor(
    readonly harness: string,
    private readonly buildCommand: (prompt: string, options?: { model?: string }) => {
      command: string;
      args: string[];
    },
  ) {}

  start(prompt: string, options?: { model?: string }): HarnessSessionCommand {
    return this.create(prompt, options);
  }

  append(_sessionId: string, prompt: string, options?: { model?: string }): HarnessSessionCommand {
    return this.create(prompt, options);
  }

  private create(prompt: string, options?: { model?: string }): HarnessSessionCommand {
    const command = this.buildCommand(prompt, options);
    return { ...command, sessionId: randomUUID() };
  }
}
