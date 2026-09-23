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
const CODEX_DISCOVERY_DETAIL_MAX_CHARS = 120;

const CODEX_DISCOVERY_ATTEMPTS = [
  { attempt: 'live' as const, args: ['debug', 'models'] },
  { attempt: 'bundled' as const, args: ['debug', 'models', '--bundled'] },
];

type CodexDiscoveryAttempt = (typeof CODEX_DISCOVERY_ATTEMPTS)[number]['attempt'];

interface CodexModelProbeFailure {
  attempt: CodexDiscoveryAttempt;
  detail: string;
}

type CodexModelDiscoveryResult =
  | { kind: 'success'; models: readonly ExecutionModelOption[] }
  | { kind: 'failed'; failures: readonly CodexModelProbeFailure[] };

type CodexCatalogParse =
  | { kind: 'ok'; models: ExecutionModelOption[] }
  | { kind: 'invalid'; reason: string };

export class CodexModelDiscoveryUnavailableError extends Error {
  readonly failures: readonly CodexModelProbeFailure[];

  constructor(command: string, failures: readonly CodexModelProbeFailure[]) {
    const diagnostics = failures.map((failure) => `${failure.attempt} probe ${failure.detail}`).join('; ');
    super(`Codex model discovery via "${boundDetail(command)}" is unavailable: ${diagnostics}.`);
    this.name = 'CodexModelDiscoveryUnavailableError';
    this.failures = failures;
  }
}

function boundDetail(text: string): string {
  const collapsed = text.trim().replace(/\s+/g, ' ');
  return collapsed.length > CODEX_DISCOVERY_DETAIL_MAX_CHARS
    ? `${collapsed.slice(0, CODEX_DISCOVERY_DETAIL_MAX_CHARS)}...`
    : collapsed;
}

function describeProbeFailure(result: ReturnType<typeof spawnSync>): string {
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return boundDetail(`failed to run (${code ?? result.error.message})`);
  }
  if (result.signal) return boundDetail(`was terminated by ${result.signal}`);
  return boundDetail(`exited with status ${result.status}`);
}

function normalizeCodexModelId(model: string): string {
  return model.trim().toLowerCase();
}

function parseCodexCatalog(stdout: string): CodexCatalogParse {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    return { kind: 'invalid', reason: 'output was not valid JSON' };
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { kind: 'invalid', reason: 'output was not a JSON object' };
  }
  const rawModels = (payload as { models?: unknown }).models;
  if (rawModels === undefined) return { kind: 'invalid', reason: 'output had no models field' };
  if (!Array.isArray(rawModels)) return { kind: 'invalid', reason: 'models was not an array' };

  const models: ExecutionModelOption[] = [];
  const seen = new Set<string>();
  for (const entry of rawModels) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { kind: 'invalid', reason: 'a models entry was not an object' };
    }
    const { slug, display_name: displayName } = entry as { slug?: unknown; display_name?: unknown };
    if (typeof slug !== 'string' || typeof displayName !== 'string') {
      return { kind: 'invalid', reason: 'a models entry lacked a string slug and display_name' };
    }
    const id = slug.trim();
    const label = displayName.trim();
    if (!id || !label) return { kind: 'invalid', reason: 'a models entry had a blank slug or display_name' };
    const key = normalizeCodexModelId(id);
    if (seen.has(key)) continue;
    seen.add(key);
    models.push({ id, label });
  }
  return { kind: 'ok', models };
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
  private discoveryFailureCache?: {
    expiresAt: number;
    failures: readonly CodexModelProbeFailure[];
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
    const cachedFailure = this.discoveryFailureCache;
    if (cachedFailure && cachedFailure.expiresAt > now) {
      throw new CodexModelDiscoveryUnavailableError(this.command, cachedFailure.failures);
    }
    const discovered = this.discoverSupportedModels();
    if (discovered.kind === 'failed') {
      this.discoveryFailureCache = {
        expiresAt: now + CODEX_MODEL_CACHE_MS,
        failures: discovered.failures,
      };
      throw new CodexModelDiscoveryUnavailableError(this.command, discovered.failures);
    }
    this.discoveryFailureCache = undefined;
    this.supportedModelCache = {
      expiresAt: now + CODEX_MODEL_CACHE_MS,
      models: discovered.models,
      provenance: 'agent',
    };
    return discovered.models;
  }

  private discoverSupportedModels(): CodexModelDiscoveryResult {
    const failures: CodexModelProbeFailure[] = [];
    for (const { attempt, args } of CODEX_DISCOVERY_ATTEMPTS) {
      const result = spawnSync(this.command, args, {
        encoding: 'utf8',
        timeout: CODEX_MODEL_DISCOVERY_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      });
      if (result.error || result.status !== 0) {
        failures.push({ attempt, detail: describeProbeFailure(result) });
        continue;
      }
      const parsed = parseCodexCatalog(result.stdout ?? '');
      if (parsed.kind === 'invalid') {
        failures.push({ attempt, detail: boundDetail(`returned unusable catalog output (${parsed.reason})`) });
        continue;
      }
      return { kind: 'success', models: parsed.models };
    }
    return { kind: 'failed', failures };
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
