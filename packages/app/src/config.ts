/**
 * Layered configuration loader for Invoker.
 *
 * Resolution order (last wins):
 *   1. ~/.invoker/config.json   (user-level defaults)
 *   2. <repoDir>/.invoker.json  (repo-level overrides, checked into git)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface InvokerConfig {
  defaultBranch?: string;
}

function readJsonSafe(path: string): InvokerConfig {
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function loadConfig(repoDir: string): InvokerConfig {
  const userConfig = readJsonSafe(join(homedir(), '.invoker', 'config.json'));
  const repoConfig = readJsonSafe(join(repoDir, '.invoker.json'));
  return { ...userConfig, ...repoConfig };
}
