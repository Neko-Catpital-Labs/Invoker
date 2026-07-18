import { afterEach, describe, expect, it, vi } from 'vitest';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import type { Workflow } from '../adapter.js';
import type { TaskState } from '@invoker/workflow-core';

const RECOVERY_TYPES = [
  'recovery.worker.wakeup',
  'recovery.worker.scan',
  'recovery.worker.submit',
  'recovery.worker.skip',
] as const;

const MULTI_TYPE_SQL = `
SELECT * FROM events
WHERE event_type IN (?, ?, ?, ?)
ORDER BY created_at DESC, id DESC
LIMIT ?
`.trim();

const PER_TYPE_SQL = `
SELECT * FROM events
WHERE event_type = ?
ORDER BY created_at DESC, id DESC
LIMIT ?
`.trim();

function makeWorkflow(id: string): Workflow {
  return {
    id,
    name: id,
    status: 'running',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
}

function makeTask(id: string): TaskState {
  return {
    id,
    description: `Task ${id}`,
    status: 'pending',
    dependencies: [],
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    config: {},
    execution: {},
    taskStateVersion: 1,
  };
}

function explain(adapter: SQLiteAdapter, sql: string, params: unknown[]): string {
  const planRows = (adapter as unknown as {
    db: { prepare: (sql: string) => { all: (...args: unknown[]) => Array<{ detail: string }> } };
  }).db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params);
  return planRows.map((row) => row.detail).join('\n');
}

describe('getEventsByTypes query plans', () => {
  let adapter: SQLiteAdapter;

  afterEach(async () => {
    await adapter?.close();
  });

  it('proves multi-type IN + ORDER BY created_at uses TEMP B-TREE', async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    adapter.saveWorkflow(makeWorkflow('wf-1'));
    adapter.saveTask('wf-1', makeTask('t1'));
    for (const eventType of RECOVERY_TYPES) {
      adapter.logEvent('t1', eventType, { phase: 'plan' });
    }

    const detail = explain(adapter, MULTI_TYPE_SQL, [...RECOVERY_TYPES, 50]);
    expect(detail).toContain('USE TEMP B-TREE');
  });

  it('proves single-type ORDER BY created_at uses idx_events_type_created without TEMP B-TREE', async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    adapter.saveWorkflow(makeWorkflow('wf-1'));
    adapter.saveTask('wf-1', makeTask('t1'));
    adapter.logEvent('t1', RECOVERY_TYPES[3], { phase: 'plan' });

    const detail = explain(adapter, PER_TYPE_SQL, [RECOVERY_TYPES[3], 10]);
    expect(detail).toContain('idx_events_type_created');
    expect(detail).not.toContain('USE TEMP B-TREE');
  });

  it('getEventsByTypes avoids multi-type IN ORDER BY that forces TEMP B-TREE', async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    adapter.saveWorkflow(makeWorkflow('wf-1'));
    adapter.saveTask('wf-1', makeTask('t1'));
    for (let i = 0; i < 8; i += 1) {
      adapter.logEvent('t1', RECOVERY_TYPES[i % RECOVERY_TYPES.length], { i });
    }

    const queryAll = vi.spyOn(
      adapter as unknown as { queryAll: (sql: string, params?: unknown[]) => unknown[] },
      'queryAll',
    );
    adapter.getEventsByTypes(RECOVERY_TYPES, 'desc', 10);

    const multiTypeCalls = queryAll.mock.calls.filter(([sql]) =>
      typeof sql === 'string'
      && /event_type\s+IN\s*\(/i.test(sql)
      && /ORDER BY\s+created_at/i.test(sql),
    );
    expect(multiTypeCalls).toEqual([]);
    expect(queryAll.mock.calls.some(([sql]) =>
      typeof sql === 'string'
      && /event_type\s*=\s*\?/i.test(sql)
      && /ORDER BY\s+created_at/i.test(sql),
    )).toBe(true);
    queryAll.mockRestore();
  });

  it('getEventsByTypes merges newest-across-types order and respects limit', async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    adapter.saveWorkflow(makeWorkflow('wf-1'));
    adapter.saveTask('wf-1', makeTask('t1'));

    const stamps = [
      { type: RECOVERY_TYPES[0], at: '2026-07-01T00:00:01.000Z' },
      { type: RECOVERY_TYPES[1], at: '2026-07-01T00:00:03.000Z' },
      { type: RECOVERY_TYPES[2], at: '2026-07-01T00:00:02.000Z' },
      { type: RECOVERY_TYPES[3], at: '2026-07-01T00:00:04.000Z' },
      { type: RECOVERY_TYPES[0], at: '2026-07-01T00:00:05.000Z' },
    ];
    for (const stamp of stamps) {
      (adapter as unknown as {
        db: { run: (sql: string, params?: unknown[]) => void };
      }).db.run(
        'INSERT INTO events (task_id, event_type, payload, created_at) VALUES (?, ?, ?, ?)',
        ['t1', stamp.type, JSON.stringify({ at: stamp.at }), stamp.at],
      );
    }

    const desc = adapter.getEventsByTypes(RECOVERY_TYPES, 'desc', 3);
    expect(desc.map((event) => event.createdAt)).toEqual([
      '2026-07-01T00:00:05.000Z',
      '2026-07-01T00:00:04.000Z',
      '2026-07-01T00:00:03.000Z',
    ]);

    const asc = adapter.getEventsByTypes(RECOVERY_TYPES, 'asc', 2);
    expect(asc.map((event) => event.createdAt)).toEqual([
      '2026-07-01T00:00:01.000Z',
      '2026-07-01T00:00:02.000Z',
    ]);
  });
});
