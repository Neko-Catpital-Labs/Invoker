import { describe, it, expect } from 'vitest';
import {
  formatTaskStatus,
  formatWorkflowStatus,
  formatEventLog,
} from '../formatter.js';
import type { TaskState } from '@invoker/core';
import type { TaskEvent } from '@invoker/persistence';

// ── ANSI Code Constants ──────────────────────────────────────

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';

// ── Helpers ──────────────────────────────────────────────────

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'test-task',
    description: 'A test task',
    status: 'pending',
    dependencies: [],
    createdAt: new Date('2025-01-01'),
    config: {},
    execution: {},
    ...overrides,
  } as TaskState;
}

// ── formatTaskStatus ─────────────────────────────────────────

describe('formatTaskStatus', () => {
  it('shows correct color for completed status', () => {
    const task = makeTask({ status: 'completed' });
    const output = formatTaskStatus(task);
    expect(output).toContain(GREEN);
    expect(output).toContain('[completed]');
    expect(output).toContain(RESET);
  });

  it('shows correct color for failed status', () => {
    const task = makeTask({ status: 'failed' });
    const output = formatTaskStatus(task);
    expect(output).toContain(RED);
    expect(output).toContain('[failed]');
  });

  it('shows correct color for running status', () => {
    const task = makeTask({ status: 'running' });
    const output = formatTaskStatus(task);
    expect(output).toContain(YELLOW);
    expect(output).toContain('[running]');
  });

  it('shows correct color for needs_input status', () => {
    const task = makeTask({ status: 'needs_input' });
    const output = formatTaskStatus(task);
    expect(output).toContain(BLUE);
    expect(output).toContain('[needs_input]');
  });

  it('shows correct color for awaiting_approval status', () => {
    const task = makeTask({ status: 'awaiting_approval' });
    const output = formatTaskStatus(task);
    expect(output).toContain(CYAN);
    expect(output).toContain('[awaiting_approval]');
  });

  it('includes task id and description', () => {
    const task = makeTask({ id: 'my-task', description: 'Deploy to prod' });
    const output = formatTaskStatus(task);
    expect(output).toContain('my-task');
    expect(output).toContain('Deploy to prod');
  });
});

// ── formatWorkflowStatus ─────────────────────────────────────

describe('formatWorkflowStatus', () => {
  it('shows correct counts', () => {
    const status = {
      total: 5,
      completed: 2,
      failed: 1,
      running: 1,
      pending: 1,
    };
    const output = formatWorkflowStatus(status);
    expect(output).toContain('5 total');
    expect(output).toContain('2 completed');
    expect(output).toContain('1 failed');
    expect(output).toContain('1 running');
    expect(output).toContain('1 pending');
  });

  it('uses colored output', () => {
    const status = {
      total: 3,
      completed: 3,
      failed: 0,
      running: 0,
      pending: 0,
    };
    const output = formatWorkflowStatus(status);
    expect(output).toContain(GREEN);
    expect(output).toContain(RESET);
  });
});

// ── formatEventLog ───────────────────────────────────────────

describe('formatEventLog', () => {
  it('formats events in order', () => {
    const events: TaskEvent[] = [
      {
        id: 1,
        taskId: 'task-1',
        eventType: 'started',
        createdAt: '2025-01-01T00:00:00',
      },
      {
        id: 2,
        taskId: 'task-1',
        eventType: 'completed',
        payload: '{"exitCode": 0}',
        createdAt: '2025-01-01T00:01:00',
      },
    ];

    const output = formatEventLog(events);
    const lines = output.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('task-1');
    expect(lines[0]).toContain('started');
    expect(lines[1]).toContain('completed');
    expect(lines[1]).toContain('{"exitCode": 0}');
  });

  it('handles empty events', () => {
    const output = formatEventLog([]);
    expect(output).toContain('No events recorded');
  });
});
