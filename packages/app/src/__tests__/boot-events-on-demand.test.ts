import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteAdapter } from '@invoker/data-store';
import { InMemoryBus } from '@invoker/test-kit';
import { Orchestrator } from '@invoker/workflow-core';
import { getEventsPage } from '../get-events-page.js';

const EVENT_COUNT_PER_TASK = 10_000;
const TASK_COUNT = 50;
const WORKFLOW_COUNT = 10;

function seedFatEventWorkflows(
  adapter: SQLiteAdapter,
  opts: { workflowCount: number; tasksPerWorkflow: number; eventsPerTask: number },
): { totalEvents: number; totalTasks: number } {
  let totalEvents = 0;
  let totalTasks = 0;

  adapter.runInTransaction(() => {
    for (let w = 0; w < opts.workflowCount; w += 1) {
      const workflowId = `wf-${w}`;
      adapter.saveWorkflow({
        id: workflowId,
        name: `Workflow ${w}`,
        status: w % 5 === 0 ? 'running' : 'completed',
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      });

      const tasksPerWf = Math.ceil(opts.tasksPerWorkflow / opts.workflowCount);
      for (let t = 0; t < tasksPerWf; t += 1) {
        const taskId = `${workflowId}/t${t}`;
        adapter.saveTask(workflowId, {
          id: taskId,
          description: `Task ${t} of workflow ${w}`,
          status: t === 0 && w % 5 === 0 ? 'running' : 'completed',
          dependencies: [],
          createdAt: new Date('2026-07-01T00:00:00.000Z'),
          config: { workflowId },
          execution: {},
          taskStateVersion: 1,
        });
        totalTasks += 1;

        for (let e = 0; e < opts.eventsPerTask; e += 1) {
          adapter.logEvent(taskId, 'task.progress', { idx: e });
          totalEvents += 1;
        }
      }
    }
  });

  return { totalEvents, totalTasks };
}

describe('boot-events-on-demand', () => {
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

  it('syncAllFromDb does NOT read from events table', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'boot-events-'));
    adapter = await SQLiteAdapter.create(join(tmpDir, 'invoker.db'), { ownerCapability: true });

    seedFatEventWorkflows(adapter, {
      workflowCount: WORKFLOW_COUNT,
      tasksPerWorkflow: TASK_COUNT,
      eventsPerTask: EVENT_COUNT_PER_TASK,
    });

    const getEventsSpy = vi.spyOn(adapter, 'getEvents');
    const getEventsSlimSpy = vi.spyOn(adapter, 'getEventsSlim');
    const getEventsByTypesSpy = vi.spyOn(adapter, 'getEventsByTypes');
    const listTaskEventsSpy = vi.spyOn(adapter, 'listTaskEvents');

    const orchestrator = new Orchestrator({
      persistence: adapter as never,
      messageBus: new InMemoryBus(),
      maxConcurrency: 4,
    });
    orchestrator.syncAllFromDb();

    expect(getEventsSpy).not.toHaveBeenCalled();
    expect(getEventsSlimSpy).not.toHaveBeenCalled();
    expect(getEventsByTypesSpy).not.toHaveBeenCalled();
    expect(listTaskEventsSpy).not.toHaveBeenCalled();

    const tasks = orchestrator.getAllTasks();
    expect(tasks.length).toBe(TASK_COUNT);
  });

  it('loadWorkflowTaskSnapshot does NOT read from events table', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'snapshot-events-'));
    adapter = await SQLiteAdapter.create(join(tmpDir, 'invoker.db'), { ownerCapability: true });

    seedFatEventWorkflows(adapter, {
      workflowCount: WORKFLOW_COUNT,
      tasksPerWorkflow: TASK_COUNT,
      eventsPerTask: EVENT_COUNT_PER_TASK,
    });

    const getEventsSpy = vi.spyOn(adapter, 'getEvents');
    const getEventsSlimSpy = vi.spyOn(adapter, 'getEventsSlim');
    const getEventsByTypesSpy = vi.spyOn(adapter, 'getEventsByTypes');
    const listTaskEventsSpy = vi.spyOn(adapter, 'listTaskEvents');

    const snapshot = adapter.loadWorkflowTaskSnapshot();

    expect(getEventsSpy).not.toHaveBeenCalled();
    expect(getEventsSlimSpy).not.toHaveBeenCalled();
    expect(getEventsByTypesSpy).not.toHaveBeenCalled();
    expect(listTaskEventsSpy).not.toHaveBeenCalled();

    expect(snapshot.workflows).toHaveLength(WORKFLOW_COUNT);
    expect(snapshot.tasks).toHaveLength(TASK_COUNT);
  });

  it('first cheap IPC (listWorkflows + getQueueStatus) does NOT read events', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ipc-events-'));
    adapter = await SQLiteAdapter.create(join(tmpDir, 'invoker.db'), { ownerCapability: true });

    seedFatEventWorkflows(adapter, {
      workflowCount: WORKFLOW_COUNT,
      tasksPerWorkflow: TASK_COUNT,
      eventsPerTask: EVENT_COUNT_PER_TASK,
    });

    const orchestrator = new Orchestrator({
      persistence: adapter as never,
      messageBus: new InMemoryBus(),
      maxConcurrency: 4,
    });
    orchestrator.syncAllFromDb();

    const getEventsSpy = vi.spyOn(adapter, 'getEvents');
    const getEventsSlimSpy = vi.spyOn(adapter, 'getEventsSlim');
    const getEventsByTypesSpy = vi.spyOn(adapter, 'getEventsByTypes');
    const listTaskEventsSpy = vi.spyOn(adapter, 'listTaskEvents');

    adapter.listWorkflows();
    orchestrator.getQueueStatus();
    orchestrator.startExecution();

    expect(getEventsSpy).not.toHaveBeenCalled();
    expect(getEventsSlimSpy).not.toHaveBeenCalled();
    expect(getEventsByTypesSpy).not.toHaveBeenCalled();
    expect(listTaskEventsSpy).not.toHaveBeenCalled();
  });

  it('getEventsPage loads only bounded events for a specific task', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'page-events-'));
    adapter = await SQLiteAdapter.create(join(tmpDir, 'invoker.db'), { ownerCapability: true });

    seedFatEventWorkflows(adapter, {
      workflowCount: 1,
      tasksPerWorkflow: 1,
      eventsPerTask: EVENT_COUNT_PER_TASK,
    });

    const page = getEventsPage(adapter, 'wf-0/t0', { limit: 20, sortBy: 'desc' });

    expect(page).toHaveLength(20);
  });

  it('boot+first-IPC p95 stays under 2s budget even with 500k events', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'boot-budget-'));
    adapter = await SQLiteAdapter.create(join(tmpDir, 'invoker.db'), { ownerCapability: true });

    const seeded = seedFatEventWorkflows(adapter, {
      workflowCount: WORKFLOW_COUNT,
      tasksPerWorkflow: TASK_COUNT,
      eventsPerTask: EVENT_COUNT_PER_TASK,
    });
    expect(seeded.totalEvents).toBeGreaterThanOrEqual(100_000);

    const samples: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const orchestrator = new Orchestrator({
        persistence: adapter as never,
        messageBus: new InMemoryBus(),
        maxConcurrency: 4,
      });

      const started = performance.now();
      orchestrator.syncAllFromDb();
      adapter.listWorkflows();
      orchestrator.getQueueStatus();
      samples.push(performance.now() - started);
    }

    const sorted = samples.sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
    expect(
      p95,
      `boot+first-IPC p95=${p95.toFixed(1)}ms (events=${seeded.totalEvents})`,
    ).toBeLessThan(2000);
  });
});
