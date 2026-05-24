/**
 * External failure-recovery launcher.
 *
 * Spawns the operator-configured recovery command as a detached child process
 * so failed workflows can be routed to a supervisor script. The helper is
 * dormant — callers must opt in by invoking `launchExternalFailureRecovery`;
 * failed-task deltas are not yet wired to it.
 *
 * Time and process-launch dependencies are injectable to keep cooldown
 * behavior deterministic under unit test.
 */

import {
  spawn as defaultSpawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';
import type { ExternalFailureRecoveryConfig } from './config.js';

export interface ExternalFailureRecoveryContext {
  failedTaskId: string;
  failedWorkflowId: string;
  repoRoot: string;
  dbDir: string;
}

export type RecoverySkipReason =
  | 'disabled'
  | 'no_command'
  | 'cooldown'
  | 'spawn_error';

export type RecoveryLaunchOutcome =
  | { launched: true; pid: number | undefined }
  | { launched: false; reason: RecoverySkipReason; detail?: string };

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface RecoveryLauncherDeps {
  /** Override `child_process.spawn` for tests. */
  spawn?: SpawnFn;
  /** Override `Date.now` for deterministic cooldown tests. */
  now?: () => number;
  /** Base environment to overlay the recovery env vars onto. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface RecoveryLauncher {
  launch(context: ExternalFailureRecoveryContext): RecoveryLaunchOutcome;
}

/**
 * Build the env passed to the recovery command. Inherits the base env and
 * overlays the five INVOKER_* context keys; INVOKER_RECOVERY_REASON is always
 * `task_failed` for this code path.
 */
export function buildRecoveryEnv(
  context: ExternalFailureRecoveryContext,
  base: NodeJS.ProcessEnv = process.env,
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

function isCommandUsable(command: string | undefined): command is string {
  return typeof command === 'string' && command.trim() !== '';
}

/**
 * Create a stateful launcher. The returned object retains its last-launch
 * timestamp across calls so the cooldown window survives between invocations
 * for the same operator session.
 */
export function createExternalFailureRecoveryLauncher(
  config: ExternalFailureRecoveryConfig | undefined,
  deps: RecoveryLauncherDeps = {},
): RecoveryLauncher {
  const spawnFn = deps.spawn ?? (defaultSpawn as SpawnFn);
  const now = deps.now ?? Date.now;
  const baseEnv = deps.env ?? process.env;
  let lastLaunchAt: number | null = null;

  return {
    launch(context) {
      if (!config || config.enabled !== true) {
        return { launched: false, reason: 'disabled' };
      }
      if (!isCommandUsable(config.command)) {
        return { launched: false, reason: 'no_command' };
      }

      const cooldownMs = Math.max(0, (config.cooldownSeconds ?? 0) * 1000);
      const currentTime = now();
      if (
        cooldownMs > 0
        && lastLaunchAt !== null
        && currentTime - lastLaunchAt < cooldownMs
      ) {
        return { launched: false, reason: 'cooldown' };
      }

      const env = buildRecoveryEnv(context, baseEnv);
      const options: SpawnOptions = {
        env,
        cwd: config.cwd,
        detached: true,
        stdio: 'ignore',
        shell: true,
      };

      let child: ChildProcess;
      try {
        child = spawnFn(config.command, [], options);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return { launched: false, reason: 'spawn_error', detail };
      }

      lastLaunchAt = currentTime;
      try {
        child.unref?.();
      } catch {
        // unref is best-effort; ignore platforms/mocks without it.
      }
      return { launched: true, pid: child.pid };
    },
  };
}
