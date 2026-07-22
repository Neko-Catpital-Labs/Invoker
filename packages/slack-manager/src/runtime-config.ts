import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export function resolveInvokerConfigPath(): string {
  return path.join(homedir(), '.invoker', 'config.json');
}

export function readDefaultSlackHarnessPreset(configPath = resolveInvokerConfigPath()): string | undefined {
  return readSlackRuntimeConfig(configPath).defaultHarnessPreset;
}

export interface SlackRuntimeConfig {
  defaultHarnessPreset?: string;
  defaultRepoUrl?: string;
  repoAliases: Record<string, string>;
}

export function readSlackRuntimeConfig(configPath = resolveInvokerConfigPath()): SlackRuntimeConfig {
  const empty: SlackRuntimeConfig = { repoAliases: {} };
  if (!existsSync(configPath)) return empty;
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
    const config = raw as {
      defaultSlackHarnessPreset?: unknown;
      defaultRepoUrl?: unknown;
      slackRepos?: unknown;
    };
    const repoAliases = Object.fromEntries(
      Object.entries(
        config.slackRepos && typeof config.slackRepos === 'object' && !Array.isArray(config.slackRepos)
          ? config.slackRepos
          : {},
      ).filter(
        (entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string' && entry[1].trim().length > 0,
      ),
    );
    return {
      defaultHarnessPreset: typeof config.defaultSlackHarnessPreset === 'string' && config.defaultSlackHarnessPreset.trim().length > 0
        ? config.defaultSlackHarnessPreset.trim()
        : undefined,
      defaultRepoUrl: typeof config.defaultRepoUrl === 'string' && config.defaultRepoUrl.trim().length > 0
        ? config.defaultRepoUrl.trim()
        : undefined,
      repoAliases,
    };
  } catch {
    return empty;
  }
}

export function resolveDefaultHarnessPreset(envPreset: string | undefined, configPreset: string | undefined): string | undefined {
  if (configPreset?.trim()) return configPreset.trim();
  if (envPreset?.trim()) return envPreset.trim();
  return undefined;
}
