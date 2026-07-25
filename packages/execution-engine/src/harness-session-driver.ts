import { randomUUID } from 'node:crypto';
import type { ExecutionAgent } from './agent.js';

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
}

export class ExecutionHarnessSessionDriver implements HarnessSessionDriver {
  readonly harness: string;
  readonly supportsSessionContinuity = true;

  constructor(private readonly agent: ExecutionAgent) {
    this.harness = agent.name;
  }

  start(prompt: string, options?: { model?: string }): HarnessSessionCommand {
    const command = this.agent.buildCommand(prompt, { executionModel: options?.model });
    if (!command.sessionId) {
      throw new Error(`Harness "${this.agent.name}" did not return a session id.`);
    }
    return {
      command: command.cmd,
      args: command.args,
      sessionId: command.sessionId,
    };
  }

  append(sessionId: string, prompt: string, options?: { model?: string }): HarnessSessionCommand {
    const resumed = this.agent.buildResumeArgs(sessionId);
    return {
      command: resumed.cmd,
      args: this.appendPromptArgs(resumed.args, prompt, options?.model),
      sessionId,
    };
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
