import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/** Dedicated Invoker worker Claude config dir (never interactive ~/.claude). */
export function resolveClaudeWorkerConfigDir(): string {
  const override = process.env.INVOKER_CLAUDE_CONFIG_DIR?.trim();
  if (override) return override;
  return join(homedir(), '.invoker', 'claude-worker');
}

/**
 * Ensure worker config exists with credentials only and empty plugins.
 * Does not rewrite interactive ~/.claude or ~/.claude.json.
 */
export function ensureClaudeWorkerConfigDir(configDir: string): void {
  try {
    mkdirSync(configDir, { recursive: true });
  } catch {
    return;
  }
  const workerJson = join(configDir, '.claude.json');
  const interactiveJson = join(homedir(), '.claude.json');
  if (!existsSync(workerJson) && existsSync(interactiveJson)) {
    try {
      const raw = JSON.parse(readFileSync(interactiveJson, 'utf8')) as Record<string, unknown>;
      const seeded: Record<string, unknown> = {};
      for (const key of ['oauthAccount', 'primaryApiKey', 'hasCompletedOnboarding', 'userID', 'numStartups']) {
        if (key in raw) seeded[key] = raw[key];
      }
      seeded.enabledPlugins = {};
      writeFileSync(workerJson, `${JSON.stringify(seeded, null, 2)}\n`);
    } catch {
      copyFileSync(interactiveJson, workerJson);
    }
  }
  const settingsPath = join(configDir, 'settings.json');
  if (!existsSync(settingsPath)) {
    writeFileSync(settingsPath, `${JSON.stringify({ enabledPlugins: {} }, null, 2)}\n`);
  }
}

function maxTurnsArgs(maxTurns: number | undefined): string[] {
  if (typeof maxTurns === 'number' && Number.isFinite(maxTurns) && maxTurns > 0) {
    return ['--max-turns', String(maxTurns)];
  }
  return [];
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
    this.configDir = config.configDir ?? resolveClaudeWorkerConfigDir();
    this.containerHomePath = config.containerHomePath ?? '/home/invoker';
    this.apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
    this.bundledSkillRoot = join(this.configDir, 'skills');
    ensureClaudeWorkerConfigDir(this.configDir);
  }

  buildCommand(fullPrompt: string, options: AgentCommandBuildOptions = {}): AgentCommandSpec {
    const sessionId = randomUUID();
    return {
      cmd: this.command,
      args: [
        '--session-id', sessionId,
        '--dangerously-skip-permissions',
        ...this.buildModelArgs(options.executionModel),
        ...maxTurnsArgs(options.maxTurns),
        '-p', fullPrompt,
      ],
      sessionId,
      fullPrompt,
    };
  }

  buildFixCommand(prompt: string, options: AgentCommandBuildOptions = {}): AgentCommandSpec {
    const sessionId = randomUUID();
    return {
      cmd: this.fixCommand,
      args: [
        '--session-id', sessionId,
        ...this.buildModelArgs(options.executionModel),
        ...maxTurnsArgs(options.maxTurns),
        '-p', prompt,
        '--dangerously-skip-permissions',
      ],
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
    ensureClaudeWorkerConfigDir(this.configDir);
    const containerClaudeDir = join(this.containerHomePath, '.claude');
    return {
      mounts: [
        { hostPath: this.configDir, containerPath: containerClaudeDir },
      ],
      env: {
        ANTHROPIC_API_KEY: this.apiKey,
        CLAUDE_CONFIG_DIR: this.configDir,
      },
    };
  }
}
