import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter } from '../sqlite-adapter.js';

describe('unbounded getEvents (ui-read-scale proof)', () => {
  let tmpDir: string;
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'unbounded-events-'));
    adapter = await SQLiteAdapter.create(join(tmpDir, 'invoker.db'), { ownerCapability: true });
    adapter.saveWorkflow({
      id: 'wf-1',
      name: 'Test Workflow',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    adapter.saveTask('wf-1', {
      id: 'wf-1/t1',
      description: 'Task with many events',
      status: 'running',
      dependencies: [],
      createdAt: new Date(),
      config: { workflowId: 'wf-1' },
      execution: {},
      taskStateVersion: 1,
    });
  });

  afterEach(async () => {
    await adapter.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it.fails('1-arg getEvents overload has no LIMIT and returns entire event history', () => {
    const eventCount = 50_000;
    for (let i = 0; i < eventCount; i++) {
      adapter.logEvent('wf-1/t1', 'task.progress', { i, data: 'x'.repeat(100) });
    }

    const events = adapter.getEvents('wf-1/t1');
    expect(events).toHaveLength(eventCount);
    expect(events.length).toBeLessThan(1000);
  });

  it('bounded getEvents with limit works correctly', () => {
    const eventCount = 1000;
    for (let i = 0; i < eventCount; i++) {
      adapter.logEvent('wf-1/t1', 'task.progress', { i });
    }

    const events = adapter.getEvents('wf-1/t1', 'desc', 100);
    expect(events).toHaveLength(100);
  });

});
