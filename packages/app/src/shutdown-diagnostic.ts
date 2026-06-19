import type { TaskState } from '@invoker/workflow-core';

export interface ShutdownDiagnosticDb {
  getOutputTail(taskId: string): Array<{ data: string }>;
  appendTaskOutput(taskId: string, data: string): void;
}

/** Max characters of recent output tail included in shutdown diagnostics. */
export const SHUTDOWN_DIAGNOSTIC_TAIL_CHARS = 4_000;

export interface PersistShutdownDiagnosticOptions {
  /** Flush any buffered output before capturing the spool tail. */
  flushPendingOutput?: (taskId: string) => void;
  /**
   * Short label identifying the call site (e.g. 'gui-before-quit',
   * 'headless-shutdown', 'executor-startup-failure'). Surfaces in the
   * persisted diagnostic block so post-mortem inspection can tell which
   * code path generated the entry.
   */
  reason?: string;
  /**
   * Optional concrete startup stderr/message captured at the call site.
   * Used by executor startup failure callers where the failure cause
   * lives outside the spool (e.g. a synchronous spawn throw).
   */
  startupError?: string;
}

/**
 * Persist a compact diagnostic block into durable task output so that
 * post-mortem inspection retains concrete context instead of collapsing
 * to "Application quit".
 *
 * Called from synthetic owner-shutdown paths (headless and GUI) and from
 * executor startup-failure paths before the synthetic failure response
 * is emitted. The block includes attempt/runner context, the pre-quit
 * `execution.error` (preserved from the actual failure, before
 * "Application quit" overwrites it), and the recent output tail.
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

    const header = opts?.reason
      ? `[Shutdown Diagnostic reason=${opts.reason}]`
      : '[Shutdown Diagnostic]';
    const parts: string[] = ['\n' + header];
    parts.push(`status=${task.status}`);
    if (task.execution.selectedAttemptId) {
      parts.push(`attemptId=${task.execution.selectedAttemptId}`);
    }
    if (task.execution.generation !== undefined) {
      parts.push(`generation=${task.execution.generation}`);
    }
    const runnerKind = (task.config as { runnerKind?: string }).runnerKind;
    if (runnerKind) {
      parts.push(`runnerKind=${runnerKind}`);
    }
    if (task.execution.workspacePath) {
      parts.push(`workspacePath=${task.execution.workspacePath}`);
    }
    if (task.execution.error) {
      parts.push(`error=${task.execution.error}`);
    }
    if (task.execution.exitCode !== undefined && task.execution.exitCode !== null) {
      parts.push(`exitCode=${task.execution.exitCode}`);
    }
    if (opts?.startupError) {
      parts.push(`--- startup error ---\n${opts.startupError}`);
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
