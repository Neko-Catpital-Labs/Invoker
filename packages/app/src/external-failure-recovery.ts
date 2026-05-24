/**
 * External failure recovery launcher.
 *
 * Provides a small, dependency-injectable helper that an operator can route
 * failed workflows through. The helper is dormant: callers must wire it into
 * failed-task delta handling separately. Manual "Fix with AI" flows are
 * unaffected.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { ExternalFailureRecoveryConfig } from './config.js';

/** Context describing the failure that triggered the recovery launch. */
export interface ExternalFailureRecoveryContext {
  taskId: string;
  workflowId: string;
  repoRoot: string;
  dbDir: string;
}

/**
 * Mutable cooldown state owned by the caller. The helper updates
 * `lastLaunchAtMs` on every successful launch.
 */
export interface ExternalFailureRecoveryState {
  lastLaunchAtMs?: number;
}

/** Injectable seams so tests can drive time and process launches. */
export interface ExternalFailureRecoveryDeps {
  /** Returns the current time in milliseconds. Defaults to Date.now. */
  now?: () => number;
  /** Process launcher. Defaults to node:child_process spawn. */
  spawn?: (
    command: string,
    options: SpawnOptions,
  ) => Pick<ChildProcess, 'pid' | 'unref'>;
}

export type ExternalFailureRecoverySkipReason =
  | 'disabled'
  | 'missing-command'
  | 'cooldown';

export type ExternalFailureRecoveryResult =
  | { launched: true; pid: number | undefined; env: NodeJS.ProcessEnv }
  | { launched: false; reason: ExternalFailureRecoverySkipReason };

const ENV_KEYS = {
  taskId: 'INVOKER_FAILED_TASK_ID',
  workflowId: 'INVOKER_FAILED_WORKFLOW_ID',
  repoRoot: 'INVOKER_REPO_ROOT',
  dbDir: 'INVOKER_DB_DIR',
  reason: 'INVOKER_RECOVERY_REASON',
} as const;

/**
 * Build the environment passed to the external recovery process. Layers the
 * recovery-specific keys on top of `baseEnv` so the script inherits the
 * parent's PATH and other ambient variables.
 */
export function buildExternalFailureRecoveryEnv(
  context: ExternalFailureRecoveryContext,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    [ENV_KEYS.taskId]: context.taskId,
    [ENV_KEYS.workflowId]: context.workflowId,
    [ENV_KEYS.repoRoot]: context.repoRoot,
    [ENV_KEYS.dbDir]: context.dbDir,
    [ENV_KEYS.reason]: 'task_failed',
  };
}

/**
 * Launch the configured external recovery command for a failed task.
 *
 * Returns `{ launched: false, reason }` without spawning anything when:
 *   - `config` is undefined or `enabled !== true`
 *   - `command` is missing or whitespace-only
 *   - the previous launch occurred less than `cooldownSeconds` ago
 *
 * Otherwise spawns the command detached with the recovery env vars layered
 * over `process.env`, records `lastLaunchAtMs` on `state`, and returns the
 * child pid.
 */
export function launchExternalFailureRecovery(
  config: ExternalFailureRecoveryConfig | undefined,
  context: ExternalFailureRecoveryContext,
  state: ExternalFailureRecoveryState,
  deps: ExternalFailureRecoveryDeps = {},
): ExternalFailureRecoveryResult {
  if (!config || config.enabled !== true) {
    return { launched: false, reason: 'disabled' };
  }
  const command = typeof config.command === 'string' ? config.command.trim() : '';
  if (command === '') {
    return { launched: false, reason: 'missing-command' };
  }

  const now = deps.now ?? Date.now;
  const cooldownSeconds = config.cooldownSeconds ?? 0;
  const nowMs = now();
  if (
    cooldownSeconds > 0 &&
    typeof state.lastLaunchAtMs === 'number' &&
    nowMs - state.lastLaunchAtMs < cooldownSeconds * 1000
  ) {
    return { launched: false, reason: 'cooldown' };
  }

  const env = buildExternalFailureRecoveryEnv(context);
  const spawnFn = deps.spawn ?? spawn;
  const child = spawnFn(command, {
    cwd: config.cwd,
    env,
    detached: true,
    stdio: 'ignore',
    shell: true,
  });
  child.unref?.();
  state.lastLaunchAtMs = nowMs;
  return { launched: true, pid: child.pid, env };
}
