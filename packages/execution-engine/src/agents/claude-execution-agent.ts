import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ExecutionAgent, AgentCommandSpec, AgentCommandBuildOptions, ExecutionModelOption } from '../agent.js';

export interface ClaudeExecutionAgentConfig {
  command?: string;
  fixCommand?: string;
  configDir?: string;
  containerHomePath?: string;
  apiKey?: string;
}

const CLAUDE_SUPPORTED_MODELS: readonly ExecutionModelOption[] = [
  { id: 'sonnet', label: 'Claude Sonnet' },
  { id: 'opus', label: 'Claude Opus' },
  { id: 'haiku', label: 'Claude Haiku' },
];

function normalizeClaudeModel(executionModel: string): string {
  return executionModel.trim().toLowerCase().replace(/^anthropic[/:]/, '');
}

export class ClaudeExecutionAgent implements ExecutionAgent {
  readonly name = 'claude';
  readonly stdinMode = 'ignore' as const;
  readonly linuxTerminalTail = 'exec_bash' as const;
  readonly bundledSkillRoot: string;
  readonly bundledSkills = ['make-pr'] as const;
  readonly supportedModels = CLAUDE_SUPPORTED_MODELS;

  private readonly command: string;
  private readonly fixCommand: string;
  private readonly configDir: string;
  private readonly containerHomePath: string;
  private readonly apiKey: string;

  constructor(config: ClaudeExecutionAgentConfig = {}) {
    this.command = config.command ?? process.env.INVOKER_CLAUDE_COMMAND ?? 'claude';
    this.fixCommand = config.fixCommand ?? process.env.INVOKER_CLAUDE_FIX_COMMAND ?? this.command;
    this.configDir = config.configDir ?? join(homedir(), '.claude');
    this.containerHomePath = config.containerHomePath ?? '/home/invoker';
    this.apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
    this.bundledSkillRoot = join(this.configDir, 'skills');
  }

  buildCommand(fullPrompt: string, options: AgentCommandBuildOptions = {}): AgentCommandSpec {
    const sessionId = randomUUID();
    return {
      cmd: this.command,
      args: ['--session-id', sessionId, '--dangerously-skip-permissions', ...this.buildModelArgs(options.executionModel), '-p', fullPrompt],
      sessionId,
      fullPrompt,
    };
  }

  buildFixCommand(prompt: string, options: AgentCommandBuildOptions = {}): AgentCommandSpec {
    const sessionId = randomUUID();
    return {
      cmd: this.fixCommand,
      args: ['--session-id', sessionId, ...this.buildModelArgs(options.executionModel), '-p', prompt, '--dangerously-skip-permissions'],
      sessionId,
    };
  }
  supportsModel(executionModel: string): boolean {
    const normalized = normalizeClaudeModel(executionModel);
    return normalized === 'sonnet'
      || normalized === 'opus'
      || normalized === 'haiku'
      || /^claude-(sonnet|opus|haiku)(?:-|$)/.test(normalized);
  }

  private buildModelArgs(executionModel?: string): string[] {
    return executionModel ? ['--model', executionModel] : [];
  }

  buildResumeArgs(sessionId: string): { cmd: string; args: string[] } {
    return {
      cmd: this.command,
      args: ['--resume', sessionId, '--dangerously-skip-permissions'],
    };
  }

  getContainerRequirements(): {
    mounts: Array<{ hostPath: string; containerPath: string; readonly?: boolean }>;
    env: Record<string, string>;
  } {
    const containerClaudeDir = join(this.containerHomePath, '.claude');
    const mounts: Array<{ hostPath: string; containerPath: string; readonly?: boolean }> = [
      { hostPath: this.configDir, containerPath: containerClaudeDir },
    ];

    const claudeJsonPath = join(homedir(), '.claude.json');
    mounts.push({
      hostPath: claudeJsonPath,
      containerPath: join(containerClaudeDir, '.claude.json'),
      readonly: true,
    });

    return {
      mounts,
      env: {
        ANTHROPIC_API_KEY: this.apiKey,
      },
    };
  }
}
