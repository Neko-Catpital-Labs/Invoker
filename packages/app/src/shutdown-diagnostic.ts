import type { TaskState } from '@invoker/workflow-core';

export interface ShutdownDiagnosticDb {
  getOutputTail(taskId: string): Array<{ data: string }>;
  appendTaskOutput(taskId: string, data: string): void;
}

/** Max characters of recent output tail included in shutdown diagnostics. */
export const SHUTDOWN_DIAGNOSTIC_TAIL_CHARS = 4_000;

/**
 * Persist a compact diagnostic block into durable task output so that
 * post-mortem inspection retains concrete context instead of collapsing
 * to "Application quit".
 *
 * Called from both headless and GUI shutdown paths before the synthetic
 * failure response is emitted.
 *
 * When the caller is about to apply a synthetic terminal failure (e.g. the
 * owner is quitting and will overwrite `task.execution.error` with a coarse
 * label like "Application quit"), pass the synthetic context via
 * `terminalFailure` so the diagnostic block records both the concrete
 * pre-shutdown state and the synthetic state that will replace it.
 */
export function persistShutdownDiagnostic(
  task: TaskState,
  db: ShutdownDiagnosticDb,
  opts?: {
    flushPendingOutput?: (taskId: string) => void;
    terminalFailure?: { error?: string; exitCode?: number | null; reason?: string };
  },
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

    const parts: string[] = ['\n[Shutdown Diagnostic]'];
    parts.push(`status=${task.status}`);
    if (task.execution.error) {
      parts.push(`error=${task.execution.error}`);
    }
    if (task.execution.exitCode !== undefined && task.execution.exitCode !== null) {
      parts.push(`exitCode=${task.execution.exitCode}`);
    }
    const synthetic = opts?.terminalFailure;
    if (synthetic) {
      if (synthetic.reason) parts.push(`synthetic.reason=${synthetic.reason}`);
      if (synthetic.error) parts.push(`synthetic.error=${synthetic.error}`);
      if (synthetic.exitCode !== undefined && synthetic.exitCode !== null) {
        parts.push(`synthetic.exitCode=${synthetic.exitCode}`);
      }
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
