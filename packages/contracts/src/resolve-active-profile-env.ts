import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import { resolveRepoRoot } from './repo-root.js';

export interface ResolveActiveInvokerProfileEnvOptions {
  repoRoot?: string;
  timeoutMs?: number;
}

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
    const repoRoot = options.repoRoot === undefined
      ? resolveRepoRoot(process.cwd())
      : resolve(options.repoRoot);
    const result = spawnSync(
      process.execPath,
      [
        join(repoRoot, 'scripts', 'with-invoker-development-profile.mjs'),
        '--source-root',
        repoRoot,
        '--print-env',
      ],
      {
        encoding: 'utf8',
        timeout: options.timeoutMs ?? 5_000,
      },
    );

    if (result.error || result.status !== 0 || !result.stdout.trim()) {
      return {};
    }

    const parsed: unknown = JSON.parse(result.stdout);
    return isEnvironmentOverrides(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
