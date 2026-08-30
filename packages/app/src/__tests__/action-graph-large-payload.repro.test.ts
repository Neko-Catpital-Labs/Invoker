import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteAdapter } from '@invoker/data-store';
import { InMemoryBus } from '@invoker/test-kit';
import { Orchestrator } from '@invoker/workflow-core';
import { buildCurrentActionGraphSnapshot } from '../action-graph-snapshot.js';
import type { InvokerConfig } from '../config.js';

describe('action graph snapshot with large payloads (ui-read-scale proof)', () => {
  let tmpDir: string | undefined;
  let adapter: SQLiteAdapter | undefined;

  afterEach(async () => {
    await adapter?.close();
    adapter = undefined;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('uses getEventsSlim to avoid fetching full 1MB payloads', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ag-payload-'));
    adapter = await SQLiteAdapter.create(join(tmpDir, 'invoker.db'), { ownerCapability: true });

    const largePayload = 'x'.repeat(1_000_000);

    adapter.saveWorkflow({
      id: 'wf-payload',
      name: 'Large payload workflow',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    for (let t = 0; t < 5; t++) {
      const taskId = `wf-payload/t${t}`;
      adapter.saveTask('wf-payload', {
        id: taskId,
        description: `Running task ${t}`,
        status: 'running',
        dependencies: [],
        createdAt: new Date(),
        config: { workflowId: 'wf-payload' },
        execution: { startedAt: new Date() },
        taskStateVersion: 1,
      });
      for (let e = 0; e < 20; e++) {
        adapter.logEvent(taskId, 'task.progress', { data: largePayload });
      }
    }

    const orchestrator = new Orchestrator({
      persistence: adapter as never,
      messageBus: new InMemoryBus(),
      maxConcurrency: 4,
    });
    orchestrator.syncAllFromDb();

    const invokerConfig: InvokerConfig = {};
    const started = performance.now();
    const snapshot = buildCurrentActionGraphSnapshot({
      orchestrator,
      persistence: adapter,
      invokerConfig,
    });
    const elapsedMs = performance.now() - started;

    expect(snapshot.nodes.length).toBeGreaterThan(0);
    expect(
      elapsedMs,
      `snapshot with 5 tasks × 20 events × 1MB payloads took ${elapsedMs.toFixed(1)}ms`,
    ).toBeLessThan(200);
  });

  it('history entries are truncated to 2KB', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ag-truncate-'));
    adapter = await SQLiteAdapter.create(join(tmpDir, 'invoker.db'), { ownerCapability: true });

    const largePayload = 'y'.repeat(10_000);

    adapter.saveWorkflow({
      id: 'wf-trunc',
      name: 'Truncation test workflow',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    adapter.saveTask('wf-trunc', {
      id: 'wf-trunc/t1',
      description: 'Task with large event',
      status: 'running',
      dependencies: [],
      createdAt: new Date(),
      config: { workflowId: 'wf-trunc' },
      execution: { startedAt: new Date() },
      taskStateVersion: 1,
    });
    adapter.logEvent('wf-trunc/t1', 'task.progress', { data: largePayload });

    const orchestrator = new Orchestrator({
      persistence: adapter as never,
      messageBus: new InMemoryBus(),
      maxConcurrency: 4,
    });
    orchestrator.syncAllFromDb();

    const snapshot = buildCurrentActionGraphSnapshot({
      orchestrator,
      persistence: adapter,
      invokerConfig: {},
    });

    const taskNode = snapshot.nodes.find((n) => n.taskId === 'wf-trunc/t1');
    expect(taskNode?.history).toHaveLength(1);
    const historyMessage = taskNode?.history?.[0]?.message ?? '';
    expect(historyMessage.length).toBeLessThanOrEqual(2100);
    expect(historyMessage).toContain('truncated');
  });
});
