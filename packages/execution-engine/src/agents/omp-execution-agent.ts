import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentCommandBuildOptions, AgentCommandSpec, ExecutionAgent, ExecutionModelOption } from '../agent.js';

export interface OmpExecutionAgentConfig {
  command?: string;
  configDir?: string;
  containerHomePath?: string;
}

const OMP_SUPPORTED_MODELS: readonly ExecutionModelOption[] = [
  { id: 'anthropic/claude-sonnet-4', label: 'Anthropic Claude Sonnet 4' },
  { id: 'anthropic/claude-opus-4', label: 'Anthropic Claude Opus 4' },
  { id: 'openai/gpt-5', label: 'OpenAI GPT-5' },
  { id: 'openai/gpt-5-codex', label: 'OpenAI GPT-5 Codex' },
  { id: 'openai/o3', label: 'OpenAI o3' },
];

export class OmpExecutionAgent implements ExecutionAgent {
  readonly name = 'omp';
  readonly stdinMode = 'ignore' as const;
  readonly linuxTerminalTail = 'exec_bash' as const;
  readonly bundledSkillRoot: string;
  readonly bundledSkills = ['make-pr'] as const;
  readonly supportedModels = OMP_SUPPORTED_MODELS;

  private readonly command: string;
  private readonly configDir: string;
  private readonly containerHomePath: string;

  constructor(config: OmpExecutionAgentConfig = {}) {
    this.command = config.command ?? process.env.INVOKER_OMP_COMMAND ?? 'omp';
    this.configDir = config.configDir ?? join(homedir(), '.omp', 'agent');
    this.containerHomePath = config.containerHomePath ?? '/home/invoker';
    this.bundledSkillRoot = join(this.configDir, 'skills');
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

  buildResumeArgs(_sessionId: string): { cmd: string; args: string[] } {
    return { cmd: this.command, args: ['--continue'] };
  }

  getContainerRequirements(): {
    mounts: Array<{ hostPath: string; containerPath: string; readonly?: boolean }>;
    env: Record<string, string>;
  } {
    return {
      mounts: [
        {
          hostPath: this.configDir,
          containerPath: join(this.containerHomePath, '.omp', 'agent'),
        },
      ],
      env: {},
    };
  }

  private buildArgs(prompt: string, executionModel?: string): string[] {
    return [
      '--no-title',
      '--auto-approve',
      ...(executionModel ? ['--model', executionModel] : []),
      '-p',
      prompt,
    ];
  }
}
