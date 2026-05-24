/**
 * External failure-recovery launcher.
 *
 * Spawns an operator-configured recovery command when a task fails. The
 * helper is intentionally dormant: callers must wire it into failed-task
 * delta handling separately. Manual "Fix with AI" flows continue to work
 * regardless of this hook.
 *
 * The launch is gated by configuration (`enabled` + non-empty `command`)
 * and an optional cooldown. Time and process-launch dependencies can be
 * injected so unit tests stay deterministic and side-effect free.
 */

import { spawn } from 'node:child_process';
import type { ExternalFailureRecoveryConfig } from './config.js';

export interface ExternalFailureRecoveryContext {
  taskId: string;
  workflowId: string;
  repoRoot: string;
  dbDir: string;
}

export type ExternalFailureRecoverySkipReason =
  | 'disabled'
  | 'missing_command'
  | 'cooldown';

export type ExternalFailureRecoveryOutcome =
  | { launched: true }
  | { launched: false; reason: ExternalFailureRecoverySkipReason };

export interface ExternalFailureRecoveryLaunchArgs {
  command: string;
  cwd?: string;
  env: NodeJS.ProcessEnv;
}

export interface ExternalFailureRecoveryDeps {
  /** Monotonic clock source in milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** Process-launch hook. Defaults to a detached `spawn` with shell. */
  launchProcess?: (args: ExternalFailureRecoveryLaunchArgs) => void;
  /** Base environment merged into the spawn env. Defaults to `process.env`. */
  baseEnv?: NodeJS.ProcessEnv;
}

export interface ExternalFailureRecoveryLauncher {
  launch(context: ExternalFailureRecoveryContext): ExternalFailureRecoveryOutcome;
}

/**
 * Build the env block forwarded to the recovery command. The recovery
 * reason is fixed to `task_failed` for this hook; other reasons can be
 * added later without breaking the existing contract.
 */
export function buildExternalFailureRecoveryEnv(
  context: ExternalFailureRecoveryContext,
  baseEnv: NodeJS.ProcessEnv = process.env,
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

export function createExternalFailureRecoveryLauncher(
  config: ExternalFailureRecoveryConfig | undefined,
  deps: ExternalFailureRecoveryDeps = {},
): ExternalFailureRecoveryLauncher {
  const now = deps.now ?? (() => Date.now());
  const launchProcess = deps.launchProcess ?? defaultLaunchProcess;
  const baseEnv = deps.baseEnv ?? process.env;
  let lastLaunchAtMs: number | null = null;

  return {
    launch(context): ExternalFailureRecoveryOutcome {
      if (!config || config.enabled !== true) {
        return { launched: false, reason: 'disabled' };
      }
      const command = typeof config.command === 'string' ? config.command.trim() : '';
      if (command.length === 0) {
        return { launched: false, reason: 'missing_command' };
      }
      const cooldownSeconds = config.cooldownSeconds ?? 0;
      const nowMs = now();
      if (cooldownSeconds > 0 && lastLaunchAtMs !== null) {
        const elapsedMs = nowMs - lastLaunchAtMs;
        if (elapsedMs < cooldownSeconds * 1000) {
          return { launched: false, reason: 'cooldown' };
        }
      }
      const env = buildExternalFailureRecoveryEnv(context, baseEnv);
      launchProcess({ command, cwd: config.cwd, env });
      lastLaunchAtMs = nowMs;
      return { launched: true };
    },
  };
}

function defaultLaunchProcess(args: ExternalFailureRecoveryLaunchArgs): void {
  const child = spawn(args.command, {
    cwd: args.cwd,
    env: args.env,
    shell: true,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}
