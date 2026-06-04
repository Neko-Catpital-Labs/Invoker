import { spawn as defaultSpawn } from 'node:child_process';
import type { InvokerConfig } from './config.js';

export type ExternalFailureRecoveryConfig = NonNullable<InvokerConfig['externalFailureRecovery']>;

export interface RecoveryContext {
  readonly failedTaskId: string;
  readonly failedWorkflowId: string;
  readonly repoRoot: string;
  readonly dbDir: string;
  readonly reason: string;
}

export type RecoveryLaunchResult =
  | { readonly status: 'disabled' }
  | { readonly status: 'missing-command' }
  | { readonly status: 'cooldown'; readonly remainingSeconds: number }
  | { readonly status: 'launched'; readonly pid?: number }
  | { readonly status: 'spawn-error'; readonly error: Error };

export interface ExternalRecoveryLauncher {
  launch(context: RecoveryContext): RecoveryLaunchResult;
}

export interface ExternalRecoveryLauncherOptions {
  readonly config: ExternalFailureRecoveryConfig | undefined | (() => ExternalFailureRecoveryConfig | undefined);
  readonly spawn?: typeof defaultSpawn;
  readonly now?: () => number;
  readonly baseEnv?: NodeJS.ProcessEnv;
}

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

export function createExternalRecoveryLauncher(
  options: ExternalRecoveryLauncherOptions,
): ExternalRecoveryLauncher {
  const {
    config: configSource,
    spawn = defaultSpawn,
    now = () => Date.now(),
    baseEnv = process.env,
  } = options;
  let lastLaunchAt: number | null = null;

  return {
    launch(context: RecoveryContext): RecoveryLaunchResult {
      const config = typeof configSource === 'function' ? configSource() : configSource;
      if (!config || config.enabled !== true) return { status: 'disabled' };

      const command = typeof config.command === 'string' ? config.command.trim() : '';
      if (command === '') return { status: 'missing-command' };

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

      try {
        const child = spawn(command, {
          shell: true,
          detached: true,
          stdio: 'ignore',
          cwd: config.cwd,
          env: buildRecoveryEnv(context, baseEnv),
        });
        lastLaunchAt = currentTime;
        child?.unref?.();
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
