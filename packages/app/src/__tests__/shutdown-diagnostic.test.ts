import { describe, it, expect } from 'vitest';
import type { TaskState } from '@invoker/workflow-core';
import type { TaskFailureDiagnosticOptions } from '@invoker/data-store';
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

interface RecordingDb extends ShutdownDiagnosticDb {
  calls: Array<{ taskId: string; opts: TaskFailureDiagnosticOptions }>;
}

function makeDb(): RecordingDb {
  const calls: Array<{ taskId: string; opts: TaskFailureDiagnosticOptions }> = [];
  return {
    calls,
    appendFailureDiagnostic: (taskId, opts) => {
      calls.push({ taskId, opts });
    },
  };
}

describe('persistShutdownDiagnostic', () => {
  it('delegates to appendFailureDiagnostic with the task status', () => {
    const task = makeTask({ status: 'running' });
    const db = makeDb();

    persistShutdownDiagnostic(task, db);

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].taskId).toBe('task-1');
    expect(db.calls[0].opts.status).toBe('running');
  });

  it('defaults the diagnostic reason to "app-shutdown"', () => {
    const db = makeDb();
    persistShutdownDiagnostic(makeTask(), db);
    expect(db.calls[0].opts.reason).toBe('app-shutdown');
  });

  it('propagates an explicit reason override', () => {
    const db = makeDb();
    persistShutdownDiagnostic(makeTask(), db, { reason: 'forced-stop' });
    expect(db.calls[0].opts.reason).toBe('forced-stop');
  });

  it('forwards the synthetic shutdown message verbatim', () => {
    const db = makeDb();
    persistShutdownDiagnostic(makeTask(), db, { message: 'Application quit' });
    expect(db.calls[0].opts.message).toBe('Application quit');
  });

  it('includes execution error when present', () => {
    const task = makeTask({
      status: 'running',
      execution: { error: 'npm test failed with exit code 1' },
    });
    const db = makeDb();

    persistShutdownDiagnostic(task, db);

    expect(db.calls[0].opts.error).toBe('npm test failed with exit code 1');
  });

  it('includes exitCode when present', () => {
    const task = makeTask({
      status: 'running',
      execution: { exitCode: 42 },
    });
    const db = makeDb();

    persistShutdownDiagnostic(task, db);

    expect(db.calls[0].opts.exitCode).toBe(42);
  });

  it('requests inline output tail with the standard char limit', () => {
    const db = makeDb();
    persistShutdownDiagnostic(makeTask(), db);
    expect(db.calls[0].opts.includeOutputTail).toBe(true);
    expect(db.calls[0].opts.tailCharLimit).toBe(SHUTDOWN_DIAGNOSTIC_TAIL_CHARS);
  });

  it('flushes pending output before delegating to the adapter', () => {
    const order: string[] = [];
    const db: ShutdownDiagnosticDb = {
      appendFailureDiagnostic: () => order.push('appendFailureDiagnostic'),
    };
    const flushPendingOutput = (taskId: string) => order.push(`flush:${taskId}`);

    persistShutdownDiagnostic(makeTask(), db, { flushPendingOutput });

    expect(order).toEqual(['flush:task-1', 'appendFailureDiagnostic']);
  });

  it('does not throw when appendFailureDiagnostic fails', () => {
    const db: ShutdownDiagnosticDb = {
      appendFailureDiagnostic: () => {
        throw new Error('DB write failed');
      },
    };

    expect(() => persistShutdownDiagnostic(makeTask(), db)).not.toThrow();
  });

  it('handles fixing_with_ai status', () => {
    const task = makeTask({ status: 'fixing_with_ai' as any });
    const db = makeDb();

    persistShutdownDiagnostic(task, db);

    expect(db.calls[0].opts.status).toBe('fixing_with_ai');
  });
});
