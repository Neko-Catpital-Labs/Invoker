/**
 * Configuration loader for Invoker.
 *
 * Reads from ~/.invoker/config.json (user-level config).
 * Override with INVOKER_REPO_CONFIG_PATH env var (for tests).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
  /**
   * Global retry budget for automatic fix attempts per task.
   *
   * This also gates review-gate CI repair. The built-in `ci-failure`
   * worker and the `repair-review-gate-ci` headless command only queue
   * a fix mutation while the mapped task still has retry budget.
   *
   * Default: 0 (disabled).
   */
  autoFixRetries?: number;
  /**
   * When true, successful AI-applied fixes are automatically approved.
   * This skips the manual "Approve Fix" step for fix-with-agent and
   * resolve-conflict flows.
   *
   * Default: false.
   */
  autoApproveAIFixes?: boolean;
  /**
   * Preferred execution agent for automatic fix retries and review-gate
   * CI repair. When unset, fix sessions use the built-in default agent.
   */
  autoFixAgent?: string;
  /**
   * Read-only diagnostics tuning for the Action Graph view.
   * Default stall threshold: 60000ms. Env fallback:
   * INVOKER_ACTION_STALL_THRESHOLD_MS.
   */
  actionDiagnostics?: {
    stallThresholdMs?: number;
  };
  /** Cursor CLI subprocess timeout for plan conversations in seconds. Default: 7200 (2 hours). */
  planningTimeoutSeconds?: number;
  /** Interval for heartbeat messages posted to Slack during planning in seconds. Default: 120 (2 minutes). Set to 0 to disable. */
  planningHeartbeatIntervalSeconds?: number;
  /** Maximum number of tasks that can run concurrently. Default: 6. */
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
    /** Docker image to use for container tasks. Default: 'invoker/agent-base:latest'. */
    imageName?: string;
    /**
     * Path to a `KEY=value` secrets file (chmod 600/400) that is loaded and
     * forwarded to the container as additional environment variables. The
     * file's keys are appended to the container's `Env` array verbatim.
     *
     * Default fallback: `~/.config/invoker/secrets.env` (used only when the
     * file actually exists). When unset and the default is missing, no extra
     * secrets are forwarded.
     */
    secretsFile?: string;
  };
  /** Named remote SSH targets for running tasks on remote machines via SSH key auth. */
  remoteTargets?: Record<string, {
    host: string;
    user: string;
    /** Path to SSH identity file (private key). */
    sshKeyPath: string;
    /** SSH port. Default: 22. */
    port?: number;
    /**
     * When true, use managed workspace mode: clone/fetch repo, create/reset worktrees,
     * and provision per-task workspaces. When false (default), BYO mode: user provides
     * pre-cloned repo path and handles all git/setup operations.
     */
    managedWorkspaces?: boolean;
    /**
     * Remote invoker home directory (e.g., ~/.invoker). Only used in managed mode.
     * Default: ~/.invoker
     */
    remoteInvokerHome?: string;
    /**
     * Optional provision command to run in the worktree after creation (e.g., pnpm install).
     * Only used in managed mode. Default: pnpm install --frozen-lockfile
     */
    provisionCommand?: string;
    /**
     * Remote workload heartbeat interval (seconds) emitted by the SSH payload wrapper.
     * Used for SSH executing-stall liveness checks. Default: 30.
     */
    remoteHeartbeatIntervalSeconds?: number;
    /**
     * Max concurrent tasks allowed on this target when used inside an execution pool.
     * Default for pooled SSH members: 1.
     */
    maxConcurrentTasks?: number;
  }>;
  /**
   * Named execution pools used by routing rules.
   * Pools provide shared queue + drain semantics with per-member capacity limits.
   */
  executionPools?: Record<string, {
    /** Pool members can mix substrates under one shared queue. */
    members: Array<
      | { type: 'ssh'; id: string; maxConcurrentTasks?: number }
      | { type: 'worktree'; id: string; maxConcurrentTasks?: number }
    >;
    /** Member selection strategy for available capacity. Default: roundRobin */
    selectionStrategy?: 'roundRobin' | 'leastLoaded';
    /** Fallback per-member cap when member-specific capacity is not set. */
    maxConcurrentTasksPerMember?: number;
  }>;
  /**
   * Default execution pool for tasks that do not declare poolId and are not
   * routed by executorRoutingRules. Applies to command and prompt-only tasks.
   */
  defaultPoolId?: string;
  /**
   * Config-owned routing policy for heavyweight shell commands.
   * Matching tasks are auto-routed to the configured pool at plan submission time.
   * Default matcher set for v1 is any command invoking `pnpm`.
   */
  heavyweightCommandRouting?: {
    /** Set false to disable heavyweight auto-routing without deleting the config block. */
    enabled?: boolean;
    /** Required destination execution pool ID for heavyweight commands. */
    poolId: string;
    /** Optional command matchers; defaults to matching any `pnpm` invocation. */
    matchers?: Array<{
      pattern?: string;
      regex?: string;
    }>;
  };
  /**
   * Pattern-based rules that enforce task pool conformance.
   * When a rule matches a task command, the orchestrator validates that the task's
   * poolId declared in the plan YAML matches the rule's requirements.
   * First matching rule wins.
   *
   * Rule strategies:
   * - `enforce` (default): require matching tasks to already declare the same pool.
   * - `route`: auto-apply the pool when omitted; reject explicit pool conflicts.
   *
   * First matching rule wins per strategy bucket:
   * - first matching `route` rule is applied
   * - then first matching `enforce` rule validates the effective routing
   *
   * If both `pattern` and `regex` are present, a rule matches if either matches.
   * Tasks with commands matching a rule MUST explicitly declare the required poolId
   * in the plan YAML, or plan loading will fail with a validation error.
   * Only applies to tasks that have a command (not prompt-only tasks).
   */
  executorRoutingRules?: Array<{
    /** Substring to match against the task command. */
    pattern?: string;
    /** Regular expression matched against the task command; compiled with new RegExp(regex). */
    regex?: string;
    /** Required execution pool ID for matching commands. */
    poolId: string;
    /** Routing strategy. Defaults to "enforce". */
    strategy?: 'enforce' | 'route';
  }>;
}

function readJsonSafe(path: string): InvokerConfig {
  if (!existsSync(path)) {
    return {};
  }

  const raw = readFileSync(path, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Invoker config JSON at ${path}: ${message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid Invoker config at ${path}: expected a JSON object`);
  }

  return parsed as InvokerConfig;
}

export function loadConfig(): InvokerConfig {
  if (process.env.INVOKER_REPO_CONFIG_PATH) {
    return readJsonSafe(process.env.INVOKER_REPO_CONFIG_PATH);
  }
  return readJsonSafe(join(homedir(), '.invoker', 'config.json'));
}

/**
 * Resolve the secrets file path for Docker tasks.
 *
 * Returns the explicit `docker.secretsFile` from config (with `~` expansion)
 * if set; otherwise returns `~/.config/invoker/secrets.env` if that file
 * exists; otherwise returns `undefined` (no secrets forwarded).
 */
export function resolveSecretsFilePath(config: InvokerConfig): string | undefined {
  const explicit = config.docker?.secretsFile;
  if (explicit) {
    if (explicit === '~') return homedir();
    if (explicit.startsWith('~/')) return resolve(homedir(), explicit.slice(2));
    return explicit;
  }
  const fallback = join(homedir(), '.config', 'invoker', 'secrets.env');
  if (existsSync(fallback)) return fallback;
  return undefined;
}
