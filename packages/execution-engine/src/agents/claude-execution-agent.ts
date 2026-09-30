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

const WORKER_HOOKS_FILE = join('.invoker', 'claude-worker-hooks.json');
const WORKER_HOOKS_ENV = 'INVOKER_CLAUDE_WORKER_HOOKS';

function normalizeClaudeModel(executionModel: string): string {
  return executionModel.trim().toLowerCase().replace(/^anthropic[/:]/, '');
}

/** Dedicated Invoker worker Claude config dir (never interactive ~/.claude). */
export function resolveClaudeWorkerConfigDir(): string {
  const override = process.env.INVOKER_CLAUDE_CONFIG_DIR?.trim();
  if (override) return override;
  return join(homedir(), '.invoker', 'claude-worker');
}

type ClaudeHookCommand = {
  type?: string;
  command?: string;
  timeout?: number;
  [key: string]: unknown;
};

type ClaudeHookEntry = {
  matcher?: string;
  hooks?: ClaudeHookCommand[];
  [key: string]: unknown;
};

type ClaudeSettings = {
  enabledPlugins?: Record<string, unknown>;
  hooks?: Record<string, ClaudeHookEntry[]>;
  [key: string]: unknown;
};

function normalizeMarkers(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const marker = item.trim().replace(/\/+$/, '');
    if (marker) out.push(marker);
  }
  return out;
}

/** Markers from env override, else ~/.invoker/claude-worker-hooks.json. Empty means copy nothing. */
export function resolveWorkerHookMarkers(
  interactiveHome: string = homedir(),
  environ: NodeJS.ProcessEnv = process.env,
): string[] {
  const envRaw = environ[WORKER_HOOKS_ENV];
  if (typeof envRaw === 'string' && envRaw.trim() !== '') {
    return normalizeMarkers(envRaw.split(','));
  }
  const path = join(interactiveHome, WORKER_HOOKS_FILE);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return normalizeMarkers((parsed as { hooks?: unknown }).hooks);
  } catch {
    return [];
  }
}

function entryMatchesMarkers(entry: ClaudeHookEntry, markers: string[]): boolean {
  if (markers.length === 0) return false;
  const hooks = entry.hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((hook) => {
    if (typeof hook?.command !== 'string') return false;
    return markers.some((marker) => hook.command!.includes(`${marker}/`));
  });
}

/**
 * Copy allowlisted hook entries from interactive Claude settings into worker
 * settings. Markers are path segments such as "poll-hook". Every other
 * interactive hook stays out. Worker enabledPlugins and non-matching hooks
 * are preserved.
 */
export function mergeAllowedWorkerHooks(
  interactive: ClaudeSettings,
  worker: ClaudeSettings,
  markers: string[],
): ClaudeSettings {
  const result: ClaudeSettings = structuredClone(worker);
  if (markers.length === 0) return result;

  const interactiveHooks = interactive.hooks;
  if (!interactiveHooks || typeof interactiveHooks !== 'object') {
    return result;
  }

  const workerHooks: Record<string, ClaudeHookEntry[]> = { ...(result.hooks ?? {}) };

  for (const [event, entries] of Object.entries(interactiveHooks)) {
    if (!Array.isArray(entries)) continue;
    const selected = entries.filter((entry) => entryMatchesMarkers(entry, markers));
    const existing = Array.isArray(workerHooks[event]) ? workerHooks[event] : [];
    const kept = existing.filter((entry) => !entryMatchesMarkers(entry, markers));
    if (selected.length === 0) {
      if (kept.length !== existing.length) workerHooks[event] = kept;
      continue;
    }
    workerHooks[event] = [...kept, ...structuredClone(selected)];
  }

  // Also strip allowlisted entries from worker events that interactive lacks.
  for (const [event, entries] of Object.entries(workerHooks)) {
    if (!Array.isArray(entries)) continue;
    if (Array.isArray(interactiveHooks[event])) continue;
    workerHooks[event] = entries.filter((entry) => !entryMatchesMarkers(entry, markers));
  }

  result.hooks = workerHooks;
  return result;
}

function readJsonObject(path: string): ClaudeSettings | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return raw as ClaudeSettings;
  } catch {
    return null;
  }
}

/**
 * Ensure worker config exists with credentials only and empty plugins.
 * Copies allowlisted hook entries from interactive ~/.claude/settings.json.
 * Does not rewrite interactive ~/.claude or ~/.claude.json.
 */
export function ensureClaudeWorkerConfigDir(
  configDir: string,
  options: { interactiveHome?: string } = {},
): void {
  try {
    mkdirSync(configDir, { recursive: true });
  } catch {
    return;
  }
  const interactiveHome = options.interactiveHome ?? homedir();
  const workerJson = join(configDir, '.claude.json');
  const interactiveJson = join(interactiveHome, '.claude.json');
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
  let workerSettings: ClaudeSettings = { enabledPlugins: {} };
  if (existsSync(settingsPath)) {
    workerSettings = readJsonObject(settingsPath) ?? { enabledPlugins: {} };
  }

  const markers = resolveWorkerHookMarkers(interactiveHome);
  const interactiveSettingsPath = join(interactiveHome, '.claude', 'settings.json');
  if (markers.length > 0 && existsSync(interactiveSettingsPath)) {
    const interactiveSettings = readJsonObject(interactiveSettingsPath);
    if (interactiveSettings) {
      workerSettings = mergeAllowedWorkerHooks(interactiveSettings, workerSettings, markers);
    }
  }

  if (!('enabledPlugins' in workerSettings)) {
    workerSettings.enabledPlugins = {};
  }
  writeFileSync(settingsPath, `${JSON.stringify(workerSettings, null, 2)}\n`);
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
    const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
    return {
      mounts: [
        { hostPath: this.configDir, containerPath: containerClaudeDir },
      ],
      env: {
        ANTHROPIC_API_KEY: this.apiKey,
        CLAUDE_CONFIG_DIR: this.configDir,
        ...(oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: oauthToken } : {}),
      },
    };
  }
}
