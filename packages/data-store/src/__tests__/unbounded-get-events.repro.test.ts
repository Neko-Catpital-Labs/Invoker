import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter, GET_EVENTS_DEFAULT_LIMIT } from '../sqlite-adapter.js';

describe('getEvents default limit (ui-read-scale)', () => {
  let tmpDir: string;
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bounded-events-'));
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

  it('1-arg getEvents overload applies GET_EVENTS_DEFAULT_LIMIT', () => {
    const eventCount = GET_EVENTS_DEFAULT_LIMIT + 5000;
    for (let i = 0; i < eventCount; i++) {
      adapter.logEvent('wf-1/t1', 'task.progress', { i });
    }

    const events = adapter.getEvents('wf-1/t1');
    expect(events).toHaveLength(GET_EVENTS_DEFAULT_LIMIT);
  });

  it('bounded getEvents with explicit limit works correctly', () => {
    const eventCount = 1000;
    for (let i = 0; i < eventCount; i++) {
      adapter.logEvent('wf-1/t1', 'task.progress', { i });
    }

    const events = adapter.getEvents('wf-1/t1', 'desc', 100);
    expect(events).toHaveLength(100);
  });

  it('GET_EVENTS_DEFAULT_LIMIT is exported and equals 10000', () => {
    expect(GET_EVENTS_DEFAULT_LIMIT).toBe(10_000);
  });
});
