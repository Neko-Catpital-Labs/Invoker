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

  it('embeds the reason label in the diagnostic header when provided', () => {
    const task = makeTask();
    const db = makeDb();

    persistShutdownDiagnostic(task, db, { reason: 'headless-shutdown' });

    const output = db.appended[0];
    expect(output).toContain('[Shutdown Diagnostic reason=headless-shutdown]');
  });

  it('includes attemptId, generation, runnerKind, and workspacePath when present', () => {
    const task = makeTask({
      config: { runnerKind: 'ssh' } as any,
      execution: {
        generation: 7,
        selectedAttemptId: 'attempt-xyz',
        workspacePath: '/remote/work/dir',
      },
    });
    const db = makeDb();

    persistShutdownDiagnostic(task, db);

    const output = db.appended[0];
    expect(output).toContain('attemptId=attempt-xyz');
    expect(output).toContain('generation=7');
    expect(output).toContain('runnerKind=ssh');
    expect(output).toContain('workspacePath=/remote/work/dir');
  });

  it('omits attempt/runner/workspace fields when they are absent', () => {
    const task = makeTask({ execution: {} });
    const db = makeDb();

    persistShutdownDiagnostic(task, db);

    const output = db.appended[0];
    expect(output).not.toContain('attemptId=');
    expect(output).not.toContain('runnerKind=');
    expect(output).not.toContain('workspacePath=');
  });

  it('includes the explicit startup error message when provided', () => {
    const task = makeTask();
    const db = makeDb();

    persistShutdownDiagnostic(task, db, {
      reason: 'executor-startup-failure',
      startupError: 'posix_spawnp failed.',
    });

    const output = db.appended[0];
    expect(output).toContain('--- startup error ---');
    expect(output).toContain('posix_spawnp failed.');
    expect(output).toContain('reason=executor-startup-failure');
  });
});
