/**
 * Dormant external failure-recovery launcher.
 *
 * Provides a typed, side-effect-free way to hand a failed task off to an
 * out-of-process supervisor described by {@link ExternalFailureRecoveryConfig}.
 * Nothing in Invoker's failed-task delta handling calls this yet — the helper
 * exists so the external process contract (env handshake + spawn options +
 * cooldown semantics) can be reviewed before any routing change activates it.
 */

import { spawn, type SpawnOptions, type ChildProcess } from 'node:child_process';

import type { ExternalFailureRecoveryConfig } from './config.js';

/**
 * Identifying details about the failure handed to the external supervisor.
 * These map 1:1 onto the `INVOKER_*` environment variables in the launch env.
 */
export interface RecoveryContext {
  /** ID of the task that failed. */
  failedTaskId: string;
  /** ID of the workflow that owns the failed task. */
  failedWorkflowId: string;
  /** Absolute path to the repository root the task ran against. */
  repoRoot: string;
  /** Directory holding the Invoker SQLite database for this run. */
  dbDir: string;
  /** Human-readable reason the recovery hook was triggered. */
  reason: string;
}

/**
 * Build the environment for an external recovery process: the inherited
 * `baseEnv` with the `INVOKER_*` recovery handshake variables layered on top
 * (recovery values always win on key collisions).
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

/** Outcome of a single launcher invocation. Discriminated on `status`. */
export type RecoveryLaunchResult =
  /** Config absent or `enabled` is not true; nothing spawned. */
  | { status: 'disabled' }
  /** Recovery enabled but no (non-blank) `command` configured; nothing spawned. */
  | { status: 'missing-command' }
  /** A prior launch from this launcher is still inside the cooldown window. */
  | { status: 'cooldown'; remainingMs: number }
  /** Process spawned successfully. */
  | { status: 'launched'; pid: number | undefined }
  /** `spawn` threw synchronously (e.g. invalid cwd / shell missing). */
  | { status: 'spawn-error'; error: string };

/** A launcher: call it with a failure context to (maybe) spawn the supervisor. */
export type ExternalRecoveryLauncher = (
  context: RecoveryContext,
) => RecoveryLaunchResult;

/** Minimal spawn signature the launcher depends on (overridable in tests). */
export type SpawnFn = (
  command: string,
  options: SpawnOptions,
) => Pick<ChildProcess, 'pid' | 'unref'>;

export interface CreateLauncherOptions {
  /** Environment inherited by launched processes. Defaults to `process.env`. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Monotonic-ish clock for cooldown bookkeeping. Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable spawn (defaults to `node:child_process` spawn). For tests. */
  spawnFn?: SpawnFn;
}

/**
 * Create an external recovery launcher bound to `config`.
 *
 * Cooldown is keyed to the returned launcher *instance*: each call to this
 * factory gets its own independent last-launch timestamp, so two launchers
 * built from the same config never throttle each other.
 *
 * Successful launches use `shell: true`, `detached: true`, `stdio: 'ignore'`,
 * the configured `cwd`, and {@link buildRecoveryEnv} for the environment, then
 * `unref()` the child so it cannot keep the parent alive. Only successful
 * launches advance the cooldown clock.
 */
export function createExternalRecoveryLauncher(
  config: ExternalFailureRecoveryConfig | undefined,
  options: CreateLauncherOptions = {},
): ExternalRecoveryLauncher {
  const baseEnv = options.baseEnv ?? process.env;
  const now = options.now ?? Date.now;
  const spawnFn: SpawnFn = options.spawnFn ?? ((command, opts) => spawn(command, opts));

  // Cooldown state is private to this launcher instance.
  let lastLaunchAt: number | null = null;

  return function launch(context: RecoveryContext): RecoveryLaunchResult {
    if (!config?.enabled) {
      return { status: 'disabled' };
    }

    const command = config.command?.trim();
    if (!command) {
      return { status: 'missing-command' };
    }

    const cooldownMs = Math.max(0, (config.cooldownSeconds ?? 0) * 1000);
    if (cooldownMs > 0 && lastLaunchAt !== null) {
      const elapsed = now() - lastLaunchAt;
      if (elapsed < cooldownMs) {
        return { status: 'cooldown', remainingMs: cooldownMs - elapsed };
      }
    }

    try {
      const child = spawnFn(command, {
        shell: true,
        detached: true,
        stdio: 'ignore',
        cwd: config.cwd,
        env: buildRecoveryEnv(context, baseEnv),
      });
      if (typeof child.unref === 'function') {
        child.unref();
      }
      lastLaunchAt = now();
      return { status: 'launched', pid: child.pid };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: 'spawn-error', error: message };
    }
  };
}
