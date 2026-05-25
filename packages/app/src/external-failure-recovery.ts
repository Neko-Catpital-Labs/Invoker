import { spawn } from 'node:child_process';
import type { InvokerConfig } from './config.js';

export interface RecoveryContext {
  taskId: string;
  workflowId: string;
  repoRoot: string;
  dbDir: string;
  reason: string;
}

export type RecoveryResult =
  | { status: 'disabled' }
  | { status: 'missing-command' }
  | { status: 'cooldown'; remainingMs: number }
  | { status: 'launched'; pid: number | undefined }
  | { status: 'spawn-error'; error: Error };

export function buildRecoveryEnv(
  context: RecoveryContext,
  baseEnv: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    ...baseEnv,
    INVOKER_FAILED_TASK_ID: context.taskId,
    INVOKER_FAILED_WORKFLOW_ID: context.workflowId,
    INVOKER_REPO_ROOT: context.repoRoot,
    INVOKER_DB_DIR: context.dbDir,
    INVOKER_RECOVERY_REASON: context.reason,
  };
}

export function createExternalRecoveryLauncher(
  config: InvokerConfig,
): (context: RecoveryContext, baseEnv?: Record<string, string | undefined>) => RecoveryResult {
  let lastLaunchMs = 0;

  return (context, baseEnv = {}) => {
    const recovery = config.externalFailureRecovery;
    if (!recovery?.enabled) {
      return { status: 'disabled' };
    }

    if (!recovery.command) {
      return { status: 'missing-command' };
    }

    const cooldownMs = (recovery.cooldownSeconds ?? 0) * 1000;
    if (cooldownMs > 0) {
      const elapsed = Date.now() - lastLaunchMs;
      if (elapsed < cooldownMs) {
        return { status: 'cooldown', remainingMs: cooldownMs - elapsed };
      }
    }

    try {
      const env = buildRecoveryEnv(context, baseEnv);
      const child = spawn(recovery.command, {
        shell: true,
        detached: true,
        stdio: 'ignore',
        cwd: recovery.cwd,
        env: env as NodeJS.ProcessEnv,
      });
      if (typeof child.unref === 'function') {
        child.unref();
      }
      lastLaunchMs = Date.now();
      return { status: 'launched', pid: child.pid };
    } catch (err) {
      return { status: 'spawn-error', error: err instanceof Error ? err : new Error(String(err)) };
    }
  };
}
