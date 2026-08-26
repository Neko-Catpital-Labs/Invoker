/**
 * Configuration loader for Invoker.
 *
 * Reads from ~/.invoker/config.json (user-level config).
 * INVOKER_REPO_CONFIG_PATH is a test/CLI override only.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { resolveInvokerConfigPath } from '@invoker/contracts';
import type { PlanningConfirmationMode } from '@invoker/contracts';
import { validateInvokerConfig } from './config-validation.js';
import type { E2eAutoFixWorkerConfig, PrMaintenanceWorkerConfig } from '@invoker/execution-engine';

const BUILT_IN_DEFAULT_EXECUTION_AGENT = 'codex';

export interface ExternalWorkerLaunchConfig {
  /** Executable used to start the external worker process. */
  executable: string;
  /** Optional argv passed after the executable. */
  args?: string[];
  /** Optional process working directory for the worker launch. */
  cwd?: string;
}

export interface ExternalWorkerConfig {
  /** Stable worker registry kind declared by the operator. */
  kind: string;
  /** Process invocation used by the loader to start the external worker. */
  launch: ExternalWorkerLaunchConfig;
}
export interface DefaultExecutionConfig {
  /**
   * Default task execution harness when a task omits executionAgent.
   * Falls back to the built-in default agent when unset.
   */
  executionAgent?: string;
  /**
   * Default task execution model paired with executionAgent.
   * Only applied when the resolved task executionAgent matches this default agent.
   */
  executionModel?: string;
}

/**
 * Owner-side PR-maintenance worker launch settings.
 *
 * Process on/off lives in SQLite `worker_desired_states`, not in this block.
 * These fields tune the shell entrypoints and fall back to worker defaults
 * when omitted.
 */
export interface PrMaintenanceConfig {
  /** Repository root that owns the PR-maintenance shell scripts. Defaults to the Invoker repo root. */
  repoRoot?: string;
  /** Environment overrides forwarded to the shell entrypoint. `undefined` removes a variable. */
  env?: Record<string, string | undefined>;
  /** Poll cadence for all PR-maintenance workers in milliseconds. Defaults to five minutes. */
  intervalMs?: number;
  /** Shared cron lock path. Defaults to the shell script's INVOKER_PR_CRON_LOCK behavior. */
  lockPath?: string;
  /** Shell executable used to run the entrypoint. Defaults to bash. */
  shell?: string;
  /**
   * GitHub `owner/repo` list scanned each PR-maintenance tick (admin-bypass,
   * orphan repair, duplicate close). When omitted, defaults to the Invoker repo.
   */
  targetRepos?: string[];
}

export const DEFAULT_PR_MAINTENANCE_TARGET_REPO = 'Neko-Catpital-Labs/Invoker';

/**
 * Owner-side e2e-autofix worker target settings.
 *
 * Cadence lives in the flat `e2eAutoFixIntervalMs`; this block only carries
 * the GitHub scan list and env overrides forwarded to the shell entrypoint.
 */
export interface E2eAutoFixConfig {
  /** Environment overrides forwarded to the shell entrypoint. `undefined` removes a variable. */
  env?: Record<string, string | undefined>;
  /**
   * GitHub `owner/repo` list watched by the e2e-autofix worker (CI regression
   * watch + repair filing). When omitted, defaults to the Invoker repo only.
   */
  targetRepos?: string[];
}

export const DEFAULT_E2E_AUTOFIX_TARGET_REPO = 'Neko-Catpital-Labs/Invoker';

const GITHUB_OWNER_REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** Normalize and validate a GitHub `owner/repo` string; returns null when invalid. */
export function normalizeGithubOwnerRepo(value: string): string | null {
  const trimmed = value.trim();
  if (!GITHUB_OWNER_REPO_RE.test(trimmed)) return null;
  return trimmed;
}

/**
 * Resolve the PR-maintenance scan list from `prMaintenance.targetRepos`.
 * When omitted or empty, defaults to the Invoker repo only.
 */
export function resolvePrMaintenanceTargetRepos(config: InvokerConfig): string[] {
  const fromConfig = config.prMaintenance?.targetRepos;
  if (Array.isArray(fromConfig) && fromConfig.length > 0) {
    const repos: string[] = [];
    for (const entry of fromConfig) {
      if (typeof entry !== 'string') continue;
      const normalized = normalizeGithubOwnerRepo(entry);
      if (normalized && !repos.includes(normalized)) repos.push(normalized);
    }
    if (repos.length > 0) return repos;
  }
  return [DEFAULT_PR_MAINTENANCE_TARGET_REPO];
}

/**
 * Resolve the e2e-autofix scan list from `e2eAutoFix.targetRepos`.
 * When omitted or empty, defaults to the Invoker repo only.
 */
export function resolveE2eAutoFixTargetRepos(config: InvokerConfig): string[] {
  const fromConfig = config.e2eAutoFix?.targetRepos;
  if (Array.isArray(fromConfig) && fromConfig.length > 0) {
    const repos: string[] = [];
    for (const entry of fromConfig) {
      if (typeof entry !== 'string') continue;
      const normalized = normalizeGithubOwnerRepo(entry);
      if (normalized && !repos.includes(normalized)) repos.push(normalized);
    }
    if (repos.length > 0) return repos;
  }
  return [DEFAULT_E2E_AUTOFIX_TARGET_REPO];
}

export interface SlackBugScanConfig {
  intervalMs?: number;
  maxAutoSubmissionsPerDay?: number;
  maxAutoSubmissionsPerTick?: number;
}

/** One source repo to mine for stealable ideas. */
export interface CrossRepoResearchSource {
  /** GitHub repo URL (https or git@). */
  repoUrl: string;
  /** Days of source activity to consider. Must be > 0. Default: 30. */
  lookbackDays?: number;
}

/**
 * Opt-in cross-repo-research worker settings. Process on/off is SQLite
 * `worker_desired_states`, not a config boolean.
 */
export interface CrossRepoResearchConfig {
  /** Poll cadence in days. Default: 14. */
  intervalDays?: number;
  /** Linear team id required when maps are non-empty. */
  linearTeamId?: string;
  /** Cap candidate ideas per source per tick. Default: 5. */
  maxCandidatesPerSource?: number;
  /**
   * Target repo URL → list of sources to mine.
   * Source entries may be a URL string (lookbackDays defaults to 30) or
   * `{ repoUrl, lookbackDays }`.
   */
  maps?: Record<string, Array<string | CrossRepoResearchSource>>;
}

/** Default lookback when a source omits lookbackDays. */
export const DEFAULT_CROSS_REPO_RESEARCH_LOOKBACK_DAYS = 30;

/** Default worker poll cadence when intervalDays is unset. */
export const DEFAULT_CROSS_REPO_RESEARCH_INTERVAL_DAYS = 14;

/** Default max candidates mined per source per tick. */
export const DEFAULT_CROSS_REPO_RESEARCH_MAX_CANDIDATES_PER_SOURCE = 5;

/**
 * One source whose Mergify/admin-bypass ledger events are mined for research.
 * Same shape as CrossRepoResearchSource so maps stay interchangeable.
 */
export type MergifyQueueResearchSource = CrossRepoResearchSource;

/**
 * Opt-in mergify-queue-research worker settings. Process on/off is SQLite
 * `worker_desired_states`, not a config boolean.
 */
export interface MergifyQueueResearchConfig {
  /** Poll cadence in days. Default: 14. */
  intervalDays?: number;
  /** Linear team id required when maps are non-empty. */
  linearTeamId?: string;
  /** Cap candidate events per source per tick. Default: 5. */
  maxCandidatesPerSource?: number;
  /**
   * Target repo URL → list of sources whose queue/ledger to mine.
   * Source entries may be a URL string (lookbackDays defaults to 30) or
   * `{ repoUrl, lookbackDays }`.
   */
  maps?: Record<string, Array<string | MergifyQueueResearchSource>>;
}

/** Default lookback when a Mergify queue research source omits lookbackDays. */
export const DEFAULT_MERGIFY_QUEUE_RESEARCH_LOOKBACK_DAYS = 30;

/** Default Mergify queue research poll cadence when intervalDays is unset. */
export const DEFAULT_MERGIFY_QUEUE_RESEARCH_INTERVAL_DAYS = 14;

/** Default max Mergify queue candidates mined per source per tick. */
export const DEFAULT_MERGIFY_QUEUE_RESEARCH_MAX_CANDIDATES_PER_SOURCE = 5;

/**
 * Opt-in catstack-deploy worker settings. Process on/off is SQLite
 * `worker_desired_states`, not a config boolean.
 */
export interface CatstackDeployConfig {
  /** Poll cadence in minutes. Default: 15. */
  intervalMinutes?: number;
  /** Git clone URL. Default: https://github.com/EdbertChan/catstack.git */
  repoUrl?: string;
  /** Local checkout path. Default: ~/Documents/GitHub/catstack */
  localRepoPath?: string;
  /** Remote checkout path on each SSH host. Default: ~/Documents/GitHub/catstack */
  remoteRepoPath?: string;
}

/** Default poll cadence when catstackDeploy.intervalMinutes is unset. */
export const DEFAULT_CATSTACK_DEPLOY_INTERVAL_MINUTES = 15;

/** Default catstack clone URL. */
export const DEFAULT_CATSTACK_DEPLOY_REPO_URL = 'https://github.com/EdbertChan/catstack.git';

/** Default local/remote checkout path for catstack. */
export const DEFAULT_CATSTACK_DEPLOY_REPO_PATH = '~/Documents/GitHub/catstack';

export interface InvokerConfig {
  defaultBranch?: string;
  /**
   * Default review/confirmation mode for in-app planning terminal sessions.
   * 'require' asks before submitting a generated plan; 'auto_submit' submits
   * automatically. Unset falls back to 'require'.
   */
  defaultPlanningTerminalConfirmationMode?: PlanningConfirmationMode;
  /**
   * Web surface (browser mirror of the desktop app) shared-secret token.
   * When set (or via INVOKER_WEB_TOKEN), the owner process serves the UI at
   * http://<webHost>:<webPort>/?token=<token>. Unset disables the web surface.
   * INVOKER_WEB_TOKEN takes precedence over this value.
   */
  webToken?: string;
  /**
   * Host the web surface binds to. Default '127.0.0.1' (localhost only).
   * Set '0.0.0.0' to expose it on a remote box (e.g. the DigitalOcean host).
   * INVOKER_WEB_HOST takes precedence.
   */
  webHost?: string;
  /**
   * Port the web surface binds to. Default 4200. INVOKER_WEB_PORT takes precedence.
   */
  webPort?: number;
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
   * Global retry budget for auto-fix attempts per failed task.
   * Default: 0 (disabled).
   */
  autoFixRetries?: number;
  /** Cadence for the e2e-autofix worker in milliseconds. Default: 43_200_000 (12h). */
  e2eAutoFixIntervalMs?: number;
  /**
   * Owner-side e2e-autofix worker target settings (GitHub scan list, env overrides).
   * Cadence stays in the flat `e2eAutoFixIntervalMs` above.
   */
  e2eAutoFix?: E2eAutoFixConfig;
  stallRequeueRetries?: number;
  stallRequeueBackoffMs?: number;
  /**
   * When true, successful AI-applied fixes are automatically approved.
   * This skips the manual "Approve Fix" step for fix-with-agent and
   * resolve-conflict flows.
   *
   * Default: false.
   */
  autoApproveAIFixes?: boolean;
  /**
   * EXPERIMENTAL_PLANNER. When true, redirect the planning step to the
   * experimental external planner (via the redirect MCP server) instead of the
   * native planning skill. The redirect server also reads this flag and serves no
   * tools when off, so planning falls back to native. Default: false.
   */
  experimentalPlanner?: boolean;
  /**
   * Preferred execution agent for automatic fix retries.
   * When unset, auto-fix falls back to the task's executionAgent,
   * then to the built-in default agent.
   */
  autoFixAgent?: string;
  /**
   * Explicit execution model for automatic fix retries, independent of
   * defaultExecutionModel. Takes precedence over the equality-based
   * derivation in resolveAutoFixExecutionModel.
   */
  autoFixExecutionModel?: string;
  /**
   * Execution pool or remote target used for automatic fix retries.
   * When unset, auto-fix tasks fall back to defaultPoolId.
   */
  autoFixPoolId?: string;
  /**
   * Preferred execution agent for resolve-conflict (git merge conflicts).
   * When unset, resolve-conflict uses the entry-point path default
   * (explicit CLI/UI agent, then defaultExecutionAgent / autoFixAgent).
   */
  conflictResolutionAgent?: string;
  /**
   * Preferred execution model for resolve-conflict only.
   * When set, wins over task.config.executionModel / defaultExecutionModel
   * so conflict resolution can use a cheaper model than normal task work.
   */
  conflictResolutionModel?: string;
  /** Default execution harness for prompt-backed tasks when the task does not override it. */
  defaultExecutionAgent?: string;
  /** Default execution model for prompt-backed tasks when the task does not override it. */
  defaultExecutionModel?: string;
  /**
   * Allowlist of execution agents offered by UI surfaces (execution-harness
   * pickers and planning presets). Entries are agent names, e.g. 'claude',
   * 'codex', 'omp'; matching is case-insensitive and whitespace-trimmed.
   * Unset (or empty after trimming) means every registered agent is offered.
   * This only restricts what surfaces offer — a task explicitly pinned to a
   * disabled agent still runs.
   */
  enabledExecutionAgents?: string[];
  /**
   * Config-owned default execution harness/model for tasks that omit them.
   * This is separate from Slack planning presets and applies across surfaces.
   */
  defaultExecution?: DefaultExecutionConfig;
  /**
   * When true, failed CI checks on Invoker-created review-gate PRs can
   * trigger the same auto-fix recovery flow used for task failures.
   *
   * Default: false.
   */
  autoFixCi?: boolean;
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
  /**
   * How many additional attempts to make when the planner CLI exits 0 with
   * empty stdout (typically an auth-token refresh window or a one-off rate
   * limit). Only retries the silent-success case; non-zero exits and spawn
   * errors are not retried. Default: 2 (3 attempts total).
   */
  plannerRetryLimit?: number;
  /**
   * Base delay in milliseconds between planner empty-output retry attempts.
   * Each subsequent retry doubles this value. Default: 500ms.
   */
  plannerRetryBaseDelayMs?: number;
  /** Named Slack planning harness presets: preset key → {tool, model}; built-ins apply when omitted. */
  slackHarnessPresets?: Record<string, { tool: 'cursor' | 'omp' | 'codex' | 'claude'; model?: string }>;
  /** Default harness preset key when the message carries no `[preset]` tag. Default: 'cursor+claude'. */
  defaultSlackHarnessPreset?: string;
  /** Slack repo aliases: alias → git URL, resolved from a `[repo:<alias>]` tag. */
  slackRepos?: Record<string, string>;
  /** Repo URL used for Slack planning when the message carries no `[repo:]` tag. */
  defaultRepoUrl?: string;
  /** Slack user IDs allowed to run Slack administrative actions. */
  slackAdminUserIds?: string[];
  /** Stable Slack channel ID → default repository URL for channel-scoped planning. */
  slackChannelRepos?: Record<string, string>;
  /** Maximum number of tasks that can run concurrently. Default: 6. */
  maxConcurrency?: number;
  /** Browser executable for opening external URLs (e.g. "firefox"). Default: Chrome. */
  browser?: string;
  /** GUI embedded terminal options. Headless open-terminal ignores this. */
  terminal?: {
    /** Backend for GUI embedded spawned terminals. Default: bash. */
    embeddedBackend?: 'bash' | 'pty';
  };
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
     *
     * Managed SSH worktrees only run repo bootstrap when `provisionCommand` is set.
     */
    remoteInvokerHome?: string;
    /**
     * Optional repo-owned bootstrap command run inside managed remote worktrees before the task payload.
     */
    provisionCommand?: string;
    /**
     * When true, export agent API keys from the local secrets file into SSH task/fix
     * shells. Default false so remote Claude/Codex CLI account auth is preserved.
     */
    use_api_key?: boolean;
    /**
     * Optional local KEY=value secrets file used when use_api_key is true.
     * Defaults to docker.secretsFile/fallback when unset.
     */
    secretsFile?: string;
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
  /** Named local worktree targets used by execution pools. */
  worktreeTargets?: Record<string, {
    /** Optional repo-owned bootstrap command run inside local managed worktrees before the task payload. */
    provisionCommand?: string;
    /** Max concurrent tasks allowed on this target when used inside an execution pool. */
    maxConcurrentTasks?: number;
  }>;
  /**
   * Per-repo override for local worktree targets' `provisionCommand`, keyed
   * by `repoUrl` (any `git@`/`https://`/`.git` form — normalized before
   * matching). A workflow whose `repoUrl` has an entry here uses that
   * command instead of its worktree target's default, including `''` to run
   * no install step at all for a repo that isn't a Node project.
   */
  repoProvisionCommands?: Record<string, string>;
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
  /**
   * Operator-declared external worker list, with each worker identified by registry kind.
   * The loader consumes this later; absent means no external workers.
   */
  externalWorkers?: ExternalWorkerConfig[];
  /**
   * Owner-side PR-maintenance launch settings (interval, lock, repo root).
   * Process on/off is SQLite `worker_desired_states`, not a config boolean.
   */
  prMaintenance?: PrMaintenanceConfig;
  /**
   * Owner-side disk-headroom policy. `cleanupEnabled` controls whether the
   * always-running disk-headroom worker may delete files on critical disks;
   * it does not start or stop the worker. Takes precedence over the legacy
   * `INVOKER_DISK_CLEANUP_ENABLED` env var when set. Default: enabled.
   */
  diskHeadroom?: {
    cleanupEnabled?: boolean;
  };
  slackBugScan?: SlackBugScanConfig;
  /**
   * Cross-repo research worker: maps target repos to source repos to mine.
   * Process on/off is SQLite `worker_desired_states`, not a config boolean.
   */
  crossRepoResearch?: CrossRepoResearchConfig;
  /**
   * Mergify queue research worker: maps target repos to sources whose
   * Mergify/admin-bypass ledger events are mined for a research swarm.
   * Process on/off is SQLite `worker_desired_states`, not a config boolean.
   */
  mergifyQueueResearch?: MergifyQueueResearchConfig;
  /**
   * Catstack deploy worker: clone/pull/install cadence and paths.
   * Process on/off is SQLite `worker_desired_states`, not a config boolean.
   * Remotes always come from top-level `remoteTargets`.
   */
  catstackDeploy?: CatstackDeployConfig;
}
export const DEFAULT_SLACK_HARNESS_PRESETS: NonNullable<InvokerConfig['slackHarnessPresets']> = {
  'cursor+claude': { tool: 'cursor', model: 'claude' },
  'cursor+codex': { tool: 'cursor', model: 'codex' },
  'omp+claude': { tool: 'omp', model: 'claude' },
  'omp+codex': { tool: 'omp', model: 'codex' },
  omp: { tool: 'omp' },
  codex: { tool: 'codex' },
  claude: { tool: 'claude' },
};

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

export function resolveConfigFilePath(): string {
  return resolveInvokerConfigPath(process.env, homedir());
}

export function resolveConfigFileState(): { path: string; exists: boolean } {
  const path = resolveConfigFilePath();
  return { path, exists: existsSync(path) };
}
export function loadConfig(): InvokerConfig {
  const config = readJsonSafe(resolveConfigFilePath());
  return validateInvokerConfig(config);
}
export function resolveDefaultExecutionAgent(config: InvokerConfig): string {
  const configured = config.defaultExecutionAgent?.trim();
  return configured && configured.length > 0 ? configured : BUILT_IN_DEFAULT_EXECUTION_AGENT;
}

/**
 * Resolve the configured execution-agent allowlist.
 * Returns null when `enabledExecutionAgents` is unset or empty after trimming
 * (null = no restriction). Entries are trimmed and lowercased.
 */
export function resolveEnabledExecutionAgents(config: InvokerConfig): Set<string> | null {
  const entries = (config.enabledExecutionAgents ?? [])
    .map((name) => (typeof name === 'string' ? name.trim().toLowerCase() : ''))
    .filter((name) => name.length > 0);
  return entries.length > 0 ? new Set(entries) : null;
}

/**
 * Filter execution harnesses down to the configured allowlist.
 * No allowlist configured -> input returned unchanged.
 */
export function filterExecutionHarnesses<T extends { name: string }>(harnesses: T[], config: InvokerConfig): T[] {
  const enabled = resolveEnabledExecutionAgents(config);
  if (!enabled) return harnesses;
  return harnesses.filter((harness) => enabled.has(harness.name.trim().toLowerCase()));
}

/** Planning tools that wrap another agent; their `model` names the wrapped agent. */
const WRAPPER_PLANNING_TOOLS: Record<string, true> = { cursor: true, omp: true };

/**
 * Filter planning presets down to the configured allowlist.
 * A preset is kept when its `tool` is allowlisted, or when the tool is a
 * wrapper ('cursor'/'omp') whose `model` names an allowlisted agent.
 * No allowlist configured -> input returned unchanged.
 */
export function filterPlanningPresets<T extends { tool: string; model?: string }>(
  presets: T[],
  config: InvokerConfig,
): T[] {
  const enabled = resolveEnabledExecutionAgents(config);
  if (!enabled) return presets;
  return presets.filter((preset) => {
    const tool = preset.tool.trim().toLowerCase();
    if (enabled.has(tool)) return true;
    if (!WRAPPER_PLANNING_TOOLS[tool]) return false;
    const model = preset.model?.trim().toLowerCase();
    return Boolean(model && enabled.has(model));
  });
}


export interface DefaultTaskExecutionSettings {
  executionAgent: string;
  executionModel?: string;
}

export function resolveDefaultTaskExecutionSettings(config: InvokerConfig): DefaultTaskExecutionSettings {
  const configuredAgent = config.defaultExecutionAgent?.trim();
  const configuredModel = config.defaultExecutionModel?.trim();
  return {
    executionAgent: configuredAgent && configuredAgent.length > 0 ? configuredAgent : BUILT_IN_DEFAULT_EXECUTION_AGENT,
    ...(configuredModel && configuredModel.length > 0 ? { executionModel: configuredModel } : {}),
  };
}
export function resolveAutoFixExecutionModel(config: InvokerConfig): string | undefined {
  const explicit = config.autoFixExecutionModel?.trim();
  if (explicit) return explicit;
  const autoFixAgent = config.autoFixAgent?.trim();
  if (!autoFixAgent) return undefined;
  const defaults = resolveDefaultTaskExecutionSettings(config);
  return autoFixAgent === defaults.executionAgent ? defaults.executionModel : undefined;
}

export function resolveAutoFixPoolId(config: InvokerConfig): string | undefined {
  return config.autoFixPoolId?.trim() || undefined;
}



export interface ConflictResolutionSettings {
  agent?: string;
  model?: string;
}

/**
 * Resolve agent/model for resolve-conflict.
 *
 * Precedence for agent: explicitAgent → conflictResolutionAgent → pathDefaultAgent.
 * Model: conflictResolutionModel when set (wins over task/default execution models).
 */
export function resolveConflictResolutionSettings(
  config: Pick<InvokerConfig, 'conflictResolutionAgent' | 'conflictResolutionModel'>,
  options?: {
    explicitAgent?: string;
    pathDefaultAgent?: string;
  },
): ConflictResolutionSettings {
  const explicit = options?.explicitAgent?.trim();
  const configAgent = config.conflictResolutionAgent?.trim();
  const configModel = config.conflictResolutionModel?.trim();
  const pathDefault = options?.pathDefaultAgent?.trim();

  const agent = (explicit && explicit.length > 0)
    ? explicit
    : (configAgent && configAgent.length > 0)
      ? configAgent
      : (pathDefault && pathDefault.length > 0)
        ? pathDefault
        : undefined;

  return {
    ...(agent ? { agent } : {}),
    ...(configModel && configModel.length > 0 ? { model: configModel } : {}),
  };
}

export type EmbeddedTerminalBackendConfig = 'bash' | 'pty';

export function resolveEmbeddedTerminalBackendConfig(
  config: InvokerConfig,
  env: NodeJS.ProcessEnv = process.env,
): EmbeddedTerminalBackendConfig {
  const rawValue = env.INVOKER_EMBEDDED_TERMINAL_BACKEND ?? config.terminal?.embeddedBackend ?? 'pty';
  const raw = typeof rawValue === 'string' ? rawValue : String(rawValue);
  const value = raw.trim().toLowerCase();
  if (value === 'bash' || value === 'pty') return value;
  throw new Error(
    `Invalid embedded terminal backend "${raw}". Expected "bash" or "pty".`,
  );
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

/**
 * Build PR-maintenance worker launch dependencies from config.
 *
 * Returns `undefined` when the block is absent or empty. Process on/off is
 * SQLite desired state; this only threads interval/lock/repoRoot/env/shell
 * so a started PR-maintenance worker still gets launch settings.
 */
export function resolvePrMaintenanceWorkerConfig(
  config: InvokerConfig,
): PrMaintenanceWorkerConfig | undefined {
  const prMaintenance = config.prMaintenance;
  if (!prMaintenance) {
    return undefined;
  }
  const launch: PrMaintenanceWorkerConfig = {};
  if (prMaintenance.repoRoot !== undefined) launch.repoRoot = prMaintenance.repoRoot;
  if (prMaintenance.intervalMs !== undefined) launch.intervalMs = prMaintenance.intervalMs;
  if (prMaintenance.lockPath !== undefined) launch.lockPath = prMaintenance.lockPath;
  if (prMaintenance.shell !== undefined) launch.shell = prMaintenance.shell;

  const targetRepos = resolvePrMaintenanceTargetRepos(config);
  // Config is authoritative; always inject the scan list for the shell entrypoints.
  const env: Record<string, string | undefined> = {
    ...(prMaintenance.env ?? {}),
    INVOKER_GITHUB_TARGET_REPOS: targetRepos.join(','),
    INVOKER_GITHUB_TARGET_REPO: targetRepos[0],
  };
  launch.env = env;

  return Object.keys(launch).length > 0 ? launch : {};
}

/**
 * Build e2e-autofix worker launch dependencies from config.
 *
 * Always returns `intervalMs` and `env` (with the resolved target-repo scan
 * list injected), so the worker keeps watching only Invoker by default when
 * `e2eAutoFix` is absent or `targetRepos` is omitted/empty.
 */
export function resolveE2eAutoFixWorkerConfig(
  config: InvokerConfig,
): E2eAutoFixWorkerConfig {
  const targetRepos = resolveE2eAutoFixTargetRepos(config);
  const env: Record<string, string | undefined> = {
    ...(config.e2eAutoFix?.env ?? {}),
    INVOKER_GITHUB_TARGET_REPOS: targetRepos.join(','),
    INVOKER_GITHUB_TARGET_REPO: targetRepos[0],
  };
  return {
    intervalMs: config.e2eAutoFixIntervalMs,
    env,
  };
}
