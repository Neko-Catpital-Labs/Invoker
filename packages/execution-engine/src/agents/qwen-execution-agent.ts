import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentCommandBuildOptions, AgentCommandSpec, ExecutionAgent, ExecutionModelOption } from '../agent.js';

export interface QwenExecutionAgentConfig {
  command?: string;
  configDir?: string;
  containerHomePath?: string;
  approvalMode?: 'default' | 'auto-edit' | 'auto' | 'yolo';
  authType?: 'openai' | 'anthropic' | 'qwen-oauth' | 'gemini' | 'vertex-ai';
}

const QWEN_SUPPORTED_MODELS: readonly ExecutionModelOption[] = [
  { id: 'qwen-coder-plus', label: 'Qwen Coder Plus' },
  { id: 'qwen-coder-flash', label: 'Qwen Coder Flash' },
  { id: 'qwen3-coder-plus', label: 'Qwen3 Coder Plus' },
  { id: 'qwen3-coder-flash', label: 'Qwen3 Coder Flash' },
  { id: 'qwen3-coder-480b-a35b-instruct', label: 'Qwen3 Coder 480B A35B' },
  { id: 'qwen3-235b-a22b', label: 'Qwen3 235B A22B' },
  { id: 'coder-model', label: 'Qwen Coding Plan Default' },
];

export class QwenExecutionAgent implements ExecutionAgent {
  readonly name = 'qwen';
  readonly stdinMode = 'ignore' as const;
  readonly linuxTerminalTail = 'exec_bash' as const;
  readonly supportedModels = QWEN_SUPPORTED_MODELS;

  private readonly command: string;
  private readonly configDir: string;
  private readonly containerHomePath: string;
  private readonly approvalMode: 'default' | 'auto-edit' | 'auto' | 'yolo';
  private readonly authType?: 'openai' | 'anthropic' | 'qwen-oauth' | 'gemini' | 'vertex-ai';

  constructor(config: QwenExecutionAgentConfig = {}) {
    this.command = config.command ?? process.env.INVOKER_QWEN_COMMAND ?? 'qwen';
    this.configDir = config.configDir ?? join(homedir(), '.qwen');
    this.containerHomePath = config.containerHomePath ?? '/home/invoker';
    this.approvalMode = config.approvalMode ?? 'yolo';
    this.authType = config.authType ?? parseQwenAuthType(process.env.INVOKER_QWEN_AUTH_TYPE);
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
    return executionModel.trim().toLowerCase().includes('qwen');
  }

  buildResumeArgs(sessionId: string): { cmd: string; args: string[] } {
    return { cmd: this.command, args: ['--resume', sessionId] };
  }

  getContainerRequirements(): {
    mounts: Array<{ hostPath: string; containerPath: string; readonly?: boolean }>;
    env: Record<string, string>;
  } {
    return {
      mounts: [
        {
          hostPath: this.configDir,
          containerPath: join(this.containerHomePath, '.qwen'),
        },
      ],
      env: {},
    };
  }

  private buildArgs(prompt: string, executionModel?: string): string[] {
    return [
      '--approval-mode',
      this.approvalMode,
      ...(this.authType ? ['--auth-type', this.authType] : []),
      ...(executionModel ? ['--model', executionModel] : []),
      '--prompt',
      prompt,
    ];
  }
}

function parseQwenAuthType(value: string | undefined): QwenExecutionAgentConfig['authType'] {
  if (
    value === 'openai'
    || value === 'anthropic'
    || value === 'qwen-oauth'
    || value === 'gemini'
    || value === 'vertex-ai'
  ) {
    return value;
  }
  return undefined;
}
