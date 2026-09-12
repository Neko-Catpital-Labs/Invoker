import { afterEach, describe, expect, it } from 'vitest';
import type { TaskFilterNode } from '@invoker/contracts';
import type { TaskState } from '@invoker/workflow-core';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import type { Workflow } from '../adapter.js';
import { compileTaskFilter } from '../task-filter-sql.js';

describe('task filter SQL read path', () => {
  let adapter: SQLiteAdapter;

  afterEach(() => adapter?.close());

  function workflow(id: string, deletedAt?: number): Workflow {
    return {
      id,
      name: id,
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...(deletedAt === undefined ? {} : { deletedAt }),
    };
  }

  function task(id: string, workflowId: string, createdAt: string, overrides: Partial<TaskState> = {}): TaskState {
    return {
      id,
      description: `description ${id}`,
      status: 'pending',
      dependencies: [],
      createdAt: new Date(createdAt),
      config: { workflowId },
      execution: {},
      taskStateVersion: 1,
      ...overrides,
    };
  }

  async function seededAdapter(): Promise<SQLiteAdapter> {
    adapter = await SQLiteAdapter.create(':memory:');
    adapter.saveWorkflow(workflow('live-a'));
    adapter.saveWorkflow(workflow('live-b'));
    adapter.saveWorkflow(workflow('deleted', 1));
    adapter.saveTask('live-a', task('first', 'live-a', '2026-01-01T00:00:01.000Z', {
      description: 'Alpha worker',
      status: 'running',
      config: { workflowId: 'live-a', executionAgent: 'codex', isMergeNode: true, poolMemberId: 'pool-1' },
      execution: { startedAt: new Date('2026-01-01T00:00:02.000Z'), failureClass: 'timeout', branch: 'feature/alpha' },
    }));
    adapter.saveTask('live-b', task('second', 'live-b', '2026-01-01T00:00:03.000Z', {
      description: 'Beta worker',
      status: 'completed',
      config: { workflowId: 'live-b', executionModel: 'model-b', repoUrl: 'https://example.test/repo' },
      execution: { completedAt: new Date('2026-01-01T00:00:04.000Z'), error: 'finished' },
    }));
    adapter.saveTask('deleted', task('deleted-task', 'deleted', '2026-01-01T00:00:02.000Z', {
      description: 'Alpha deleted',
    }));
    return adapter;
  }

  it('compiles identifiers, values, logical nodes, contains escaping, and time ranges', async () => {
    await seededAdapter();
    const filter: TaskFilterNode = {
      op: 'and',
      filters: [
        { op: 'or', filters: [{ op: 'eq', key: 'status', value: 'running' }, { op: 'in', key: 'status', values: ['completed'] }] },
        { op: 'not', filter: { op: 'eq', key: 'id', value: 'nope' } },
        { op: 'exists', key: 'description' },
        { op: 'contains', key: 'description', value: 'Alpha' },
        { op: 'time_range', key: 'created_at', start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T00:00:03.000Z' },
      ],
    };
    const compiled = compileTaskFilter(filter);
    expect(compiled.where).toContain("ESCAPE '\\'");
    expect(compiled.params).toEqual(['running', 'completed', 'nope', '%Alpha%', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:03.000Z']);
    expect(adapter.queryTasksByFilter(filter).map((row) => row.id)).toEqual(['first']);
  });

  it('binds boolean values as SQLite integers and matches every leaf operation', async () => {
    await seededAdapter();
    expect(adapter.queryTasksByFilter({ op: 'eq', key: 'is_merge_node', value: true }).map((row) => row.id)).toEqual(['first']);
    expect(adapter.queryTasksByFilter({ op: 'eq', key: 'execution_agent', value: 'codex' }).map((row) => row.id)).toEqual(['first']);
    expect(adapter.queryTasksByFilter({ op: 'in', key: 'status', values: ['completed', 'running'] }).map((row) => row.id)).toEqual(['first', 'second']);
    expect(adapter.queryTasksByFilter({ op: 'contains', key: 'description', value: '%' }).map((row) => row.id)).toEqual([]);
    expect(adapter.queryTasksByFilter({ op: 'time_range', key: 'created_at', start: '2026-01-01T00:00:03.000Z' }).map((row) => row.id)).toEqual(['second']);
  });

  it('does not treat values as SQL and rejects unknown identifiers', async () => {
    await seededAdapter();
    expect(adapter.queryTasksByFilter({ op: 'eq', key: 'description', value: "' OR 1=1 --" })).toEqual([]);
    expect(() => compileTaskFilter({ op: 'eq', key: 'description; DROP TABLE tasks' as never, value: 'x' })).toThrow('Unknown task filter key');
  });

  it('excludes deleted workflows and caps results at 500 in creation order', async () => {
    await seededAdapter();
    const deletedOnly = adapter.queryTasksByFilter({ op: 'contains', key: 'description', value: 'deleted' });
    expect(deletedOnly).toEqual([]);
    for (let index = 0; index < 501; index += 1) {
      adapter.saveTask('live-a', task(`cap-${index}`, 'live-a', new Date(Date.parse('2026-02-01T00:00:00.000Z') + index * 1000).toISOString()));
    }
    const rows = adapter.queryTasksByFilter({ op: 'eq', key: 'workflow_id', value: 'live-a' }, { limit: 999 });
    expect(rows).toHaveLength(500);
    expect(rows[0].id).toBe('first');
    expect(rows.at(-1)?.id).toBe('cap-498');
  });
});
