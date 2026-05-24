/**
 * External failure recovery launcher.
 *
 * Spawns an operator-configured command when a failed workflow task is
 * observed, leaving manual "Fix with AI" untouched. This module owns the
 * typed launcher helper only; wiring it into the failure-delta pipeline is
 * intentionally deferred so the hook stays dormant until callers opt in.
 *
 * Time and process-launch dependencies are injectable so cooldown logic and
 * environment construction can be exercised deterministically in unit tests.
 */

import { spawn } from 'node:child_process';

import type { ExternalFailureRecoveryConfig } from './config.js';

export type { ExternalFailureRecoveryConfig } from './config.js';

export interface ExternalFailureRecoveryContext {
  failedTaskId: string;
  failedWorkflowId: string;
  repoRoot: string;
  dbDir: string;
}

export type ExternalFailureRecoverySkipReason =
  | 'disabled'
  | 'no_command'
  | 'cooldown';

export type ExternalFailureRecoveryResult =
  | { launched: true }
  | { launched: false; reason: ExternalFailureRecoverySkipReason };

export interface LaunchOptions {
  command: string;
  cwd?: string;
  env: NodeJS.ProcessEnv;
}

export type ExternalProcessLauncher = (options: LaunchOptions) => void;

export interface LauncherDeps {
  /** Returns the current time in ms since epoch. Defaults to `Date.now`. */
  now?: () => number;
  /** Spawns the configured command. Defaults to a detached `spawn` call. */
  launch?: ExternalProcessLauncher;
  /** Base environment forwarded to the recovery process. Defaults to `process.env`. */
  baseEnv?: NodeJS.ProcessEnv;
}

export interface ExternalFailureRecoveryLauncher {
  trigger(context: ExternalFailureRecoveryContext): ExternalFailureRecoveryResult;
}

/**
 * Build the environment passed to the recovery process. Keys are spelled
 * verbatim so external scripts can rely on stable names.
 */
export function buildRecoveryEnv(
  context: ExternalFailureRecoveryContext,
  baseEnv: NodeJS.ProcessEnv = {},
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

function defaultLaunch({ command, cwd, env }: LaunchOptions): void {
  const child = spawn(command, [], {
    cwd,
    env,
    shell: true,
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', (err) => {
    process.stderr.write(
      `[external-failure-recovery] spawn error: ${err.message}\n`,
    );
  });
  child.unref();
}

export function createExternalFailureRecoveryLauncher(
  config: ExternalFailureRecoveryConfig | undefined,
  deps: LauncherDeps = {},
): ExternalFailureRecoveryLauncher {
  const now = deps.now ?? Date.now;
  const launch = deps.launch ?? defaultLaunch;
  const baseEnv = deps.baseEnv ?? process.env;
  let lastLaunchedAtMs: number | null = null;

  return {
    trigger(context: ExternalFailureRecoveryContext): ExternalFailureRecoveryResult {
      if (!config || config.enabled !== true) {
        return { launched: false, reason: 'disabled' };
      }
      const command = config.command?.trim();
      if (!command) {
        return { launched: false, reason: 'no_command' };
      }
      const cooldownMs = Math.max(0, (config.cooldownSeconds ?? 0) * 1000);
      if (cooldownMs > 0 && lastLaunchedAtMs !== null) {
        if (now() < lastLaunchedAtMs + cooldownMs) {
          return { launched: false, reason: 'cooldown' };
        }
      }
      launch({
        command,
        cwd: config.cwd,
        env: buildRecoveryEnv(context, baseEnv),
      });
      lastLaunchedAtMs = now();
      return { launched: true };
    },
  };
}
