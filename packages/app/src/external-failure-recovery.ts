/**
 * External failure-recovery launcher.
 *
 * Dormant helper: callers (e.g. failed-task delta handling) can ask this
 * module to launch a configured supervisor command when a task fails. The
 * in-app manual "Fix with AI" flow is unaffected — this is an additional
 * out-of-process hook for operators who want their own recovery script.
 *
 * Time and process-launch dependencies are injectable so tests can drive
 * the cooldown clock and observe spawn calls without touching real
 * processes.
 */

import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';

import type { ExternalFailureRecoveryConfig } from './config.js';

/** Per-failure context forwarded to the recovery process via env vars. */
export interface RecoveryContext {
  taskId: string;
  workflowId: string;
  repoRoot: string;
  dbDir: string;
}

export type RecoverySkipReason =
  | 'disabled'
  | 'missing-command'
  | 'cooldown'
  | 'spawn-error';

export type RecoveryLaunchResult =
  | { launched: true; pid: number | undefined }
  | { launched: false; reason: RecoverySkipReason; detail?: string };

/** Minimal child-process surface the launcher relies on. */
export type RecoverySpawnedChild = Pick<ChildProcess, 'pid' | 'unref'>;

export type RecoverySpawnFn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => RecoverySpawnedChild;

export interface RecoveryLauncherDeps {
  /** Monotonic-ish clock in ms; defaults to `Date.now`. */
  now?: () => number;
  /** Process launcher; defaults to `child_process.spawn`. */
  spawn?: RecoverySpawnFn;
  /** Base environment merged into the spawn env; defaults to `process.env`. */
  baseEnv?: NodeJS.ProcessEnv;
}

export interface ExternalRecoveryLauncher {
  launch(
    config: ExternalFailureRecoveryConfig | undefined,
    context: RecoveryContext,
  ): RecoveryLaunchResult;
}

/**
 * Build the exact env-var bag passed to the recovery process. Exposed for
 * tests and for callers that want to log what would be forwarded.
 */
export function buildRecoveryEnv(
  context: RecoveryContext,
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
 * Create a launcher with its own private cooldown clock. Each launcher
 * instance tracks the last successful launch independently, so callers
 * with different scopes can keep separate cooldown windows.
 */
export function createExternalRecoveryLauncher(
  deps: RecoveryLauncherDeps = {},
): ExternalRecoveryLauncher {
  const now = deps.now ?? Date.now;
  const spawn = deps.spawn ?? (nodeSpawn as unknown as RecoverySpawnFn);
  const baseEnv = deps.baseEnv ?? process.env;
  let lastLaunchMs: number | null = null;

  return {
    launch(config, context) {
      if (!config || !config.enabled) {
        return { launched: false, reason: 'disabled' };
      }

      const command = typeof config.command === 'string' ? config.command.trim() : '';
      if (command === '') {
        return { launched: false, reason: 'missing-command' };
      }

      const cooldownMs = Math.max(0, (config.cooldownSeconds ?? 0) * 1000);
      const tick = now();
      if (cooldownMs > 0 && lastLaunchMs !== null && tick - lastLaunchMs < cooldownMs) {
        return { launched: false, reason: 'cooldown' };
      }

      const env = buildRecoveryEnv(context, baseEnv);
      try {
        const child = spawn(command, [], {
          cwd: config.cwd,
          env,
          shell: true,
          detached: true,
          stdio: 'ignore',
        });
        child.unref?.();
        lastLaunchMs = tick;
        return { launched: true, pid: child.pid ?? undefined };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return { launched: false, reason: 'spawn-error', detail };
      }
    },
  };
}
