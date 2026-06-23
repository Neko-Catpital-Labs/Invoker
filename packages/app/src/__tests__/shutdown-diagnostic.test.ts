import { describe, it, expect, vi } from 'vitest';
import type { TaskState } from '@invoker/workflow-core';
import {
  persistShutdownDiagnostic,
  persistStartupFailureDiagnostic,
  SHUTDOWN_DIAGNOSTIC_TAIL_CHARS,
  STARTUP_FAILURE_DIAGNOSTIC_LABEL,
  type ShutdownDiagnosticDb,
} from '../shutdown-diagnostic.js';

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'task-1',
    description: 'test task',
    status: 'running',
    dependencies: [],
    createdAt: new Date(),
    config: {},
    execution: {},
    ...overrides,
  } as TaskState;
}

function makeDb(tailData: string[] = []): ShutdownDiagnosticDb & { appended: string[] } {
  const appended: string[] = [];
  return {
    appended,
    getOutputTail: () => tailData.map((d, i) => ({ data: d, offset: i })),
    appendTaskOutput: (_taskId: string, data: string) => {
      appended.push(data);
    },
  };
}

describe('persistShutdownDiagnostic', () => {
  it('appends a diagnostic block with status', () => {
    const task = makeTask({ status: 'running' });
    const db = makeDb();

    persistShutdownDiagnostic(task, db);

    expect(db.appended).toHaveLength(1);
    const output = db.appended[0];
    expect(output).toContain('[Shutdown Diagnostic]');
    expect(output).toContain('status=running');
    expect(output).toContain('--- end shutdown diagnostic ---');
  });

  it('includes execution error when present', () => {
    const task = makeTask({
      status: 'running',
      execution: { error: 'npm test failed with exit code 1' },
    });
    const db = makeDb();

    persistShutdownDiagnostic(task, db);

    const output = db.appended[0];
    expect(output).toContain('error=npm test failed with exit code 1');
  });

  it('includes exitCode when present', () => {
    const task = makeTask({
      status: 'running',
      execution: { exitCode: 42 },
    });
    const db = makeDb();

    persistShutdownDiagnostic(task, db);

    const output = db.appended[0];
    expect(output).toContain('exitCode=42');
  });

  it('includes recent output tail from spool', () => {
    const task = makeTask();
    const db = makeDb(['line 1\n', 'line 2\n', 'FAIL src/foo.test.ts\n']);

    persistShutdownDiagnostic(task, db);

    const output = db.appended[0];
    expect(output).toContain('--- recent output tail ---');
    expect(output).toContain('line 1');
    expect(output).toContain('line 2');
    expect(output).toContain('FAIL src/foo.test.ts');
  });

  it('truncates output tail exceeding the character limit', () => {
    const task = makeTask();
    const longChunk = 'x'.repeat(SHUTDOWN_DIAGNOSTIC_TAIL_CHARS + 500);
    const db = makeDb([longChunk]);

    persistShutdownDiagnostic(task, db);

    const output = db.appended[0];
    expect(output).toContain('...');
    // The tail portion should be at most SHUTDOWN_DIAGNOSTIC_TAIL_CHARS long
    const tailStart = output.indexOf('--- recent output tail ---');
    const tailEnd = output.indexOf('--- end shutdown diagnostic ---');
    const tailSection = output.slice(tailStart, tailEnd);
    // 3 for '...' prefix + SHUTDOWN_DIAGNOSTIC_TAIL_CHARS + header line
    expect(tailSection.length).toBeLessThan(SHUTDOWN_DIAGNOSTIC_TAIL_CHARS + 200);
  });

  it('omits output tail section when spool is empty', () => {
    const task = makeTask();
    const db = makeDb([]);

    persistShutdownDiagnostic(task, db);

    const output = db.appended[0];
    expect(output).not.toContain('--- recent output tail ---');
    expect(output).toContain('[Shutdown Diagnostic]');
    expect(output).toContain('--- end shutdown diagnostic ---');
  });

  it('flushes pending output before capturing tail', () => {
    const task = makeTask();
    const flushOrder: string[] = [];
    const db = makeDb(['flushed data\n']);
    const origAppend = db.appendTaskOutput.bind(db);
    db.appendTaskOutput = (taskId: string, data: string) => {
      flushOrder.push('append');
      origAppend(taskId, data);
    };
    const flushPendingOutput = (taskId: string) => {
      flushOrder.push(`flush:${taskId}`);
    };

    persistShutdownDiagnostic(task, db, { flushPendingOutput });

    expect(flushOrder[0]).toBe('flush:task-1');
    expect(flushOrder[1]).toBe('append');
  });

  it('does not throw when db.appendTaskOutput fails', () => {
    const task = makeTask();
    const db: ShutdownDiagnosticDb = {
      getOutputTail: () => [],
      appendTaskOutput: () => {
        throw new Error('DB write failed');
      },
    };

    expect(() => persistShutdownDiagnostic(task, db)).not.toThrow();
  });

  it('does not throw when db.getOutputTail fails', () => {
    const db: ShutdownDiagnosticDb = {
      getOutputTail: () => {
        throw new Error('DB read failed');
      },
      appendTaskOutput: vi.fn(),
    };

    expect(() => persistShutdownDiagnostic(makeTask(), db)).not.toThrow();
  });

  it('handles fixing_with_ai status', () => {
    const task = makeTask({ status: 'fixing_with_ai' as any });
    const db = makeDb();

    persistShutdownDiagnostic(task, db);

    const output = db.appended[0];
    expect(output).toContain('status=fixing_with_ai');
  });

  it('records forcedStopReason in the diagnostic block', () => {
    // Forced-stop reasons like "Application quit" or "Stopped by user" are
    // emitted via handleWorkerResponse after the diagnostic is appended.
    // Capturing them here preserves the concrete terminal reason in durable
    // task output for post-mortem retrieval, instead of leaving only a coarse
    // collapsed marker.
    const task = makeTask({
      status: 'running',
      execution: { error: 'real runtime error message' },
    });
    const db = makeDb(['streaming output\n']);

    persistShutdownDiagnostic(task, db, { forcedStopReason: 'Application quit' });

    const output = db.appended[0];
    expect(output).toContain('forcedStopReason=Application quit');
    expect(output).toContain('error=real runtime error message');
    expect(output).toContain('streaming output');
  });

  it('records forcedStopReason when execution.error is absent', () => {
    const task = makeTask({ status: 'running', execution: {} });
    const db = makeDb();

    persistShutdownDiagnostic(task, db, { forcedStopReason: 'Stopped by user' });

    const output = db.appended[0];
    expect(output).toContain('forcedStopReason=Stopped by user');
    expect(output).not.toContain('error=');
  });

  it('honours a custom label override', () => {
    const task = makeTask();
    const db = makeDb();

    persistShutdownDiagnostic(task, db, { label: 'Startup Failure Diagnostic' });

    const output = db.appended[0];
    expect(output).toContain('[Startup Failure Diagnostic]');
  });

  it('omits forcedStopReason line when not provided', () => {
    const task = makeTask({ execution: { error: 'real error' } });
    const db = makeDb();

    persistShutdownDiagnostic(task, db);

    const output = db.appended[0];
    expect(output).not.toContain('forcedStopReason=');
    expect(output).toContain('error=real error');
  });

  it('records failureDetail as a detail line', () => {
    const task = makeTask({ status: 'running', execution: {} });
    const db = makeDb(['startup stderr tail\n']);

    persistShutdownDiagnostic(task, db, {
      failureDetail: 'Executor startup failed (worktree): missing repoUrl',
    });

    const output = db.appended[0];
    expect(output).toContain('detail=Executor startup failed (worktree): missing repoUrl');
    expect(output).toContain('startup stderr tail');
  });

  it('omits the detail line when failureDetail is not provided', () => {
    const task = makeTask({ execution: { error: 'real error' } });
    const db = makeDb();

    persistShutdownDiagnostic(task, db);

    const output = db.appended[0];
    expect(output).not.toContain('detail=');
  });
});

describe('persistStartupFailureDiagnostic', () => {
  it('labels the block as a startup failure and keeps the concrete detail and tail', () => {
    const task = makeTask({ status: 'running', execution: {} });
    const db = makeDb(['FAIL src/startup.test.ts\n']);

    persistStartupFailureDiagnostic(task, db, {
      forcedStopReason: 'Executor startup failed (worktree)',
      failureDetail: 'Executor startup failed (worktree): boom',
    });

    const output = db.appended[0];
    expect(output).toContain(`[${STARTUP_FAILURE_DIAGNOSTIC_LABEL}]`);
    expect(output).toContain('forcedStopReason=Executor startup failed (worktree)');
    expect(output).toContain('detail=Executor startup failed (worktree): boom');
    expect(output).toContain('FAIL src/startup.test.ts');
  });

  it('lets an explicit label override the startup default', () => {
    const task = makeTask();
    const db = makeDb();

    persistStartupFailureDiagnostic(task, db, { label: 'Custom Label' });

    expect(db.appended[0]).toContain('[Custom Label]');
  });
});
