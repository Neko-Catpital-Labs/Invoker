import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter } from '../sqlite-adapter.js';

describe('unbounded workflow SELECT (ui-read-scale proof)', () => {
  let tmpDir: string;
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'unbounded-wf-'));
    adapter = await SQLiteAdapter.create(join(tmpDir, 'invoker.db'), { ownerCapability: true });
  });

  afterEach(async () => {
    await adapter.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it.fails('listWorkflows has no LIMIT and returns all workflows regardless of count', () => {
    const workflowCount = 10_000;
    for (let i = 0; i < workflowCount; i++) {
      adapter.saveWorkflow({
        id: `wf-${i}`,
        name: `Workflow ${i}`,
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    const workflows = adapter.listWorkflows();
    expect(workflows).toHaveLength(workflowCount);
    expect(workflows.length).toBeLessThan(1000);
  });

  it.fails('loadWorkflowTaskSnapshot has no LIMIT and returns all workflows regardless of count', () => {
    const workflowCount = 10_000;
    for (let i = 0; i < workflowCount; i++) {
      adapter.saveWorkflow({
        id: `wf-${i}`,
        name: `Workflow ${i}`,
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    const snapshot = adapter.loadWorkflowTaskSnapshot();
    expect(snapshot.workflows).toHaveLength(workflowCount);
    expect(snapshot.workflows.length).toBeLessThan(1000);
  });

  it.fails('listWorkflows materializes every row into JS objects', () => {
    const workflowCount = 5_000;
    for (let i = 0; i < workflowCount; i++) {
      adapter.saveWorkflow({
        id: `wf-${i}`,
        name: `Workflow ${i} with a longer name to increase memory footprint`,
        description: `Description for workflow ${i} that adds more bytes per row`,
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    const before = process.memoryUsage().heapUsed;
    const workflows = adapter.listWorkflows();
    const after = process.memoryUsage().heapUsed;
    const memoryDelta = after - before;

    expect(workflows).toHaveLength(workflowCount);
    expect(memoryDelta).toBeLessThan(1_000_000);
  });

  it('listWorkflowsPaged returns bounded results with pagination metadata', () => {
    for (let i = 0; i < 500; i++) {
      adapter.saveWorkflow({
        id: `wf-${i}`,
        name: `Workflow ${i}`,
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    const page1 = adapter.listWorkflowsPaged({ limit: 100 });
    expect(page1.workflows).toHaveLength(100);
    expect(page1.total).toBe(500);
    expect(page1.hasMore).toBe(true);

    const page2 = adapter.listWorkflowsPaged({ limit: 100, offset: 100 });
    expect(page2.workflows).toHaveLength(100);
    expect(page2.hasMore).toBe(true);

    const lastPage = adapter.listWorkflowsPaged({ limit: 100, offset: 400 });
    expect(lastPage.workflows).toHaveLength(100);
    expect(lastPage.hasMore).toBe(false);
  });

  it('listWorkflowsPaged respects limit at scale without loading all rows', () => {
    for (let i = 0; i < 5000; i++) {
      adapter.saveWorkflow({
        id: `wf-${i}`,
        name: `Workflow ${i}`,
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    const started = performance.now();
    const result = adapter.listWorkflowsPaged({ limit: 50 });
    const elapsed = performance.now() - started;

    expect(result.workflows).toHaveLength(50);
    expect(result.total).toBe(5000);
    expect(elapsed).toBeLessThan(500);
  });
});
