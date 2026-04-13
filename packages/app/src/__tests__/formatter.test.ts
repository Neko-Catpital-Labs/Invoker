import { describe, it, expect } from 'vitest';
import {
  formatTaskStatus,
  formatWorkflowStatus,
  formatEventLog,
  formatMutationQueueStatus,
  serializeWorkflow,
  serializeTask,
  serializeEvent,
  formatAsLabel,
  formatAsJson,
  formatAsJsonl,
} from '../formatter.js';
import type { TaskState } from '@invoker/workflow-core';
import type { TaskEvent, Workflow } from '@invoker/data-store';
import type { ActiveMutationPipeSnapshot } from '../mutation-pipe.js';

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

// ── formatMutationQueueStatus ───────────────────────────────

describe('formatMutationQueueStatus', () => {
  it('groups active mutation commands into the four sections', () => {
    const snapshot: ActiveMutationPipeSnapshot = {
      globalRunning: {
        id: 'mut-1',
        kind: 'headless.run',
        source: 'headless',
        workflowId: null,
        status: 'running',
        createdAt: '2026-04-13T10:00:00.000Z',
        startedAt: '2026-04-13T10:00:01.000Z',
      },
      workflowRunning: {
        'wf-1': {
          id: 'mut-2',
          kind: 'headless.exec',
          source: 'gui',
          workflowId: 'wf-1',
          status: 'running',
          createdAt: '2026-04-13T10:00:02.000Z',
          startedAt: '2026-04-13T10:00:03.000Z',
        },
      },
      globalQueued: [
        {
          id: 'mut-3',
          kind: 'headless.resume',
          source: 'headless',
          workflowId: null,
          status: 'queued',
          createdAt: '2026-04-13T10:00:04.000Z',
          startedAt: null,
        },
      ],
      queuedByWorkflow: {
        'wf-2': [
          {
            id: 'mut-4',
            kind: 'headless.exec',
            source: 'headless',
            workflowId: 'wf-2',
            status: 'queued',
            createdAt: '2026-04-13T10:00:05.000Z',
            startedAt: null,
          },
        ],
      },
    };

    const output = formatMutationQueueStatus(snapshot);
    expect(output).toContain('Global Running (1)');
    expect(output).toContain('Workflow Running (1)');
    expect(output).toContain('Global Queued (1)');
    expect(output).toContain('Workflow Queued (1)');
    expect(output).toContain('mut-1');
    expect(output).toContain('scope=workflow:wf-1');
    expect(output).toContain('startedAt=-');
  });

  it('renders empty sections predictably', () => {
    const output = formatMutationQueueStatus({
      globalRunning: null,
      workflowRunning: {},
      globalQueued: [],
      queuedByWorkflow: {},
    });
    expect(output).toContain('Global Running (0)');
    expect(output).toContain('(none)');
    expect(output).toContain('Workflow Queued (0)');
  });
});

// ── serializeWorkflow ───────────────────────────────────────

describe('serializeWorkflow', () => {
  const baseWorkflow: Workflow = {
    id: 'wf-123',
    name: 'Test Plan',
    status: 'running',
    createdAt: '2025-06-01T10:00:00Z',
    updatedAt: '2025-06-01T11:00:00Z',
  };

  it('returns plain object with required fields', () => {
    const result = serializeWorkflow(baseWorkflow);
    expect(result.id).toBe('wf-123');
    expect(result.name).toBe('Test Plan');
    expect(result.status).toBe('running');
    expect(result.createdAt).toBe('2025-06-01T10:00:00Z');
    expect(result.updatedAt).toBe('2025-06-01T11:00:00Z');
  });

  it('includes optional fields when present', () => {
    const wf: Workflow = {
      ...baseWorkflow,
      description: 'A test workflow',
      onFinish: 'pull_request',
      mergeMode: 'github' as Workflow['mergeMode'],
      baseBranch: 'master',
      featureBranch: 'feature/test',
      generation: 2,
    };
    const result = serializeWorkflow(wf);
    expect(result.description).toBe('A test workflow');
    expect(result.onFinish).toBe('pull_request');
    expect(result.mergeMode).toBe('github');
    expect(result.baseBranch).toBe('master');
    expect(result.featureBranch).toBe('feature/test');
    expect(result.generation).toBe(2);
  });

  it('omits undefined optional fields', () => {
    const result = serializeWorkflow(baseWorkflow);
    expect(result).not.toHaveProperty('description');
    expect(result).not.toHaveProperty('mergeMode');
    expect(result).not.toHaveProperty('generation');
  });

  it('produces valid JSON with no ANSI codes', () => {
    const json = JSON.stringify(serializeWorkflow(baseWorkflow));
    expect(json).not.toContain('\x1b');
    expect(() => JSON.parse(json)).not.toThrow();
  });
});

// ── serializeTask ───────────────────────────────────────────

describe('serializeTask', () => {
  it('returns plain object with required fields', () => {
    const task = makeTask({ id: 'wf-1/task-a', description: 'Run tests', status: 'completed' });
    const result = serializeTask(task);
    expect(result.id).toBe('wf-1/task-a');
    expect(result.description).toBe('Run tests');
    expect(result.status).toBe('completed');
    expect(result.dependencies).toEqual([]);
  });

  it('includes config subset when present', () => {
    const task = makeTask({
      config: {
        workflowId: 'wf-1',
        command: 'echo hi',
        executorType: 'worktree',
        isMergeNode: false,
        executionAgent: 'claude',
      } as TaskState['config'],
    });
    const result = serializeTask(task);
    const config = result.config as Record<string, unknown>;
    expect(config.workflowId).toBe('wf-1');
    expect(config.command).toBe('echo hi');
    expect(config.executorType).toBe('worktree');
    expect(config.isMergeNode).toBe(false);
    expect(config.executionAgent).toBe('claude');
  });

  it('includes execution subset when present', () => {
    const task = makeTask({
      execution: {
        branch: 'feature/test',
        commit: 'abc123',
        exitCode: 0,
        error: undefined,
      } as TaskState['execution'],
    });
    const result = serializeTask(task);
    const execution = result.execution as Record<string, unknown>;
    expect(execution.branch).toBe('feature/test');
    expect(execution.commit).toBe('abc123');
    expect(execution.exitCode).toBe(0);
    expect(execution).not.toHaveProperty('error');
  });

  it('converts Date fields to ISO strings', () => {
    const task = makeTask({
      createdAt: new Date('2025-06-01T10:00:00Z'),
      execution: {
        startedAt: new Date('2025-06-01T10:01:00Z'),
        completedAt: new Date('2025-06-01T10:05:00Z'),
      } as TaskState['execution'],
    });
    const result = serializeTask(task);
    expect(result.createdAt).toBe('2025-06-01T10:00:00.000Z');
    const execution = result.execution as Record<string, unknown>;
    expect(execution.startedAt).toBe('2025-06-01T10:01:00.000Z');
    expect(execution.completedAt).toBe('2025-06-01T10:05:00.000Z');
  });

  it('produces valid JSON', () => {
    const task = makeTask({ id: 'wf-1/task-a' });
    const json = JSON.stringify(serializeTask(task));
    expect(() => JSON.parse(json)).not.toThrow();
    expect(json).not.toContain('\x1b');
  });
});

// ── serializeEvent ──────────────────────────────────────────

describe('serializeEvent', () => {
  it('returns plain object with all fields', () => {
    const event: TaskEvent = {
      id: 1,
      taskId: 'task-1',
      eventType: 'started',
      payload: '{"info":"test"}',
      createdAt: '2025-01-01T00:00:00',
    };
    const result = serializeEvent(event);
    expect(result.id).toBe(1);
    expect(result.taskId).toBe('task-1');
    expect(result.eventType).toBe('started');
    expect(result.payload).toBe('{"info":"test"}');
    expect(result.createdAt).toBe('2025-01-01T00:00:00');
  });

  it('omits payload when undefined', () => {
    const event: TaskEvent = {
      id: 2,
      taskId: 'task-2',
      eventType: 'completed',
      createdAt: '2025-01-01T00:01:00',
    };
    const result = serializeEvent(event);
    expect(result).not.toHaveProperty('payload');
  });
});

// ── formatAsLabel ───────────────────────────────────────────

describe('formatAsLabel', () => {
  it('outputs one ID per line', () => {
    const items = [{ id: 'wf-1' }, { id: 'wf-2' }, { id: 'wf-3' }];
    const output = formatAsLabel(items);
    expect(output).toBe('wf-1\nwf-2\nwf-3');
  });

  it('returns empty string for empty array', () => {
    expect(formatAsLabel([])).toBe('');
  });

  it('returns single ID with no trailing newline', () => {
    expect(formatAsLabel([{ id: 'only-one' }])).toBe('only-one');
  });
});

// ── formatAsJson ────────────────────────────────────────────

describe('formatAsJson', () => {
  it('produces valid JSON for array input', () => {
    const data = [{ id: 'a' }, { id: 'b' }];
    const output = formatAsJson(data);
    expect(() => JSON.parse(output)).not.toThrow();
    expect(JSON.parse(output)).toEqual(data);
  });

  it('produces valid JSON for single object', () => {
    const data = { id: 'a', name: 'test' };
    const output = formatAsJson(data);
    expect(JSON.parse(output)).toEqual(data);
  });
});

// ── formatAsJsonl ───────────────────────────────────────────

describe('formatAsJsonl', () => {
  it('outputs one JSON object per line', () => {
    const items = [{ id: 'a' }, { id: 'b' }];
    const output = formatAsJsonl(items);
    const lines = output.split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ id: 'a' });
    expect(JSON.parse(lines[1])).toEqual({ id: 'b' });
  });

  it('each line is independently parseable', () => {
    const items = [{ x: 1 }, { x: 2 }, { x: 3 }];
    const lines = formatAsJsonl(items).split('\n');
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('returns empty string for empty array', () => {
    expect(formatAsJsonl([])).toBe('');
  });
});
