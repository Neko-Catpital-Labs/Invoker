import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentCommandBuildOptions, AgentCommandSpec, ExecutionAgent, ExecutionModelOption } from '../agent.js';

export interface OmpExecutionAgentConfig {
  command?: string;
  configDir?: string;
  containerHomePath?: string;
  sessionDirRoot?: string;
}

const OMP_SUPPORTED_MODELS: readonly ExecutionModelOption[] = [
  { id: 'chatgpt-5.4', label: 'ChatGPT 5.4' },
  { id: 'anthropic/claude-sonnet-4', label: 'Anthropic Claude Sonnet 4' },
  { id: 'anthropic/claude-opus-4', label: 'Anthropic Claude Opus 4' },
  { id: 'openai/gpt-5', label: 'OpenAI GPT-5' },
  { id: 'openai/gpt-5-codex', label: 'OpenAI GPT-5 Codex' },
  { id: 'openai/o3', label: 'OpenAI o3' },
  { id: 'openrouter/~moonshotai/kimi-latest', label: 'OpenRouter Kimi Latest' },
  { id: 'vercel-ai-gateway/moonshotai/kimi-k2.5', label: 'Vercel Gateway Kimi K2.5' },
  { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
  { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  { id: 'qwen3-coder-480b-a35b-instruct', label: 'Qwen3 Coder 480B A35B' },
  { id: 'glm-5.2', label: 'GLM 5.2' },
  { id: 'glm-5.1', label: 'GLM 5.1' },
  { id: 'ollama/qwen2.5-coder:7b', label: 'Ollama Qwen2.5 Coder 7B' },
  { id: 'ollama/gpt-oss:20b', label: 'Ollama GPT-OSS 20B' },
];

const DEFAULT_SESSION_DIR_ROOT = '/tmp/invoker-omp-sessions';

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
  private readonly sessionDirRoot: string;

  constructor(config: OmpExecutionAgentConfig = {}) {
    this.command = config.command ?? process.env.INVOKER_OMP_COMMAND ?? 'omp';
    this.configDir = config.configDir ?? join(homedir(), '.omp', 'agent');
    this.containerHomePath = config.containerHomePath ?? '/home/invoker';
    this.bundledSkillRoot = join(this.configDir, 'skills');
    this.sessionDirRoot = config.sessionDirRoot ?? DEFAULT_SESSION_DIR_ROOT;
  }

  buildCommand(fullPrompt: string, options: AgentCommandBuildOptions = {}): AgentCommandSpec {
    const sessionId = randomUUID();
    return {
      cmd: this.command,
      args: this.buildArgs(fullPrompt, this.sessionDir(sessionId), options.executionModel),
      sessionId,
      fullPrompt,
    };
  }

  buildFixCommand(prompt: string, options: AgentCommandBuildOptions = {}): AgentCommandSpec {
    const sessionId = randomUUID();
    return {
      cmd: this.command,
      args: this.buildArgs(prompt, this.sessionDir(sessionId), options.executionModel),
      sessionId,
    };
  }
  supportsModel(_executionModel: string): boolean {
    return true;
  }

  buildResumeArgs(sessionId: string): { cmd: string; args: string[] } {
    return { cmd: this.command, args: ['--session-dir', this.sessionDir(sessionId), '--continue'] };
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

  private sessionDir(sessionId: string): string {
    return join(this.sessionDirRoot, sessionId);
  }

  private buildArgs(prompt: string, sessionDir: string, executionModel?: string): string[] {
    return [
      '--no-title',
      '--auto-approve',
      '--session-dir',
      sessionDir,
      ...(executionModel ? ['--model', executionModel] : []),
      '-p',
      prompt,
    ];
  }
}
