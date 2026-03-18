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
  /**
   * When true, skip local executor for non-merge-gate tasks.
   * Environment variable DISABLE_LOCAL_EXECUTOR_EXCEPT_MERGE_GATE overrides this.
   * Default: false
   */
  disableLocalExecutorExceptMergeGate?: boolean;
  /**
   * Pattern-based rules mapping command substrings to utilization values.
   * Utilization is 0-100 (percentage of executor capacity) or "max" (exclusive).
   * First matching rule wins. Checked after per-task config.utilization.
   */
  utilizationRules?: Array<{ pattern: string; utilization: number | 'max' }>;
  /** Default utilization when no rule matches. Default: 50 */
  defaultUtilization?: number;
  /**
   * When true, skip relaunching orphaned running tasks on GUI startup.
   * Useful when you want to inspect state before tasks resume automatically.
   * Default: false
   */
  disableAutoRunOnStartup?: boolean;
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
