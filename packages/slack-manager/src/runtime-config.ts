import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export function resolveInvokerConfigPath(): string {
  return path.join(homedir(), '.invoker', 'config.json');
}

export function readDefaultSlackHarnessPreset(configPath = resolveInvokerConfigPath()): string | undefined {
  if (!existsSync(configPath)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const preset = (raw as { defaultSlackHarnessPreset?: unknown }).defaultSlackHarnessPreset;
    return typeof preset === 'string' && preset.trim().length > 0 ? preset.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function resolveDefaultHarnessPreset(envPreset: string | undefined, configPreset: string | undefined): string | undefined {
  if (configPreset?.trim()) return configPreset.trim();
  if (envPreset?.trim()) return envPreset.trim();
  return undefined;
}
