/**
 * Dormant external failure-recovery launcher.
 *
 * This module provides the typed contract and a standalone launcher helper for
 * handing a failed task off to an external supervisor process. It is intentionally
 * inert: nothing in the failed-task delta path calls into it yet. It exists so the
 * external process hook can be reviewed before failed-task routing is changed.
 *
 * See `InvokerConfig.externalFailureRecovery` in `config.ts` for the config shape.
 */

import { spawn as defaultSpawn } from 'node:child_process';
import type { InvokerConfig } from './config.js';

/** Resolved (non-optional wrapper) shape of the external recovery config block. */
export type ExternalFailureRecoveryConfig = NonNullable<
  InvokerConfig['externalFailureRecovery']
>;

/**
 * Identifying information about the failure that triggered a recovery launch.
 * Each field is exported to the spawned process as an `INVOKER_*` environment
 * variable (see {@link buildRecoveryEnv}).
 */
export interface RecoveryContext {
  /** ID of the failed task. Exported as INVOKER_FAILED_TASK_ID. */
  failedTaskId: string;
  /** ID of the workflow the failed task belongs to. Exported as INVOKER_FAILED_WORKFLOW_ID. */
  failedWorkflowId: string;
  /** Absolute path to the repository root. Exported as INVOKER_REPO_ROOT. */
  repoRoot: string;
  /** Directory containing the Invoker database. Exported as INVOKER_DB_DIR. */
  dbDir: string;
  /** Human-readable reason describing why recovery was requested. Exported as INVOKER_RECOVERY_REASON. */
  reason: string;
}

/**
 * Outcome of a single {@link ExternalRecoveryLauncher.launch} call.
 *
 * - `disabled`: config absent or `enabled !== true`.
 * - `missing-command`: enabled but no non-empty command configured.
 * - `cooldown`: a previous launch on this launcher instance is still within the cooldown window.
 * - `launched`: the recovery command was spawned.
 * - `spawn-error`: spawning threw synchronously.
 */
export type RecoveryLaunchResult =
  | { status: 'disabled' }
  | { status: 'missing-command' }
  | { status: 'cooldown'; remainingSeconds: number }
  | { status: 'launched'; pid?: number }
  | { status: 'spawn-error'; error: Error };

export interface ExternalRecoveryLauncher {
  /** Attempt to launch the configured recovery command for the given failure context. */
  launch(context: RecoveryContext): RecoveryLaunchResult;
}

export interface ExternalRecoveryLauncherOptions {
  /** The `externalFailureRecovery` block from `InvokerConfig`, if any. */
  config: ExternalFailureRecoveryConfig | undefined;
  /** Injectable spawn (defaults to `node:child_process` spawn). */
  spawn?: typeof defaultSpawn;
  /** Injectable monotonic-ish clock in milliseconds (defaults to `Date.now`). */
  now?: () => number;
  /** Base environment inherited by the spawned process (defaults to `process.env`). */
  baseEnv?: NodeJS.ProcessEnv;
}

/**
 * Build the environment for a recovery process: the inherited base env with the
 * failure-context `INVOKER_*` variables layered on top (recovery vars override).
 */
export function buildRecoveryEnv(
  context: RecoveryContext,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    INVOKER_FAILED_TASK_ID: context.failedTaskId,
    INVOKER_FAILED_WORKFLOW_ID: context.failedWorkflowId,
    INVOKER_REPO_ROOT: context.repoRoot,
    INVOKER_DB_DIR: context.dbDir,
    INVOKER_RECOVERY_REASON: context.reason,
  };
}

/**
 * Create a standalone external-recovery launcher.
 *
 * Cooldown is keyed by launcher instance: each launcher tracks the timestamp of
 * its own last successful launch and rejects further launches until
 * `cooldownSeconds` has elapsed. Separate launcher instances have independent
 * cooldown state.
 *
 * The returned launcher does not activate any failed-task path on its own; callers
 * must invoke `launch` explicitly.
 */
export function createExternalRecoveryLauncher(
  options: ExternalRecoveryLauncherOptions,
): ExternalRecoveryLauncher {
  const {
    config,
    spawn = defaultSpawn,
    now = () => Date.now(),
    baseEnv = process.env,
  } = options;

  // Cooldown state is private to this launcher instance.
  let lastLaunchAt: number | null = null;

  return {
    launch(context: RecoveryContext): RecoveryLaunchResult {
      if (!config || config.enabled !== true) {
        return { status: 'disabled' };
      }

      const command =
        typeof config.command === 'string' ? config.command.trim() : '';
      if (command === '') {
        return { status: 'missing-command' };
      }

      const cooldownSeconds = Math.max(0, config.cooldownSeconds ?? 0);
      const currentTime = now();
      if (cooldownSeconds > 0 && lastLaunchAt !== null) {
        const elapsedSeconds = (currentTime - lastLaunchAt) / 1000;
        if (elapsedSeconds < cooldownSeconds) {
          return {
            status: 'cooldown',
            remainingSeconds: Math.max(0, cooldownSeconds - elapsedSeconds),
          };
        }
      }

      const env = buildRecoveryEnv(context, baseEnv);
      try {
        const child = spawn(command, {
          shell: true,
          detached: true,
          stdio: 'ignore',
          cwd: config.cwd,
          env,
        });
        // Only successful spawns arm the cooldown so transient failures can retry.
        lastLaunchAt = currentTime;
        if (child && typeof child.unref === 'function') {
          child.unref();
        }
        return { status: 'launched', pid: child?.pid };
      } catch (error) {
        return {
          status: 'spawn-error',
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    },
  };
}
