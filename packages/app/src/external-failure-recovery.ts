/**
 * External failure recovery launcher.
 *
 * Reads `externalFailureRecovery` from {@link InvokerConfig} and spawns the
 * configured supervisor command when a workflow task fails. Wiring is left
 * dormant: this module exposes a helper that callers may invoke from a
 * failed-task delta handler in a follow-up change.
 *
 * The helper is deterministic and unit-testable: time and process launch are
 * injected so tests can assert env construction, disabled behavior,
 * missing-command skip, and cooldown skip without touching the real clock or
 * spawning child processes.
 */

import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import type { InvokerConfig } from './config.js';

export interface ExternalFailureRecoveryContext {
  failedTaskId: string;
  failedWorkflowId: string;
  repoRoot: string;
  dbDir: string;
}

export type ExternalFailureRecoveryReason = 'task_failed';

export type RecoveryLaunchOutcome =
  | { launched: true }
  | { launched: false; reason: 'disabled' | 'missing_command' | 'cooldown' | 'spawn_error'; detail?: string };

/** Minimal spawn signature so tests can inject a fake. */
export type RecoverySpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => { unref?: () => void };

export interface ExternalFailureRecoveryDeps {
  /** Current time in milliseconds; defaults to Date.now. */
  now?: () => number;
  /** Process launcher; defaults to node:child_process spawn. */
  spawnFn?: RecoverySpawnFn;
}

/**
 * Build the environment variable map passed to the external recovery process.
 *
 * Variable names match the contract documented in the failure-recovery
 * design: any rename here is a breaking change for operator scripts.
 */
export function buildRecoveryEnv(
  context: ExternalFailureRecoveryContext,
  reason: ExternalFailureRecoveryReason = 'task_failed',
  baseEnv: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    INVOKER_FAILED_TASK_ID: context.failedTaskId,
    INVOKER_FAILED_WORKFLOW_ID: context.failedWorkflowId,
    INVOKER_REPO_ROOT: context.repoRoot,
    INVOKER_DB_DIR: context.dbDir,
    INVOKER_RECOVERY_REASON: reason,
  };
}

/**
 * Stateful launcher that enforces the configured cooldown across calls.
 *
 * Construct once per process (or per orchestrator scope) so the
 * lastLaunchedAtMs state is shared across failed-task deltas.
 */
export class ExternalFailureRecoveryLauncher {
  private lastLaunchedAtMs: number | null = null;
  private readonly now: () => number;
  private readonly spawnFn: RecoverySpawnFn;

  constructor(deps: ExternalFailureRecoveryDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.spawnFn = deps.spawnFn ?? (nodeSpawn as unknown as RecoverySpawnFn);
  }

  /** Visible for tests; lets a suite seed the cooldown clock. */
  setLastLaunchedAtMs(ms: number | null): void {
    this.lastLaunchedAtMs = ms;
  }

  launch(
    config: InvokerConfig,
    context: ExternalFailureRecoveryContext,
    reason: ExternalFailureRecoveryReason = 'task_failed',
    baseEnv: NodeJS.ProcessEnv = process.env,
  ): RecoveryLaunchOutcome {
    const recovery = config.externalFailureRecovery;
    if (!recovery || recovery.enabled !== true) {
      return { launched: false, reason: 'disabled' };
    }
    const command = typeof recovery.command === 'string' ? recovery.command.trim() : '';
    if (command === '') {
      return { launched: false, reason: 'missing_command' };
    }
    const cooldownMs = Math.max(0, (recovery.cooldownSeconds ?? 0) * 1000);
    const nowMs = this.now();
    if (cooldownMs > 0 && this.lastLaunchedAtMs !== null) {
      const elapsed = nowMs - this.lastLaunchedAtMs;
      if (elapsed < cooldownMs) {
        return {
          launched: false,
          reason: 'cooldown',
          detail: `cooldown active: ${cooldownMs - elapsed}ms remaining`,
        };
      }
    }
    const env = buildRecoveryEnv(context, reason, baseEnv);
    try {
      const child = this.spawnFn(command, [], {
        cwd: recovery.cwd,
        env,
        detached: true,
        stdio: 'ignore',
      });
      child.unref?.();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { launched: false, reason: 'spawn_error', detail };
    }
    this.lastLaunchedAtMs = nowMs;
    return { launched: true };
  }
}
