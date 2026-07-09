import { spawn } from 'node:child_process';

/**
 * A single external command the PR-maintenance backend needs to run
 * (`gh`, `git`, `omp`, `run.sh`, `node headless-ipc.js`, ...). Every process
 * the native backend spawns flows through {@link PrMaintenanceCommandRunner},
 * so tests inject one fake runner instead of stubbing individual binaries.
 */
export interface PrMaintenanceCommandSpec {
  command: string;
  args: string[];
  /** Working directory for the child. Defaults to the current process cwd. */
  cwd?: string;
  /** Environment for the child. Defaults to the current process environment. */
  env?: NodeJS.ProcessEnv;
  /** Wall-clock ms before the child is terminated; `undefined` means no bound. */
  timeoutMs?: number;
  /** Grace period after SIGTERM before the child is SIGKILLed. Default 60s. */
  killAfterMs?: number;
}

/** Outcome of running one {@link PrMaintenanceCommandSpec}. */
export interface PrMaintenanceCommandResult {
  /** Exit code, or `null` when the child was killed by a signal or never spawned. */
  code: number | null;
  /** Terminating signal, or `null`. */
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** True when the child was killed because it exceeded `timeoutMs`. */
  timedOut: boolean;
  /** Set when the child could not be spawned at all. */
  spawnError?: Error;
}

/** Runs one external command and resolves with its captured result. Never rejects. */
export type PrMaintenanceCommandRunner = (
  spec: PrMaintenanceCommandSpec,
) => Promise<PrMaintenanceCommandResult>;

const DEFAULT_KILL_AFTER_MS = 60_000;

/**
 * Default runner: spawn the command, capture stdout/stderr, and resolve with a
 * {@link PrMaintenanceCommandResult}. A spawn error resolves (not rejects) with
 * `spawnError` set so callers branch on the result instead of try/catch.
 */
export function spawnPrMaintenanceCommand(
  spec: PrMaintenanceCommandSpec,
): Promise<PrMaintenanceCommandResult> {
  return new Promise<PrMaintenanceCommandResult>((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const clearTimers = (): void => {
      clearTimeout(killTimer);
      clearTimeout(sigkillTimer);
    };

    const settle = (result: PrMaintenanceCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolvePromise(result);
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    if (spec.timeoutMs !== undefined && spec.timeoutMs > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        sigkillTimer = setTimeout(() => {
          child.kill('SIGKILL');
        }, spec.killAfterMs ?? DEFAULT_KILL_AFTER_MS);
        sigkillTimer.unref?.();
      }, spec.timeoutMs);
      killTimer.unref?.();
    }

    child.once('error', (err: Error) => {
      settle({ code: null, signal: null, stdout, stderr, timedOut, spawnError: err });
    });

    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      settle({ code, signal, stdout, stderr, timedOut });
    });
  });
}
