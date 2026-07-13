import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import type { Workflow } from '../adapter.js';

// event_type_counters makes countEventsByTypes O(types) instead of a linear
// COUNT(*) scan of the events table. These tests pin the two things that make
// that safe: the trigger-maintained counter stays EXACT across every insert /
// delete / full-wipe path, and an old database (events but no counter) is
// backfilled on open.

const workflow: Workflow = {
  id: 'wf',
  name: 'Counter Test',
  status: 'running',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function makeTask(id: string) {
  return {
    id,
    description: id,
    status: 'pending' as const,
    dependencies: [],
    createdAt: new Date(),
    config: { workflowId: 'wf', command: 'echo test' },
    execution: {},
  };
}

const TYPES = ['recovery.worker.skip', 'recovery.worker.wakeup', 'other.noise'] as const;

describe('event_type_counters', () => {
  let tmpDir: string;
  let dbPath: string;
  let adapter: SQLiteAdapter;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'event-counters-'));
    dbPath = join(tmpDir, 'invoker.db');
  });

  afterEach(() => {
    try { adapter?.close(); } catch { /* already closed */ }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // A live COUNT(*) / MAX(created_at) straight off the events table — the exact
  // truth the counter must reproduce.
  function liveCount(a: SQLiteAdapter, type: string): { count: number; last: string | null } {
    const db = (a as unknown as { db: { prepare: (sql: string) => { get: (...p: unknown[]) => Record<string, unknown> } } }).db;
    const row = db.prepare(
      'SELECT COUNT(*) AS count, MAX(created_at) AS last FROM events WHERE event_type = ?',
    ).get(type);
    return { count: Number(row.count ?? 0), last: (row.last as string | null) ?? null };
  }

  function seed(a: SQLiteAdapter): void {
    a.saveWorkflow(workflow);
    for (let t = 0; t < 6; t += 1) {
      const taskId = `wf/t${t}`;
      a.saveTask('wf', makeTask(taskId));
      for (let e = 0; e < 30; e += 1) {
        a.logEvent(taskId, TYPES[e % TYPES.length], { i: e });
      }
    }
  }

  it('countEventsByTypes matches a live COUNT/MAX after inserts', async () => {
    adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    seed(adapter);

    const result = adapter.countEventsByTypes(TYPES);
    for (const type of TYPES) {
      const row = result.find((r) => r.eventType === type)!;
      const live = liveCount(adapter, type);
      expect(row.count).toBe(live.count);
      expect(row.lastCreatedAt).toBe(live.last);
      expect(row.count).toBeGreaterThan(0);
    }
    // Unknown types come back as zero, in the requested order.
    const withUnknown = adapter.countEventsByTypes(['nope', 'recovery.worker.skip']);
    expect(withUnknown.map((r) => r.eventType)).toEqual(['nope', 'recovery.worker.skip']);
    expect(withUnknown[0].count).toBe(0);
    expect(withUnknown[0].lastCreatedAt).toBeNull();
  });

  it('reads the counter table, not a live scan (O(1) path is active)', async () => {
    adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    seed(adapter);

    // Poke the counter to a value that no live scan of events could produce.
    const db = (adapter as unknown as { db: { run: (sql: string, p?: unknown[]) => void } }).db;
    db.run('UPDATE event_type_counters SET count = 999999 WHERE event_type = ?', ['recovery.worker.skip']);

    const row = adapter.countEventsByTypes(['recovery.worker.skip'])[0];
    expect(row.count).toBe(999999);
    // lastCreatedAt still comes live off the events index, so it stays real.
    expect(row.lastCreatedAt).toBe(liveCount(adapter, 'recovery.worker.skip').last);
  });

  it('decrements exactly when a workflow (and its events) is deleted', async () => {
    adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    seed(adapter);
    const before = adapter.countEventsByTypes(['recovery.worker.skip'])[0].count;
    expect(before).toBeGreaterThan(0);

    adapter.deleteWorkflow('wf');

    for (const type of TYPES) {
      const row = adapter.countEventsByTypes([type])[0];
      expect(row.count).toBe(0);
      expect(row.count).toBe(liveCount(adapter, type).count);
    }
  });

  it('zeroes all counters on a full wipe (deleteAllWorkflows)', async () => {
    adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    seed(adapter);

    adapter.deleteAllWorkflows();

    for (const type of TYPES) {
      expect(adapter.countEventsByTypes([type])[0].count).toBe(0);
      expect(liveCount(adapter, type).count).toBe(0);
    }
  });

  it('backfills counters for a database written before the counter existed', async () => {
    // Simulate an old database: events + index only, no counter table/triggers.
    const legacy = new DatabaseSync(dbPath);
    legacy.exec('PRAGMA foreign_keys = OFF');
    legacy.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_events_type_created ON events(event_type, created_at);
    `);
    const ins = legacy.prepare('INSERT INTO events (task_id, event_type, created_at) VALUES (?, ?, ?)');
    const base = Date.UTC(2026, 0, 1);
    const expected: Record<string, number> = {};
    for (let i = 0; i < 300; i += 1) {
      const type = TYPES[i % TYPES.length];
      expected[type] = (expected[type] ?? 0) + 1;
      ins.run(`t${i % 5}`, type, new Date(base + i * 1000).toISOString());
    }
    legacy.close();

    // Open with the current adapter: SCHEMA_DDL adds the table + triggers, the
    // migration backfills the pre-existing rows.
    adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    for (const type of TYPES) {
      expect(adapter.countEventsByTypes([type])[0].count).toBe(expected[type]);
    }

    // Triggers take over from the seeded baseline for new rows (no double count).
    adapter.saveWorkflow(workflow);
    adapter.saveTask('wf', makeTask('wf/t0'));
    adapter.logEvent('wf/t0', 'recovery.worker.skip', {});
    expect(adapter.countEventsByTypes(['recovery.worker.skip'])[0].count)
      .toBe(expected['recovery.worker.skip'] + 1);
  });
});
