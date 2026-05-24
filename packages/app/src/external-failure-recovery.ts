/**
 * External failure recovery launcher.
 *
 * Spawns an operator-configured command (see `InvokerConfig.externalFailureRecovery`)
 * after a task transitions to `failed`, passing context via environment variables:
 *
 *   INVOKER_FAILED_TASK_ID
 *   INVOKER_FAILED_WORKFLOW_ID
 *   INVOKER_REPO_ROOT
 *   INVOKER_DB_DIR
 *   INVOKER_RECOVERY_REASON=task_failed
 *
 * The helper is intentionally dormant: nothing in the orchestrator routes
 * failed-delta events here yet. Wiring is left to a follow-up task so the
 * config + launcher can land + be tested in isolation.
 *
 * Manual "Fix with AI" is unaffected — this hook runs alongside it.
 */

import { spawn as nodeSpawn } from 'node:child_process';

import type { ExternalFailureRecoveryConfig } from './config.js';

export interface FailureRecoveryContext {
  failedTaskId: string;
  failedWorkflowId: string;
  repoRoot: string;
  dbDir: string;
}

/**
 * Mutable state held by the caller across launches so the cooldown can
 * span multiple invocations of `launchExternalFailureRecovery`.
 */
export interface RecoveryLauncherState {
  /** Millisecond timestamp of the last successful launch, or undefined if never launched. */
  lastLaunchMs?: number;
}

export type RecoverySpawnFn = (
  command: string,
  options: { cwd?: string; env: NodeJS.ProcessEnv },
) => void;

export interface RecoveryLauncherDeps {
  /** Wall-clock source in milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** Process launcher. Defaults to a detached `child_process.spawn` via the system shell. */
  spawn?: RecoverySpawnFn;
}

export type RecoverySkipReason = 'disabled' | 'no_command' | 'cooldown';

export type RecoveryLaunchOutcome =
  | { launched: true; env: NodeJS.ProcessEnv; command: string; cwd?: string }
  | { launched: false; reason: RecoverySkipReason };

export function buildRecoveryEnv(
  context: FailureRecoveryContext,
  base: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...base,
    INVOKER_FAILED_TASK_ID: context.failedTaskId,
    INVOKER_FAILED_WORKFLOW_ID: context.failedWorkflowId,
    INVOKER_REPO_ROOT: context.repoRoot,
    INVOKER_DB_DIR: context.dbDir,
    INVOKER_RECOVERY_REASON: 'task_failed',
  };
}

const defaultSpawn: RecoverySpawnFn = (command, options) => {
  const child = nodeSpawn(command, {
    shell: true,
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
};

export function launchExternalFailureRecovery(
  config: ExternalFailureRecoveryConfig | undefined,
  context: FailureRecoveryContext,
  state: RecoveryLauncherState,
  deps: RecoveryLauncherDeps = {},
): RecoveryLaunchOutcome {
  if (!config?.enabled) {
    return { launched: false, reason: 'disabled' };
  }

  const command = config.command?.trim();
  if (!command) {
    return { launched: false, reason: 'no_command' };
  }

  const now = deps.now ?? Date.now;
  const cooldownSeconds = Math.max(0, config.cooldownSeconds ?? 0);
  if (cooldownSeconds > 0 && state.lastLaunchMs !== undefined) {
    const elapsedMs = now() - state.lastLaunchMs;
    if (elapsedMs < cooldownSeconds * 1000) {
      return { launched: false, reason: 'cooldown' };
    }
  }

  const env = buildRecoveryEnv(context, process.env);
  const spawn = deps.spawn ?? defaultSpawn;
  spawn(command, { cwd: config.cwd, env });
  state.lastLaunchMs = now();

  return { launched: true, env, command, cwd: config.cwd };
}
