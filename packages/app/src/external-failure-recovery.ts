/**
 * External failure-recovery launcher.
 *
 * Launches an operator-configured command as a detached external process when
 * a task fails, so failures can be routed to a supervisor script while the
 * built-in "Fix with AI" flow stays available.
 *
 * Time and process-launch are injected so cooldown behaviour is deterministic
 * and unit-testable. This module is intentionally dormant: nothing in this
 * task wires failed-task deltas to `ExternalFailureRecoveryLauncher`.
 */

import { spawn } from 'node:child_process';
import type { ExternalFailureRecoveryConfig } from './config.js';

/** Context describing the failed task that triggered recovery. */
export interface FailureRecoveryContext {
  /** ID of the task that failed. */
  failedTaskId: string;
  /** ID of the workflow that owns the failed task. */
  failedWorkflowId: string;
  /** Absolute path to the repository root. */
  repoRoot: string;
  /** Absolute path to the Invoker database directory. */
  dbDir: string;
}

/** Reason a launch attempt did or did not proceed. */
export type LaunchSkipReason = 'disabled' | 'no-command' | 'cooldown';

/** Outcome of a single launch attempt. */
export interface LaunchResult {
  launched: boolean;
  /** Populated only when `launched` is false. */
  reason?: LaunchSkipReason;
}

/** Returns the current time in milliseconds (injectable for tests). */
export type Clock = () => number;

/** Launches the external recovery command (injectable for tests). */
export type ProcessLauncher = (
  command: string,
  options: { cwd?: string; env: NodeJS.ProcessEnv },
) => void;

/**
 * Build the environment variables passed to the recovery command. The keys
 * are fixed by contract; callers must not rename them.
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

/**
 * Default launcher: spawn the command via a shell as a detached process so it
 * outlives the Invoker process and does not block the caller.
 */
const defaultProcessLauncher: ProcessLauncher = (command, options) => {
  const child = spawn(command, {
    cwd: options.cwd,
    env: options.env,
    shell: true,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
};

/**
 * Stateful launcher that enforces a configurable cooldown between launches.
 *
 * The cooldown clock and the process launcher are both injectable so tests can
 * advance time and assert launch behaviour without spawning real processes.
 */
export class ExternalFailureRecoveryLauncher {
  private readonly now: Clock;
  private readonly launchProcess: ProcessLauncher;
  private readonly baseEnv: NodeJS.ProcessEnv;
  /** Timestamp (ms) of the last successful launch, or null if never launched. */
  private lastLaunchAt: number | null = null;

  constructor(deps: {
    now: Clock;
    launchProcess?: ProcessLauncher;
    baseEnv?: NodeJS.ProcessEnv;
  }) {
    this.now = deps.now;
    this.launchProcess = deps.launchProcess ?? defaultProcessLauncher;
    this.baseEnv = deps.baseEnv ?? process.env;
  }

  /**
   * Attempt to launch the recovery command. Skips (without launching) when:
   * - the config is disabled,
   * - the command is empty/whitespace-only, or
   * - the cooldown window since the last launch has not elapsed.
   */
  tryLaunch(
    config: ExternalFailureRecoveryConfig | undefined,
    context: FailureRecoveryContext,
  ): LaunchResult {
    if (!config || config.enabled !== true) {
      return { launched: false, reason: 'disabled' };
    }

    const command = config.command?.trim();
    if (!command) {
      return { launched: false, reason: 'no-command' };
    }

    const now = this.now();
    const cooldownMs = Math.max(0, (config.cooldownSeconds ?? 0) * 1000);
    if (
      cooldownMs > 0 &&
      this.lastLaunchAt !== null &&
      now - this.lastLaunchAt < cooldownMs
    ) {
      return { launched: false, reason: 'cooldown' };
    }

    this.launchProcess(command, {
      cwd: config.cwd ?? context.repoRoot,
      env: buildRecoveryEnv(context, this.baseEnv),
    });
    this.lastLaunchAt = now;
    return { launched: true };
  }
}
