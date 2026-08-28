import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { resolveRepoRoot } from './repo-root.js';

export interface ResolveActiveInvokerProfileEnvOptions {
  repoRoot?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

function isEnvironmentOverrides(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every((entry) => typeof entry === 'string')
  );
}

export function resolveActiveInvokerProfileEnv(
  options: ResolveActiveInvokerProfileEnvOptions = {},
): Record<string, string> {
  try {
    const repoRoot = resolve(options.repoRoot ?? resolveRepoRoot(process.cwd()));
    const scriptPath = resolve(repoRoot, 'scripts', 'with-invoker-development-profile.mjs');
    const result = spawnSync(
      process.execPath,
      [scriptPath, '--source-root', repoRoot, '--print-env'],
      { encoding: 'utf8', timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    );

    if (result.error || result.status !== 0) return {};

    const stdout = result.stdout.trim();
    if (!stdout) return {};

    const parsed: unknown = JSON.parse(stdout);
    return isEnvironmentOverrides(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
