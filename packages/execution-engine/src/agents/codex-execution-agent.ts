import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type {
  ExecutionAgent,
  AgentCommandSpec,
  AgentCommandBuildOptions,
  ExecutionModelOption,
  SupportedModelsProvenance,
} from '../agent.js';
import { createCodexSpendGateReader, type CodexSpendGateReader } from '../codex-spend-gate.js';

export interface CodexExecutionAgentConfig {
  command?: string;
  fullAuto?: boolean;
  bypassApprovalsAndSandbox?: boolean;
  spendGate?: CodexSpendGateReader;
}

const CODEX_MODEL_DISCOVERY_TIMEOUT_MS = 3_000;
const CODEX_MODEL_CACHE_MS = 5 * 60_000;

type CodexModelDiscoveryResult =
  | { kind: 'success'; models: readonly ExecutionModelOption[] }
  | { kind: 'failed'; reason: string };

function normalizeCodexModelId(model: string): string {
  return model.trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDiscoveredCodexModels(stdout: string): CodexModelDiscoveryResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { kind: 'failed', reason: 'invalid JSON' };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.models)) {
    return { kind: 'failed', reason: 'expected a models array' };
  }
  const models: ExecutionModelOption[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of parsed.models.entries()) {
    if (!isRecord(entry)
      || typeof entry.slug !== 'string' || !entry.slug.trim()
      || typeof entry.display_name !== 'string' || !entry.display_name.trim()) {
      return { kind: 'failed', reason: `models[${index}] requires non-empty slug and display_name strings` };
    }
    const id = entry.slug.trim();
    const label = entry.display_name.trim();
    const key = normalizeCodexModelId(id);
    if (seen.has(key)) continue;
    seen.add(key);
    models.push({ id, label });
  }
  return { kind: 'success', models };
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
  private readonly spendGate: CodexSpendGateReader;
  private supportedModelCache?: {
    expiresAt: number;
    models: readonly ExecutionModelOption[];
    provenance: SupportedModelsProvenance;
  };

  constructor(config: CodexExecutionAgentConfig = {}) {
    this.command = config.command ?? 'codex';
    this.bypassApprovalsAndSandbox = config.bypassApprovalsAndSandbox ?? true;
    this.fullAuto = config.fullAuto ?? true;
    this.spendGate = config.spendGate ?? createCodexSpendGateReader();
    this.bundledSkillRoot = join(homedir(), '.codex', 'skills');
  }
  get supportedModels(): readonly ExecutionModelOption[] {
    return this.getSupportedModels();
  }
  get supportedModelsProvenance(): SupportedModelsProvenance {
    this.getSupportedModels();
    return this.supportedModelCache!.provenance;
  }


  buildCommand(fullPrompt: string, options: AgentCommandBuildOptions = {}): AgentCommandSpec {
    this.spendGate.assertOpen();
    const sessionId = randomUUID();
    const args = ['exec', '--json'];
    if (this.bypassApprovalsAndSandbox) args.push(...this.buildBypassArgs());
    else if (this.fullAuto) args.push('--sandbox', 'workspace-write');
    args.push(...this.buildModelArgs(options.executionModel), fullPrompt);
    return { cmd: this.command, args, sessionId, fullPrompt };
  }

  buildResumeArgs(sessionId: string): { cmd: string; args: string[] } {
    this.spendGate.assertOpen();
    return {
      cmd: this.command,
      args: ['resume', ...this.buildBypassArgs(), sessionId],
    };
  }

  buildFixCommand(prompt: string, options: AgentCommandBuildOptions = {}): AgentCommandSpec {
    this.spendGate.assertOpen();
    const sessionId = randomUUID();
    const args = ['exec', '--json'];
    if (this.bypassApprovalsAndSandbox) args.push(...this.buildBypassArgs());
    else if (this.fullAuto) args.push('--sandbox', 'workspace-write');
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
    const models = this.discoverSupportedModels();
    this.supportedModelCache = {
      expiresAt: now + CODEX_MODEL_CACHE_MS,
      models,
      provenance: 'agent',
    };
    return models;
  }

  private discoverSupportedModels(): readonly ExecutionModelOption[] {
    const failures: string[] = [];
    for (const source of ['live', 'bundled'] as const) {
      const args = source === 'live' ? ['debug', 'models'] : ['debug', 'models', '--bundled'];
      const result = spawnSync(this.command, args, {
        encoding: 'utf8',
        timeout: CODEX_MODEL_DISCOVERY_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      });
      if (result.error || result.status !== 0) {
        const code = result.error && 'code' in result.error && typeof result.error.code === 'string'
          ? result.error.code.slice(0, 80) : result.error ? 'unknown' : 'none';
        failures.push(`${source} (${args.join(' ')}): status=${result.status}, error=${code}, signal=${result.signal}`);
        continue;
      }
      const parsed = parseDiscoveredCodexModels(result.stdout);
      if (parsed.kind === 'success') return parsed.models;
      failures.push(`${source} (${args.join(' ')}): ${parsed.reason}`);
    }
    throw new Error(`Codex model discovery unavailable: ${failures.join('; ')}`);
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
