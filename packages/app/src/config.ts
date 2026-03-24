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
  /**
   * Allow plans with task IDs that overlap existing workflows.
   * When false (default), submitting a plan whose task IDs already exist
   * in an active workflow will be rejected with an error message.
   * Set to true to permit intentional graph mutation.
   */
  allowGraphMutation?: boolean;
  /** Cursor CLI subprocess timeout for plan conversations in ms. Default: 300000 (5 minutes). */
  planningTimeoutMs?: number;
  /** Interval for heartbeat messages posted to Slack during planning in ms. Default: 60000 (60 seconds). Set to 0 to disable. */
  planningHeartbeatIntervalMs?: number;
  /** Maximum number of tasks that can run concurrently. Overrides utilization-based scheduling. Default: 3 (from Orchestrator). */
  maxConcurrency?: number;
  /** Maximum number of execution attempts per task node before refusing retries. Default: 10. */
  maxAttemptsPerNode?: number;
  /** Browser executable for opening external URLs (e.g. "firefox"). Default: Chrome. */
  browser?: string;
  /** Cloudflare R2 (or S3-compatible) storage for PR images. Env var fallback: R2_*. */
  imageStorage?: {
    provider: 'r2';
    accountId: string;
    bucketName: string;
    accessKeyId: string;
    secretAccessKey: string;
    /** e.g. "https://bucket.r2.dev" or custom domain */
    publicUrlBase: string;
  };
  /** Named remote SSH targets for running tasks on remote machines via SSH key auth. */
  remoteTargets?: Record<string, {
    host: string;
    user: string;
    /** Path to SSH identity file (private key). */
    sshKeyPath: string;
    /** SSH port. Default: 22. */
    port?: number;
  }>;
  /**
   * Pattern-based rules that assign a familiarType and remoteTargetId to tasks
   * based on their command string. First matching rule wins.
   *
   * Each rule may specify:
   *   - `pattern`: substring matched against the task command (like utilizationRules)
   *   - `regex`: compiled with `new RegExp(regex)` and tested against the command
   *
   * If both `pattern` and `regex` are present, a rule matches if either matches.
   * Explicit per-task `familiarType` or `remoteTargetId` set in plan YAML always
   * takes precedence and will not be overridden.
   * Only applies to tasks that have a command (not prompt-only tasks).
   */
  executorRoutingRules?: Array<{
    /** Substring to match against the task command. */
    pattern?: string;
    /** Regular expression matched against the task command; compiled with new RegExp(regex). */
    regex?: string;
    /** Familiar type to assign (e.g. "ssh", "docker", "worktree"). */
    familiarType: string;
    /** Remote target ID to assign; must correspond to an entry in remoteTargets. */
    remoteTargetId: string;
  }>;
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

/** A single executor routing rule from InvokerConfig.executorRoutingRules. */
export type ExecutorRoutingRule = NonNullable<InvokerConfig['executorRoutingRules']>[number];

/**
 * Resolve which familiarType and remoteTargetId to apply to a task, given the
 * configured executorRoutingRules.
 *
 * Returns `{}` (no override) when:
 *   - The plan already sets `familiarType` OR `remoteTargetId` on the task
 *     (explicit YAML wins — the caller must not override these).
 *   - No rule matches the command.
 *
 * Otherwise returns the familiarType and remoteTargetId from the first matching
 * rule. A rule matches when `pattern` is a substring of `command`, `regex`
 * compiles and tests true against `command`, or both (either is sufficient).
 */
export function resolveExecutorRouting(
  command: string,
  planFamiliarType: string | undefined,
  planRemoteTargetId: string | undefined,
  rules: ExecutorRoutingRule[],
): { familiarType?: string; remoteTargetId?: string } {
  if (planFamiliarType !== undefined || planRemoteTargetId !== undefined) {
    return {};
  }
  for (const rule of rules) {
    const patternMatch = rule.pattern !== undefined && command.includes(rule.pattern);
    const regexMatch = rule.regex !== undefined && new RegExp(rule.regex).test(command);
    if (patternMatch || regexMatch) {
      return { familiarType: rule.familiarType, remoteTargetId: rule.remoteTargetId };
    }
  }
  return {};
}
