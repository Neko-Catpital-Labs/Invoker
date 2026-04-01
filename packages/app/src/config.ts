/**
 * Configuration loader for Invoker.
 *
 * Reads from ~/.invoker/config.json (user-level config).
 * Override with INVOKER_REPO_CONFIG_PATH env var (for tests).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface InvokerConfig {
  defaultBranch?: string;
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
  /** Cursor CLI subprocess timeout for plan conversations in seconds. Default: 7200 (2 hours). */
  planningTimeoutSeconds?: number;
  /** Interval for heartbeat messages posted to Slack during planning in seconds. Default: 120 (2 minutes). Set to 0 to disable. */
  planningHeartbeatIntervalSeconds?: number;
  /** Maximum number of tasks that can run concurrently. Default: 3. */
  maxConcurrency?: number;
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
  /** Docker execution environment configuration. */
  docker?: {
    /** Docker image to use for container tasks. Default: 'invoker-agent:latest'. */
    imageName?: string;
    /** If true, the image already contains the repo — skip cloning. Default: false. */
    repoInImage?: boolean;
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
   * Pattern-based rules that enforce task execution environment conformance.
   * When a rule matches a task command, the orchestrator validates that the task's
   * familiarType and remoteTargetId explicitly declared in the plan YAML match the
   * rule's requirements. Rules do NOT fill in omitted fields — they enforce conformance.
   * First matching rule wins.
   *
   * Each rule may specify:
   *   - `pattern`: substring matched against the task command (like utilizationRules)
   *   - `regex`: compiled with `new RegExp(regex)` and tested against the command
   *
   * If both `pattern` and `regex` are present, a rule matches if either matches.
   * Tasks with commands matching a rule MUST explicitly declare the required familiarType
   * and remoteTargetId in the plan YAML, or plan loading will fail with a validation error.
   * Only applies to tasks that have a command (not prompt-only tasks).
   */
  executorRoutingRules?: Array<{
    /** Substring to match against the task command. */
    pattern?: string;
    /** Regular expression matched against the task command; compiled with new RegExp(regex). */
    regex?: string;
    /** Required familiar type for matching commands (e.g. "ssh", "docker", "worktree"). */
    familiarType: string;
    /** Required remote target ID for matching commands; must correspond to an entry in remoteTargets. */
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

export function loadConfig(): InvokerConfig {
  if (process.env.INVOKER_REPO_CONFIG_PATH) {
    return readJsonSafe(process.env.INVOKER_REPO_CONFIG_PATH);
  }
  return readJsonSafe(join(homedir(), '.invoker', 'config.json'));
}

