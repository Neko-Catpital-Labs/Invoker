import { describe, it, expect, vi } from 'vitest';
import type { TaskState } from '@invoker/workflow-core';
import {
  persistShutdownDiagnostic,
  SHUTDOWN_DIAGNOSTIC_TAIL_CHARS,
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

  it('records the synthetic terminal failure that will replace the live state', () => {
    // The owner shutdown path overwrites the live execution.error with
    // "Application quit". The diagnostic must preserve both the live
    // state and the synthetic-failure annotation so a post-mortem can
    // see the concrete pre-shutdown context alongside the coarse label.
    const task = makeTask({
      status: 'running',
      execution: { error: 'npm test failed (FAIL src/foo.test.ts > broke)' },
    });
    const db = makeDb(['some recent output\n']);

    persistShutdownDiagnostic(task, db, {
      terminalFailure: {
        error: 'Application quit',
        exitCode: 1,
        reason: 'gui before-quit',
      },
    });

    const output = db.appended[0];
    expect(output).toContain('error=npm test failed (FAIL src/foo.test.ts > broke)');
    expect(output).toContain('synthetic.error=Application quit');
    expect(output).toContain('synthetic.exitCode=1');
    expect(output).toContain('synthetic.reason=gui before-quit');
    expect(output).toContain('some recent output');
  });

  it('omits synthetic fields when terminalFailure is not provided', () => {
    const task = makeTask();
    const db = makeDb();

    persistShutdownDiagnostic(task, db);

    const output = db.appended[0];
    expect(output).not.toContain('synthetic.');
  });
});
