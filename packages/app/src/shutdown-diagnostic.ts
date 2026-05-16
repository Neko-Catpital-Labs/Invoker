import type { TaskState } from '@invoker/workflow-core';

export interface ShutdownDiagnosticDb {
  getOutputTail(taskId: string): Array<{ data: string }>;
  appendTaskOutput(taskId: string, data: string): void;
  appendDurableTaskOutput?(taskId: string, data: string): void;
}

/** Max characters of recent output tail included in shutdown diagnostics. */
export const SHUTDOWN_DIAGNOSTIC_TAIL_CHARS = 4_000;
export const STARTUP_DIAGNOSTIC_DETAIL_CHARS = 4_000;

function appendDurableDiagnostic(db: ShutdownDiagnosticDb, taskId: string, data: string): void {
  if (typeof db.appendDurableTaskOutput === 'function') {
    db.appendDurableTaskOutput(taskId, data);
    return;
  }
  db.appendTaskOutput(taskId, data);
}

function compactDetail(detail: string): string {
  if (detail.length <= STARTUP_DIAGNOSTIC_DETAIL_CHARS) {
    return detail;
  }
  return '...' + detail.slice(detail.length - STARTUP_DIAGNOSTIC_DETAIL_CHARS);
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
  opts?: { flushPendingOutput?: (taskId: string) => void },
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
    if (tail) {
      parts.push(`--- recent output tail ---\n${tail}`);
    }
    parts.push('--- end shutdown diagnostic ---\n');
    appendDurableDiagnostic(db, task.id, parts.join('\n'));
  } catch {
    // Best-effort: don't let diagnostic persistence block shutdown.
  }
}

export function persistStartupFailureDiagnostic(
  taskId: string,
  executorType: string,
  error: unknown,
  db: Pick<ShutdownDiagnosticDb, 'appendTaskOutput' | 'appendDurableTaskOutput'>,
): void {
  try {
    const message = error instanceof Error ? error.message : String(error);
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    const parts = [
      '\n[Startup Failure Diagnostic]',
      `executor=${executorType}`,
      `message=${message}`,
      '--- startup failure detail ---',
      compactDetail(detail),
      '--- end startup failure diagnostic ---\n',
    ];
    appendDurableDiagnostic(
      {
        getOutputTail: () => [],
        appendTaskOutput: db.appendTaskOutput.bind(db),
        appendDurableTaskOutput: db.appendDurableTaskOutput?.bind(db),
      },
      taskId,
      parts.join('\n'),
    );
  } catch {
    // Best-effort: preserve the original startup failure flow.
  }
}
