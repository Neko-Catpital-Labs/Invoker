import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteAdapter } from '@invoker/data-store';
import { InMemoryBus } from '@invoker/test-kit';
import { Orchestrator } from '@invoker/workflow-core';
import { buildCurrentActionGraphSnapshot } from '../action-graph-snapshot.js';
import { seedMainProcessHitchFixture } from '../main-process-hitch-fixture.js';
import type { InvokerConfig } from '../config.js';

/**
 * Cost repro for Cursor→Invoker beachball suspects that survive the worker-status
 * fix: Action Graph full snapshot and owner dbPoll-like loadTasks under a fat DB.
 *
 * Budgets match docs/architecture/ui-action-responsiveness-invariant.md (p95 ≤ 200ms
 * ack; hitch e2e uses 100ms for cheap IPC). Anything above 100ms on the main thread
 * is enough to beachball window chrome on refocus.
 */
describe('focus-switch main-process cost repro', () => {
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

  it('buildCurrentActionGraphSnapshot stays under 100ms on default hitch fixture', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'focus-ag-'));
    adapter = await SQLiteAdapter.create(join(tmpDir, 'invoker.db'), { ownerCapability: true });
    const seeded = seedMainProcessHitchFixture(adapter);
    expect(seeded.eventCount).toBeGreaterThanOrEqual(10_000);

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
      `action-graph snapshot took ${elapsedMs.toFixed(1)}ms (tasks=${seeded.taskCount}, events=${seeded.eventCount})`,
    ).toBeLessThan(100);
  });

  // Documents the Cursor→Invoker beachball: Action Graph poll stalls main under a fat DB.
  // it.fails until the getQueueStatus / snapshot fix lands in the next stack slice.
  it.fails('buildCurrentActionGraphSnapshot stays under 100ms with 200 mostly-idle tasks × 250 events', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'focus-ag-fat-'));
    adapter = await SQLiteAdapter.create(join(tmpDir, 'invoker.db'), { ownerCapability: true });
    const seeded = seedMainProcessHitchFixture(adapter, {
      taskCount: 200,
      eventsPerTask: 250,
      actionsPerKind: 20,
    });
    expect(seeded.eventCount).toBe(50_000);

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
      `fat action-graph snapshot took ${elapsedMs.toFixed(1)}ms (tasks=${seeded.taskCount}, events=${seeded.eventCount})`,
    ).toBeLessThan(100);
  });

  it('dbPoll-like loadTasks+JSON.stringify stays under 100ms across 50 running workflows × 8 tasks', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'focus-dbpoll-'));
    adapter = await SQLiteAdapter.create(join(tmpDir, 'invoker.db'), { ownerCapability: true });

    const workflowCount = 50;
    const tasksPerWorkflow = 8;
    for (let w = 0; w < workflowCount; w += 1) {
      const workflowId = `wf-dbpoll-${w}`;
      adapter.saveWorkflow({
        id: workflowId,
        name: `DB poll workflow ${w}`,
        status: 'running',
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      });
      for (let t = 0; t < tasksPerWorkflow; t += 1) {
        const taskId = `${workflowId}/t${t}`;
        adapter.saveTask(workflowId, {
          id: taskId,
          description: `Task ${taskId}`,
          status: t === 0 ? 'running' : 'pending',
          dependencies: [],
          createdAt: new Date('2026-07-01T00:00:00.000Z'),
          config: {},
          execution: t === 0
            ? { phase: 'executing', startedAt: new Date('2026-07-01T00:00:00.000Z') }
            : {},
          taskStateVersion: 1,
        });
      }
    }

    const started = performance.now();
    const workflows = adapter.listWorkflows();
    let taskVisits = 0;
    for (const wf of workflows) {
      if (wf.status === 'completed' || wf.status === 'failed') continue;
      const tasks = adapter.loadTasks(wf.id);
      for (const task of tasks) {
        taskVisits += 1;
        if (task.execution.selectedAttemptId) {
          adapter.loadAttempt?.(task.execution.selectedAttemptId);
        }
        JSON.stringify(task);
      }
    }
    const elapsedMs = performance.now() - started;

    expect(taskVisits).toBe(workflowCount * tasksPerWorkflow);
    expect(
      elapsedMs,
      `dbPoll-like scan took ${elapsedMs.toFixed(1)}ms (workflows=${workflowCount}, tasks=${taskVisits})`,
    ).toBeLessThan(100);
  });
});
