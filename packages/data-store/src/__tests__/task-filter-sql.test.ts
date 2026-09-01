import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTaskState, type TaskState } from '@invoker/workflow-core';
import type { TaskFilterNode } from '@invoker/contracts';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import { compileTaskFilter } from '../task-filter-sql.js';

describe('task filter SQL read path', () => {
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    for (const [id, deletedAt] of [['live-1', undefined], ['live-2', undefined], ['deleted', 1] as const]) {
      adapter.saveWorkflow({
        id,
        name: id,
        ...(deletedAt === undefined ? {} : { deletedAt }),
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
    }

    const seed = (workflowId: string, id: string, createdAt: string, overrides: Partial<TaskState> = {}) => {
      const task = createTaskState(id, id === 'live-1-task' ? 'needle description' : id, [], {
        workflowId,
        executionAgent: 'codex',
        executionModel: 'model-a',
        poolMemberId: 'member-1',
        repoUrl: 'https://example.test/repo',
        branch: 'main',
      });
      adapter.saveTask(workflowId, { ...task, createdAt: new Date(createdAt), ...overrides });
    };

    seed('live-1', 'live-1-task', '2026-01-01T00:00:00.000Z', {
      status: 'running',
      execution: {
        generation: 0,
        error: 'failure details',
        failureClass: 'liveness_stall',
        startedAt: new Date('2026-01-02T00:00:00.000Z'),
        lastHeartbeatAt: new Date('2026-01-03T00:00:00.000Z'),
      },
    });
    seed('live-2', 'live-2-task', '2026-01-02T00:00:00.000Z', {
      status: 'completed',
      config: { workflowId: 'live-2', isMergeNode: true },
      execution: { generation: 0, completedAt: new Date('2026-01-04T00:00:00.000Z') },
    });
    seed('deleted', 'deleted-task', '2026-01-03T00:00:00.000Z');
  });

  afterEach(() => adapter.close());

  it('compiles every node with fixed identifiers and bound values', () => {
    const filter: TaskFilterNode = {
      op: 'and',
      filters: [
        { op: 'exists', key: 'error' },
        { op: 'eq', key: 'status', value: 'running' },
        { op: 'in', key: 'execution_model', values: ['model-a', 'model-b'] },
        { op: 'contains', key: 'description', value: '100%_needle\\' },
        { op: 'time_range', key: 'created_at', start: '2026-01-01T00:00:00.000Z', end: '2026-01-02T00:00:00.000Z' },
        { op: 'or', filters: [{ op: 'eq', key: 'is_merge_node', value: true }, { op: 'eq', key: 'is_merge_node', value: false }] },
        { op: 'not', filter: { op: 'eq', key: 'branch', value: 'other' } },
      ],
    };
    const compiled = compileTaskFilter(filter);
    expect(compiled.where).toContain("t.description LIKE ? ESCAPE '\\'");
    expect(compiled.where).not.toContain('100%');
    expect(compiled.params).toEqual([
      'running', 'model-a', 'model-b', '%100\\%\\_needle\\\\%',
      '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 1, 0, 'other',
    ]);
  });

  it('executes leaf and logical nodes, orders by creation, and excludes deleted workflows', () => {
    expect(adapter.queryTasksByFilter({ op: 'exists', key: 'error' }).map((task) => task.id)).toEqual(['live-1-task']);
    expect(adapter.queryTasksByFilter({ op: 'eq', key: 'status', value: 'completed' }).map((task) => task.id)).toEqual(['live-2-task']);
    expect(adapter.queryTasksByFilter({ op: 'in', key: 'status', values: ['running', 'completed'] }).map((task) => task.id)).toEqual(['live-1-task', 'live-2-task']);
    expect(adapter.queryTasksByFilter({ op: 'contains', key: 'description', value: 'needle' }).map((task) => task.id)).toEqual(['live-1-task']);
    expect(adapter.queryTasksByFilter({ op: 'time_range', key: 'created_at', end: '2026-01-01T23:59:59.000Z' }).map((task) => task.id)).toEqual(['live-1-task']);
    expect(adapter.queryTasksByFilter({ op: 'eq', key: 'is_merge_node', value: true }).map((task) => task.id)).toEqual(['live-2-task']);
    expect(adapter.queryTasksByFilter({ op: 'and', filters: [{ op: 'eq', key: 'status', value: 'running' }, { op: 'eq', key: 'workflow_id', value: 'live-1' }] }).map((task) => task.id)).toEqual(['live-1-task']);
    expect(adapter.queryTasksByFilter({ op: 'or', filters: [{ op: 'eq', key: 'id', value: 'live-2-task' }, { op: 'eq', key: 'id', value: 'live-1-task' }] }).map((task) => task.id)).toEqual(['live-1-task', 'live-2-task']);
    expect(adapter.queryTasksByFilter({ op: 'not', filter: { op: 'eq', key: 'status', value: 'running' } }).map((task) => task.id)).toEqual(['live-2-task']);
    expect(adapter.queryTasksByFilter({ op: 'eq', key: 'id', value: "' OR 1=1 --" })).toEqual([]);
    expect(adapter.queryTasksByFilter({ op: 'in', key: 'workflow_id', values: ['deleted'] })).toEqual([]);
  });

  it('caps result limits at 500', () => {
    for (let i = 0; i < 505; i += 1) {
      const task = createTaskState(`bulk-${i}`, `bulk-${i}`, [], { workflowId: 'live-1' });
      adapter.saveTask('live-1', { ...task, createdAt: new Date(Date.parse('2026-02-01T00:00:00.000Z') + i * 1000) });
    }
    expect(adapter.queryTasksByFilter({ op: 'exists', key: 'description' }, { limit: 999 })).toHaveLength(500);
  });

  it('rejects unknown identifiers', () => {
    expect(() => compileTaskFilter({ op: 'eq', key: 'not_a_column' as never, value: 'x' })).toThrow('Unknown task filter key');
  });
});
