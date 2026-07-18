import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ExecutionAgent, AgentCommandSpec, AgentCommandBuildOptions, ExecutionModelOption } from '../agent.js';

export interface CodexExecutionAgentConfig {
  command?: string;
  fullAuto?: boolean;
  bypassApprovalsAndSandbox?: boolean;
}

const CODEX_MODEL_DISCOVERY_TIMEOUT_MS = 3_000;
const CODEX_MODEL_CACHE_MS = 5 * 60_000;

const CODEX_FALLBACK_MODELS: readonly ExecutionModelOption[] = [
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  { id: 'gpt-5.5-pro', label: 'GPT-5.5 Pro' },
  { id: 'gpt-5.4', label: 'GPT-5.4' },
  { id: 'gpt-5.4-pro', label: 'GPT-5.4 Pro' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
  { id: 'gpt-5.4-nano', label: 'GPT-5.4 Nano' },
  { id: 'gpt-5.3', label: 'GPT-5.3' },
  { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' },
  { id: 'gpt-5.2', label: 'GPT-5.2' },
  { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
  { id: 'gpt-5.1', label: 'GPT-5.1' },
  { id: 'gpt-5.1-codex', label: 'GPT-5.1 Codex' },
  { id: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max' },
  { id: 'gpt-5', label: 'GPT-5' },
  { id: 'gpt-5-codex', label: 'GPT-5 Codex' },
];

function normalizeCodexModelId(model: string): string {
  return model.trim().toLowerCase();
}

function parseDiscoveredCodexModels(stdout: string): ExecutionModelOption[] {
  try {
    const parsed = JSON.parse(stdout) as {
      models?: Array<{ slug?: string; display_name?: string }>;
    };
    const models: ExecutionModelOption[] = [];
    const seen = new Set<string>();
    for (const entry of parsed.models ?? []) {
      const id = entry.slug?.trim();
      const label = entry.display_name?.trim();
      if (!id || !label) continue;
      const key = normalizeCodexModelId(id);
      if (seen.has(key)) continue;
      seen.add(key);
      models.push({ id, label });
    }
    return models;
  } catch {
    return [];
  }
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
  private supportedModelCache?: { expiresAt: number; models: readonly ExecutionModelOption[] };

  constructor(config: CodexExecutionAgentConfig = {}) {
    this.command = config.command ?? 'codex';
    this.bypassApprovalsAndSandbox = config.bypassApprovalsAndSandbox ?? true;
    this.fullAuto = config.fullAuto ?? true;
    this.bundledSkillRoot = join(homedir(), '.codex', 'skills');
  }
  get supportedModels(): readonly ExecutionModelOption[] {
    return this.getSupportedModels();
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
  supportsModel(executionModel: string): boolean {
    const normalized = normalizeCodexModelId(executionModel);
    return this.getSupportedModels().some((candidate) => normalizeCodexModelId(candidate.id) === normalized);
  }
  private getSupportedModels(): readonly ExecutionModelOption[] {
    const cached = this.supportedModelCache;
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.models;
    }
    const discovered = this.discoverSupportedModels();
    const models = discovered.length > 0 ? discovered : CODEX_FALLBACK_MODELS;
    this.supportedModelCache = {
      expiresAt: now + CODEX_MODEL_CACHE_MS,
      models,
    };
    return models;
  }

  private discoverSupportedModels(): readonly ExecutionModelOption[] {
    const result = spawnSync(this.command, ['debug', 'models'], {
      encoding: 'utf8',
      timeout: CODEX_MODEL_DISCOVERY_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    if (result.error || result.status !== 0) {
      return [];
    }
    return parseDiscoveredCodexModels(result.stdout);
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
