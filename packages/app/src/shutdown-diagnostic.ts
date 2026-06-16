import type { TaskState } from '@invoker/workflow-core';

export interface ShutdownDiagnosticDb {
  getOutputTail(taskId: string): Array<{ data: string }>;
  appendTaskOutput(taskId: string, data: string): void;
}

/** Max characters of recent output tail included in shutdown diagnostics. */
export const SHUTDOWN_DIAGNOSTIC_TAIL_CHARS = 4_000;

export interface PersistShutdownDiagnosticOptions {
  flushPendingOutput?: (taskId: string) => void;
  /**
   * The synthetic terminal-error string that will be written to the task
   * record alongside this diagnostic (e.g. "Application quit",
   * "Stopped by user"). Captured here so post-mortem inspection retains
   * the concrete reason in the durable output even after the coarse
   * `task.execution.error` field is overwritten.
   */
  syntheticError?: string;
  /**
   * Diagnostic block header label. Defaults to "Shutdown Diagnostic".
   * Use to distinguish e.g. user-stop vs application-quit if needed.
   */
  label?: string;
}

/**
 * Persist a compact diagnostic block into durable task output so that
 * post-mortem inspection retains concrete context instead of collapsing
 * to a coarse synthetic error like "Application quit" or "Stopped by user".
 *
 * Called from both headless and GUI shutdown paths before the synthetic
 * failure response is emitted.
 */
export function persistShutdownDiagnostic(
  task: TaskState,
  db: ShutdownDiagnosticDb,
  opts?: PersistShutdownDiagnosticOptions,
): void {
  try {
    // Flush any buffered output so the spool is up-to-date.
    opts?.flushPendingOutput?.(task.id);

    // Gather the most recent output tail from the output spool.
    const tailChunks = db.getOutputTail(task.id);
    let tail = tailChunks.map(c => c.data).join('');
    if (tail.length > SHUTDOWN_DIAGNOSTIC_TAIL_CHARS) {
      tail = '...' + tail.slice(tail.length - SHUTDOWN_DIAGNOSTIC_TAIL_CHARS);
    }

    const label = opts?.label ?? 'Shutdown Diagnostic';
    const parts: string[] = [`\n[${label}]`];
    parts.push(`status=${task.status}`);
    if (opts?.syntheticError) {
      parts.push(`syntheticError=${opts.syntheticError}`);
    }
    if (task.execution.error) {
      parts.push(`error=${task.execution.error}`);
    }
    if (task.execution.exitCode !== undefined && task.execution.exitCode !== null) {
      parts.push(`exitCode=${task.execution.exitCode}`);
    }
    if (tail) {
      parts.push(`--- recent output tail ---\n${tail}`);
    }
    parts.push('--- end shutdown diagnostic ---\n');
    db.appendTaskOutput(task.id, parts.join('\n'));
  } catch {
    // Best-effort: don't let diagnostic persistence block shutdown.
  }
}
