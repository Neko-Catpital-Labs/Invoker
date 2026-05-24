/**
 * External failure recovery launcher.
 *
 * Spawns an operator-configured command as a detached process when a task
 * fails, forwarding failure context via environment variables. The helper
 * is dormant until callers wire it into failed-task delta handling — this
 * module only owns the config gating, env construction, and cooldown.
 *
 * Time and process-launch dependencies are injected so the cooldown logic
 * stays deterministic under test.
 */

import { spawn, type SpawnOptions } from 'node:child_process';
import type { InvokerConfig } from './config.js';

export interface ExternalFailureRecoveryContext {
  failedTaskId: string;
  failedWorkflowId: string;
  repoRoot: string;
  dbDir: string;
}

export type ExternalFailureRecoveryReason = 'skipped_disabled'
  | 'skipped_missing_command'
  | 'skipped_cooldown'
  | 'launched'
  | 'launch_error';

export interface ExternalFailureRecoveryResult {
  launched: boolean;
  reason: ExternalFailureRecoveryReason;
  /** Error message when reason is 'launch_error'. */
  error?: string;
}

export interface ExternalFailureRecoverySpawnOptions {
  command: string;
  cwd?: string;
  env: NodeJS.ProcessEnv;
}

export type ExternalFailureRecoverySpawn = (
  options: ExternalFailureRecoverySpawnOptions,
) => void;

export interface ExternalFailureRecoveryDeps {
  /** Returns the current epoch milliseconds. Defaults to Date.now. */
  now?: () => number;
  /** Launches the configured command. Defaults to a detached spawn. */
  spawn?: ExternalFailureRecoverySpawn;
}

/**
 * Build the env-var payload forwarded to the recovery command. Caller env
 * is preserved verbatim; the INVOKER_* keys overwrite any colliding values.
 */
export function buildExternalFailureRecoveryEnv(
  context: ExternalFailureRecoveryContext,
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

function defaultDetachedSpawn(options: ExternalFailureRecoverySpawnOptions): void {
  const spawnOptions: SpawnOptions = {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: 'ignore',
    shell: true,
  };
  const child = spawn(options.command, spawnOptions);
  child.on('error', (err) => {
    process.stderr.write(
      `[external-failure-recovery] spawn error: ${err.message}\n`,
    );
  });
  child.unref();
}

/**
 * Tracks the last successful launch timestamp so cooldown decisions stay
 * deterministic. Callers hold one instance for the lifetime of a process.
 */
export class ExternalFailureRecoveryLauncher {
  private lastLaunchedAtMs: number | null = null;
  private readonly now: () => number;
  private readonly spawnFn: ExternalFailureRecoverySpawn;

  constructor(deps: ExternalFailureRecoveryDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.spawnFn = deps.spawn ?? defaultDetachedSpawn;
  }

  /**
   * Returns the last successful launch timestamp in epoch milliseconds, or
   * `null` when no launch has occurred. Exposed for diagnostics/tests.
   */
  getLastLaunchedAtMs(): number | null {
    return this.lastLaunchedAtMs;
  }

  /**
   * Launch the recovery command for a failed task. Returns a structured
   * result describing whether a launch occurred and, if not, why.
   */
  launch(
    config: InvokerConfig,
    context: ExternalFailureRecoveryContext,
    baseEnv: NodeJS.ProcessEnv = process.env,
  ): ExternalFailureRecoveryResult {
    const recovery = config.externalFailureRecovery;
    if (!recovery || recovery.enabled !== true) {
      return { launched: false, reason: 'skipped_disabled' };
    }
    const command = typeof recovery.command === 'string' ? recovery.command.trim() : '';
    if (command === '') {
      return { launched: false, reason: 'skipped_missing_command' };
    }
    const cooldownMs = Math.max(0, (recovery.cooldownSeconds ?? 0) * 1000);
    const now = this.now();
    if (
      cooldownMs > 0
      && this.lastLaunchedAtMs !== null
      && now - this.lastLaunchedAtMs < cooldownMs
    ) {
      return { launched: false, reason: 'skipped_cooldown' };
    }

    const env = buildExternalFailureRecoveryEnv(context, baseEnv);
    try {
      this.spawnFn({ command, cwd: recovery.cwd, env });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { launched: false, reason: 'launch_error', error: message };
    }
    this.lastLaunchedAtMs = now;
    return { launched: true, reason: 'launched' };
  }
}
