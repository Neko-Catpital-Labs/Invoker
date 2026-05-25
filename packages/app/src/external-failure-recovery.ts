/**
 * External failure-recovery launcher.
 *
 * Reads the optional `externalFailureRecovery` config block and, when
 * enabled, launches the configured command as a detached subprocess with
 * a fixed set of `INVOKER_*` environment variables describing the failed
 * task. This module owns *only* the launch decision and process spawn —
 * it does not subscribe to failed-task deltas. Wiring to failure events
 * is intentionally deferred.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { InvokerConfig } from './config.js';

export interface ExternalFailureRecoveryContext {
  failedTaskId: string;
  failedWorkflowId: string;
  repoRoot: string;
  dbDir: string;
}

export type ExternalFailureRecoveryReason = 'task_failed';

export interface ExternalFailureRecoveryEnv {
  INVOKER_FAILED_TASK_ID: string;
  INVOKER_FAILED_WORKFLOW_ID: string;
  INVOKER_REPO_ROOT: string;
  INVOKER_DB_DIR: string;
  INVOKER_RECOVERY_REASON: ExternalFailureRecoveryReason;
}

export type LaunchSkipReason =
  | 'no_config'
  | 'disabled'
  | 'empty_command'
  | 'cooldown';

export type LaunchResult =
  | { launched: true; pid: number | undefined }
  | { launched: false; reason: LaunchSkipReason };

/**
 * Minimal spawn signature so tests can inject a fake without dragging in
 * the full Node child-process surface area.
 */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => Pick<ChildProcess, 'pid' | 'unref'>;

export interface LaunchDeps {
  /** Returns the current time in milliseconds since the epoch. */
  now: () => number;
  /** Spawns the configured command. Defaults to `child_process.spawn`. */
  spawn?: SpawnFn;
}

/** Build the exact `INVOKER_*` environment block passed to the child. */
export function buildRecoveryEnv(
  context: ExternalFailureRecoveryContext,
): ExternalFailureRecoveryEnv {
  return {
    INVOKER_FAILED_TASK_ID: context.failedTaskId,
    INVOKER_FAILED_WORKFLOW_ID: context.failedWorkflowId,
    INVOKER_REPO_ROOT: context.repoRoot,
    INVOKER_DB_DIR: context.dbDir,
    INVOKER_RECOVERY_REASON: 'task_failed',
  };
}

/**
 * Stateful launcher. Holds the timestamp of the last successful launch so
 * the `cooldownSeconds` window is enforced across calls. Operators
 * construct one launcher per process and reuse it across failed tasks.
 */
export class ExternalFailureRecoveryLauncher {
  private lastLaunchAtMs: number | null = null;
  private readonly spawnFn: SpawnFn;
  private readonly nowFn: () => number;

  constructor(private readonly deps: LaunchDeps) {
    this.nowFn = deps.now;
    this.spawnFn = deps.spawn ?? (spawn as unknown as SpawnFn);
  }

  /**
   * Attempt to launch the configured command for the given failed task.
   * Returns a structured result describing whether a child was spawned
   * and, if not, why it was skipped.
   */
  launch(
    config: InvokerConfig,
    context: ExternalFailureRecoveryContext,
  ): LaunchResult {
    const recovery = config.externalFailureRecovery;
    if (!recovery) return { launched: false, reason: 'no_config' };
    if (!recovery.enabled) return { launched: false, reason: 'disabled' };

    const command = recovery.command?.trim() ?? '';
    if (command === '') return { launched: false, reason: 'empty_command' };

    const cooldownSeconds = recovery.cooldownSeconds;
    if (
      typeof cooldownSeconds === 'number' &&
      cooldownSeconds > 0 &&
      this.lastLaunchAtMs !== null
    ) {
      const elapsedMs = this.nowFn() - this.lastLaunchAtMs;
      if (elapsedMs < cooldownSeconds * 1000) {
        return { launched: false, reason: 'cooldown' };
      }
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...buildRecoveryEnv(context),
    };

    const spawnOptions: SpawnOptions = {
      cwd: recovery.cwd,
      env,
      detached: true,
      stdio: 'ignore',
    };

    const child = this.spawnFn(command, [], spawnOptions);
    child.unref?.();
    this.lastLaunchAtMs = this.nowFn();
    return { launched: true, pid: child.pid };
  }
}
