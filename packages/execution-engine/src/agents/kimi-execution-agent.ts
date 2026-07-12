import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentCommandBuildOptions, AgentCommandSpec, ExecutionAgent, ExecutionModelOption } from '../agent.js';

export interface KimiExecutionAgentConfig {
  command?: string;
  configDir?: string;
  containerHomePath?: string;
}

const KIMI_SUPPORTED_MODELS: readonly ExecutionModelOption[] = [
  { id: 'kimi-k2.6', label: 'Kimi K2.6' },
  { id: 'kimi-k2.5', label: 'Kimi K2.5' },
  { id: 'kimi-k2', label: 'Kimi K2' },
  { id: 'moonshot-v1-128k', label: 'Moonshot v1 128K' },
  { id: 'moonshot-v1-32k', label: 'Moonshot v1 32K' },
  { id: 'moonshot-v1-8k', label: 'Moonshot v1 8K' },
];

export class KimiExecutionAgent implements ExecutionAgent {
  readonly name = 'kimi';
  readonly stdinMode = 'ignore' as const;
  readonly linuxTerminalTail = 'exec_bash' as const;
  readonly supportedModels = KIMI_SUPPORTED_MODELS;

  private readonly command: string;
  private readonly configDir: string;
  private readonly containerHomePath: string;

  constructor(config: KimiExecutionAgentConfig = {}) {
    this.command = config.command ?? process.env.INVOKER_KIMI_COMMAND ?? 'kimi';
    this.configDir = config.configDir ?? join(homedir(), '.kimi-code');
    this.containerHomePath = config.containerHomePath ?? '/home/invoker';
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
    const normalized = executionModel.trim().toLowerCase();
    return normalized.includes('kimi') || normalized.includes('moonshot');
  }

  buildResumeArgs(sessionId: string): { cmd: string; args: string[] } {
    return { cmd: this.command, args: ['--session', sessionId] };
  }

  getContainerRequirements(): {
    mounts: Array<{ hostPath: string; containerPath: string; readonly?: boolean }>;
    env: Record<string, string>;
  } {
    return {
      mounts: [
        {
          hostPath: this.configDir,
          containerPath: join(this.containerHomePath, '.kimi-code'),
        },
      ],
      env: {},
    };
  }

  private buildArgs(prompt: string, executionModel?: string): string[] {
    // Kimi's `-p` prompt mode runs non-interactively and auto-approves tool
    // use on its own. The kimi CLI rejects combining `--prompt` with an
    // approval flag (`--yolo`, `--auto`, `--plan`) — it exits with
    // "Cannot combine --prompt with --yolo." — so we pass no approval flag.
    return [
      ...(executionModel ? ['--model', executionModel] : []),
      '-p',
      prompt,
    ];
  }
}
