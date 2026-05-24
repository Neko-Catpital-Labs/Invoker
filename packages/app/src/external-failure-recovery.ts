/**
 * External failure recovery launcher.
 *
 * Spawns the operator-configured supervisor command when a task fails and
 * passes failure context via INVOKER_* environment variables. Kept dormant
 * in this task: callers opt in by creating a launcher and invoking it from
 * failed-delta handling separately.
 */

import { spawn } from 'node:child_process';

import type { ExternalFailureRecoveryConfig } from './config.js';

export type { ExternalFailureRecoveryConfig } from './config.js';

export interface ExternalFailureRecoveryContext {
  taskId: string;
  workflowId: string;
  repoRoot: string;
  dbDir: string;
}

export type ExternalFailureRecoverySkipReason =
  | 'disabled'
  | 'missing-command'
  | 'cooldown';

export type ExternalFailureRecoveryResult =
  | { launched: true }
  | { launched: false; reason: ExternalFailureRecoverySkipReason };

export interface ExternalFailureRecoverySpawnOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv;
}

export type ExternalFailureRecoverySpawn = (
  command: string,
  options: ExternalFailureRecoverySpawnOptions,
) => void;

export interface ExternalFailureRecoveryDeps {
  /** Launch the configured shell command. Receives the fully built env. */
  spawn: ExternalFailureRecoverySpawn;
  /** Monotonic-ish clock used for cooldown bookkeeping. */
  now: () => number;
  /** Optional base environment. Defaults to `process.env` at call time. */
  baseEnv?: NodeJS.ProcessEnv;
}

export type ExternalFailureRecoveryLauncher = (
  context: ExternalFailureRecoveryContext,
) => ExternalFailureRecoveryResult;

/**
 * Build the env block handed to the supervisor process. Exported so callers
 * (and tests) can inspect the exact INVOKER_* variables without spawning.
 */
export function buildExternalFailureRecoveryEnv(
  context: ExternalFailureRecoveryContext,
  baseEnv: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    INVOKER_FAILED_TASK_ID: context.taskId,
    INVOKER_FAILED_WORKFLOW_ID: context.workflowId,
    INVOKER_REPO_ROOT: context.repoRoot,
    INVOKER_DB_DIR: context.dbDir,
    INVOKER_RECOVERY_REASON: 'task_failed',
  };
}

/**
 * Create a launcher bound to a single config + dep set. The returned closure
 * keeps cooldown state across calls so multiple failed tasks share one window.
 */
export function createExternalFailureRecoveryLauncher(
  config: ExternalFailureRecoveryConfig | undefined,
  deps: ExternalFailureRecoveryDeps,
): ExternalFailureRecoveryLauncher {
  let lastLaunchMs: number | null = null;

  return (context) => {
    if (!config || config.enabled !== true) {
      return { launched: false, reason: 'disabled' };
    }

    const rawCommand = typeof config.command === 'string' ? config.command.trim() : '';
    if (rawCommand === '') {
      return { launched: false, reason: 'missing-command' };
    }

    const cooldownSec =
      typeof config.cooldownSeconds === 'number' && Number.isFinite(config.cooldownSeconds)
        ? Math.max(0, config.cooldownSeconds)
        : 0;

    if (cooldownSec > 0 && lastLaunchMs !== null) {
      const elapsedMs = deps.now() - lastLaunchMs;
      if (elapsedMs < cooldownSec * 1000) {
        return { launched: false, reason: 'cooldown' };
      }
    }

    const env = buildExternalFailureRecoveryEnv(context, deps.baseEnv ?? process.env);
    deps.spawn(rawCommand, { cwd: config.cwd, env });
    lastLaunchMs = deps.now();
    return { launched: true };
  };
}

/**
 * Default spawn implementation: detached shell launch with stdio ignored so
 * the supervisor outlives the Invoker process. Provided for production wiring;
 * tests should inject a fake spawn instead.
 */
export const defaultExternalFailureRecoverySpawn: ExternalFailureRecoverySpawn = (
  command,
  options,
) => {
  const child = spawn(command, [], {
    cwd: options.cwd,
    env: options.env,
    shell: true,
    detached: true,
    stdio: 'ignore',
  });
  child.once('error', (err) => {
    process.stderr.write(
      `[external-failure-recovery] spawn error: ${err.message}\n`,
    );
  });
  child.unref();
};
