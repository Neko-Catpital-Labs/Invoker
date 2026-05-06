import { existsSync } from 'node:fs';
import * as path from 'node:path';

export interface ResolveRepoRootOptions {
  envVarName?: string;
  markers?: string[];
  fallback?: string;
}

const DEFAULT_MARKERS = ['pnpm-workspace.yaml'];

export function resolveRepoRoot(startDir: string, options: ResolveRepoRootOptions = {}): string {
  const envVarName = options.envVarName ?? 'INVOKER_REPO_ROOT';
  const override = process.env[envVarName];
  if (override) {
    return path.resolve(override);
  }

  const markers = options.markers ?? DEFAULT_MARKERS;
  let currentDir = path.resolve(startDir);
  while (true) {
    if (markers.some((marker) => existsSync(path.join(currentDir, marker)))) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  if (options.fallback) {
    return path.resolve(options.fallback);
  }

  throw new Error(`Could not resolve repo root from ${startDir}`);
}
