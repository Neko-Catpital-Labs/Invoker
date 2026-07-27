import { randomUUID } from 'node:crypto';
import type { AgentCommandBuildOptions, AgentCommandSpec, ExecutionAgent, ExecutionModelOption } from '../agent.js';

export interface CursorExecutionAgentConfig {
  command?: string;
}

const CURSOR_SUPPORTED_MODELS: readonly ExecutionModelOption[] = [
  { id: 'grok-4.5', label: 'Grok 4.5' },
];

export class CursorExecutionAgent implements ExecutionAgent {
  readonly name = 'cursor';
  readonly stdinMode = 'ignore' as const;
  readonly linuxTerminalTail = 'exec_bash' as const;
  readonly supportedModels = CURSOR_SUPPORTED_MODELS;

  private readonly command: string;

  constructor(config: CursorExecutionAgentConfig = {}) {
    this.command = config.command ?? process.env.INVOKER_CURSOR_COMMAND ?? 'cursor';
  }

  buildCommand(fullPrompt: string, options: AgentCommandBuildOptions = {}): AgentCommandSpec {
    const sessionId = randomUUID();
    return {
      cmd: this.command,
      args: this.buildArgs(fullPrompt, options.executionModel),
      sessionId,
      fullPrompt,
    };
  }

  buildFixCommand(prompt: string, options: AgentCommandBuildOptions = {}): AgentCommandSpec {
    const sessionId = randomUUID();
    return {
      cmd: this.command,
      args: this.buildArgs(prompt, options.executionModel),
      sessionId,
    };
  }

  supportsModel(executionModel: string): boolean {
    return executionModel.trim().toLowerCase() === 'grok-4.5';
  }

  buildResumeArgs(sessionId: string): { cmd: string; args: string[] } {
    return { cmd: this.command, args: ['agent', '--resume', sessionId] };
  }

  private buildArgs(prompt: string, executionModel?: string): string[] {
    return [
      'agent',
      '--print',
      '--trust',
      ...(executionModel ? ['--model', executionModel] : []),
      prompt,
    ];
  }
}
