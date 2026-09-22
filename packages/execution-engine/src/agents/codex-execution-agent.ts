import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
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
const CODEX_DIAGNOSTIC_DETAIL_LIMIT = 120;

type CodexCatalogSource = 'live' | 'bundled';

interface CodexCatalogAttempt {
  source: CodexCatalogSource;
  detail: string;
}

type CodexModelDiscoveryResult =
  | { kind: 'success'; source: CodexCatalogSource; models: readonly ExecutionModelOption[] }
  | { kind: 'unavailable'; attempts: readonly CodexCatalogAttempt[] };

type CodexCatalogProbeResult =
  | { kind: 'success'; models: readonly ExecutionModelOption[] }
  | { kind: 'failed'; detail: string };

type CodexCatalogParseResult =
  | { ok: true; models: ExecutionModelOption[] }
  | { ok: false; reason: string };

function normalizeCodexModelId(model: string): string {
  return model.trim().toLowerCase();
}

function parseCodexCatalog(stdout: string): CodexCatalogParseResult {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: 'output was not valid JSON' };
  }
  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, reason: 'output was not a JSON object' };
  }
  const entries = (payload as { models?: unknown }).models;
  if (!Array.isArray(entries)) {
    return { ok: false, reason: 'output had no models array' };
  }
  const models: ExecutionModelOption[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) {
      return { ok: false, reason: 'a catalog entry was not an object' };
    }
    const { slug, display_name: displayName } = entry as { slug?: unknown; display_name?: unknown };
    if (typeof slug !== 'string' || typeof displayName !== 'string') {
      return { ok: false, reason: 'a catalog entry was missing a string slug or display_name' };
    }
    const id = slug.trim();
    const label = displayName.trim();
    if (!id || !label) {
      return { ok: false, reason: 'a catalog entry had an empty slug or display_name' };
    }
    const key = normalizeCodexModelId(id);
    if (seen.has(key)) continue;
    seen.add(key);
    models.push({ id, label });
  }
  return { ok: true, models };
}

function boundDetail(detail: string): string {
  return detail.length > CODEX_DIAGNOSTIC_DETAIL_LIMIT
    ? `${detail.slice(0, CODEX_DIAGNOSTIC_DETAIL_LIMIT)}...`
    : detail;
}

function describeProbeFailure(result: SpawnSyncReturns<string>): string | undefined {
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return code ? `spawn error ${code}` : 'spawn error';
  }
  if (result.status !== 0) {
    return result.signal ? `terminated by signal ${result.signal}` : `exit status ${result.status}`;
  }
  return undefined;
}

function catalogProbeArgs(source: CodexCatalogSource): string[] {
  return source === 'bundled' ? ['debug', 'models', '--bundled'] : ['debug', 'models'];
}

function describeDiscoveryUnavailable(
  executionModel: string,
  attempts: readonly CodexCatalogAttempt[],
): string {
  const probes = attempts.map((attempt) => `${attempt.source}: ${attempt.detail}`).join('; ');
  return `Codex model discovery is unavailable, so execution model "${executionModel}" could not be verified. Probes: ${probes}.`;
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
    discovered: CodexModelDiscoveryResult;
  };

  constructor(config: CodexExecutionAgentConfig = {}) {
    this.command = config.command ?? 'codex';
    this.bypassApprovalsAndSandbox = config.bypassApprovalsAndSandbox ?? true;
    this.fullAuto = config.fullAuto ?? true;
    this.spendGate = config.spendGate ?? createCodexSpendGateReader();
    this.bundledSkillRoot = join(homedir(), '.codex', 'skills');
  }
  get supportedModels(): readonly ExecutionModelOption[] {
    const discovered = this.getDiscoveredModels();
    return discovered.kind === 'success' ? discovered.models : [];
  }
  get supportedModelsProvenance(): SupportedModelsProvenance {
    return this.getDiscoveredModels().kind === 'success' ? 'agent' : 'built-in';
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
    const discovered = this.getDiscoveredModels();
    if (discovered.kind === 'unavailable') {
      throw new Error(describeDiscoveryUnavailable(executionModel.trim(), discovered.attempts));
    }
    const normalized = normalizeCodexModelId(executionModel);
    return discovered.models.some((candidate) => normalizeCodexModelId(candidate.id) === normalized);
  }
  private getDiscoveredModels(): CodexModelDiscoveryResult {
    const cached = this.supportedModelCache;
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.discovered;
    }
    const discovered = this.discoverSupportedModels();
    this.supportedModelCache = { expiresAt: now + CODEX_MODEL_CACHE_MS, discovered };
    return discovered;
  }

  private discoverSupportedModels(): CodexModelDiscoveryResult {
    const attempts: CodexCatalogAttempt[] = [];
    for (const source of ['live', 'bundled'] as const) {
      const probe = this.probeCodexCatalog(source);
      if (probe.kind === 'success') {
        return { kind: 'success', source, models: probe.models };
      }
      attempts.push({ source, detail: probe.detail });
    }
    return { kind: 'unavailable', attempts };
  }

  private probeCodexCatalog(source: CodexCatalogSource): CodexCatalogProbeResult {
    const result = spawnSync(this.command, catalogProbeArgs(source), {
      encoding: 'utf8',
      timeout: CODEX_MODEL_DISCOVERY_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    const failure = describeProbeFailure(result);
    if (failure) {
      return { kind: 'failed', detail: boundDetail(failure) };
    }
    const parsed = parseCodexCatalog(result.stdout ?? '');
    if (!parsed.ok) {
      return { kind: 'failed', detail: boundDetail(`invalid catalog ${parsed.reason}`) };
    }
    return { kind: 'success', models: parsed.models };
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
