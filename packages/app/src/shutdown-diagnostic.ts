import type { TaskState } from '@invoker/workflow-core';
import type { TaskFailureDiagnosticOptions } from '@invoker/data-store';

/** Max characters of recent output tail included in shutdown diagnostics. */
export const SHUTDOWN_DIAGNOSTIC_TAIL_CHARS = 4_000;

/**
 * Minimal slice of the persistence adapter used by the shutdown-diagnostic
 * helper. Declared as a structural interface so tests can pass a lightweight
 * mock without instantiating SQLiteAdapter.
 */
export interface ShutdownDiagnosticDb {
  appendFailureDiagnostic(taskId: string, opts: TaskFailureDiagnosticOptions): void;
}

/**
 * Persist a compact diagnostic block into durable task output so that
 * post-mortem inspection retains concrete context instead of collapsing
 * to "Application quit".
 *
 * Called from both headless and GUI shutdown paths before the synthetic
 * failure response is emitted.
 */
export function persistShutdownDiagnostic(
  task: TaskState,
  db: ShutdownDiagnosticDb,
  opts?: {
    flushPendingOutput?: (taskId: string) => void;
    /**
     * Short identifier for the diagnostic reason — defaults to "app-shutdown".
     * Headless and GUI shutdown paths use the same default so durable output
     * keeps a single recognizable marker for synthetic shutdown failures.
     */
    reason?: string;
    /**
     * Concrete supplementary message to embed verbatim. The synthetic
     * shutdown handler sets this to the user-visible reason
     * (e.g. "Application quit") so the diagnostic block records why the
     * task was collapsed even when {@link TaskState.execution.error} is
     * empty.
     */
    message?: string;
  },
): void {
  try {
    opts?.flushPendingOutput?.(task.id);
    db.appendFailureDiagnostic(task.id, {
      reason: opts?.reason ?? 'app-shutdown',
      status: task.status,
      error: task.execution.error,
      exitCode: task.execution.exitCode ?? undefined,
      message: opts?.message,
      includeOutputTail: true,
      tailCharLimit: SHUTDOWN_DIAGNOSTIC_TAIL_CHARS,
    });
  } catch {
    // Best-effort: don't let diagnostic persistence block shutdown.
  }
}
