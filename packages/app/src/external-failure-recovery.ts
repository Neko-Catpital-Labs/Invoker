/**
 * External failure-recovery launcher.
 *
 * Provides a small helper that, when enabled in config, spawns an operator
 * supplied script as a detached external process whenever a task fails.
 * The helper is intentionally dormant: nothing in this module reaches into
 * the task-delta pipeline. Callers are responsible for wiring it up.
 *
 * Time and process-launch are dependency-injected so cooldown behavior and
 * env-var construction can be exercised deterministically in tests without
 * actually spawning subprocesses.
 */

import { spawn } from 'node:child_process';
import type { ExternalFailureRecoveryConfig } from './config.js';

export type { ExternalFailureRecoveryConfig } from './config.js';

export interface FailureRecoveryContext {
  failedTaskId: string;
  failedWorkflowId: string;
  repoRoot: string;
  dbDir: string;
}

export interface RecoverySpawnOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv;
}

export type RecoverySpawnFn = (
  command: string,
  options: RecoverySpawnOptions,
) => void;

export interface ExternalFailureRecoveryDeps {
  /** Override for `Date.now()`. */
  now?: () => number;
  /** Override for process spawning; default uses `child_process.spawn` shell:true detached. */
  spawn?: RecoverySpawnFn;
  /** Base environment merged into the spawned process env. Defaults to process.env. */
  baseEnv?: NodeJS.ProcessEnv;
}

export type ExternalFailureRecoverySkipReason =
  | 'disabled'
  | 'missing-command'
  | 'cooldown';

export type ExternalFailureRecoveryResult =
  | { launched: true; launchedAtMs: number }
  | { launched: false; reason: ExternalFailureRecoverySkipReason };

/**
 * Build the env block forwarded to the recovery process. All five
 * INVOKER_* keys are set verbatim; the base env (default process.env) is
 * inherited so the script still sees PATH and friends.
 */
export function buildRecoveryEnv(
  context: FailureRecoveryContext,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    INVOKER_FAILED_TASK_ID: context.failedTaskId,
    INVOKER_FAILED_WORKFLOW_ID: context.failedWorkflowId,
    INVOKER_REPO_ROOT: context.repoRoot,
    INVOKER_DB_DIR: context.dbDir,
    INVOKER_RECOVERY_REASON: 'task_failed',
  };
}

function defaultSpawn(command: string, options: RecoverySpawnOptions): void {
  const child = spawn(command, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: 'ignore',
    shell: true,
  });
  child.unref();
}

export class ExternalFailureRecoveryLauncher {
  private readonly now: () => number;
  private readonly spawnFn: RecoverySpawnFn;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private lastLaunchMs: number | null = null;

  constructor(deps: ExternalFailureRecoveryDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.spawnFn = deps.spawn ?? defaultSpawn;
    this.baseEnv = deps.baseEnv ?? process.env;
  }

  launch(
    config: ExternalFailureRecoveryConfig | undefined,
    context: FailureRecoveryContext,
  ): ExternalFailureRecoveryResult {
    if (!config || !config.enabled) {
      return { launched: false, reason: 'disabled' };
    }
    const command = typeof config.command === 'string' ? config.command.trim() : '';
    if (command === '') {
      return { launched: false, reason: 'missing-command' };
    }
    const cooldownSeconds = config.cooldownSeconds ?? 0;
    const nowMs = this.now();
    if (
      cooldownSeconds > 0 &&
      this.lastLaunchMs !== null &&
      nowMs - this.lastLaunchMs < cooldownSeconds * 1000
    ) {
      return { launched: false, reason: 'cooldown' };
    }
    const env = buildRecoveryEnv(context, this.baseEnv);
    this.spawnFn(command, { cwd: config.cwd, env });
    this.lastLaunchMs = nowMs;
    return { launched: true, launchedAtMs: nowMs };
  }
}
