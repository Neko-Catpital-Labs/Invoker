import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteAdapter } from '@invoker/data-store';
import { InMemoryBus } from '@invoker/test-kit';
import { Orchestrator } from '@invoker/workflow-core';
import { buildCurrentActionGraphSnapshot } from '../action-graph-snapshot.js';
import { seedMainProcessHitchFixture } from '../main-process-hitch-fixture.js';
import type { InvokerConfig } from '../config.js';
import { getEventsPage } from '../get-events-page.js';

const CHEAP_IPC_P95_BUDGET_MS = 200;
const ACTION_GRAPH_P95_BUDGET_MS = 100;

const CI_WORKFLOW_COUNT = 200;
const CI_EVENTS_PER_TASK = 250;
const CI_TASKS_PER_WORKFLOW = 5;

function parseBenchScale(): { workflowCount: number; eventsPerTask: number; tasksPerWorkflow: number } {
  const scale = process.env.INVOKER_BENCH_SCALE?.toLowerCase();
  if (!scale) {
    return { workflowCount: CI_WORKFLOW_COUNT, eventsPerTask: CI_EVENTS_PER_TASK, tasksPerWorkflow: CI_TASKS_PER_WORKFLOW };
  }
  if (scale === '2g' || scale === '2gb') {
    return { workflowCount: 800, eventsPerTask: 1000, tasksPerWorkflow: 10 };
  }
  if (scale === '1g' || scale === '1gb') {
    return { workflowCount: 400, eventsPerTask: 500, tasksPerWorkflow: 8 };
  }
  if (scale === '500m' || scale === '500mb') {
    return { workflowCount: 200, eventsPerTask: 400, tasksPerWorkflow: 6 };
  }
  return { workflowCount: CI_WORKFLOW_COUNT, eventsPerTask: CI_EVENTS_PER_TASK, tasksPerWorkflow: CI_TASKS_PER_WORKFLOW };
}

interface BenchStats {
  min: number;
  max: number;
  p50: number;
  p95: number;
  samples: number[];
}

function computeStats(samples: number[]): BenchStats {
  const sorted = [...samples].sort((a, b) => a - b);
  const min = sorted[0]!;
  const max = sorted[sorted.length - 1]!;
  const p50 = sorted[Math.floor(sorted.length * 0.5)]!;
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
  return { min, max, p50, p95, samples };
}

function benchmark(
  fn: () => void,
  opts: { warmup?: number; iterations?: number } = {},
): BenchStats {
  const warmup = opts.warmup ?? 3;
  const iterations = opts.iterations ?? 20;
  for (let i = 0; i < warmup; i += 1) fn();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const started = performance.now();
    fn();
    samples.push(performance.now() - started);
  }
  return computeStats(samples);
}

interface SeedManyWorkflowsResult {
  workflowIds: string[];
  totalTasks: number;
  totalEvents: number;
}

function seedManyWorkflows(
  adapter: SQLiteAdapter,
  opts: { workflowCount: number; tasksPerWorkflow: number; eventsPerTask: number },
): SeedManyWorkflowsResult {
  const workflowIds: string[] = [];
  let totalTasks = 0;
  let totalEvents = 0;

  adapter.runInTransaction(() => {
    for (let w = 0; w < opts.workflowCount; w += 1) {
      const workflowId = `wf-bench-${w}`;
      workflowIds.push(workflowId);
      adapter.saveWorkflow({
        id: workflowId,
        name: `Bench workflow ${w}`,
        status: w % 10 === 0 ? 'running' : 'completed',
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      });

      for (let t = 0; t < opts.tasksPerWorkflow; t += 1) {
        const taskId = `${workflowId}/t${t}`;
        adapter.saveTask(workflowId, {
          id: taskId,
          description: `Task ${t} of workflow ${w}`,
          status: t === 0 && w % 10 === 0 ? 'running' : 'completed',
          dependencies: [],
          createdAt: new Date('2026-07-01T00:00:00.000Z'),
          config: {},
          execution: {},
          taskStateVersion: 1,
        });
        totalTasks += 1;

        for (let e = 0; e < opts.eventsPerTask; e += 1) {
          adapter.logEvent(taskId, 'bench.event', { idx: e });
          totalEvents += 1;
        }
      }
    }
  });

  return { workflowIds, totalTasks, totalEvents };
}

describe('ui-read-scale-bench', () => {
  let tmpDir: string | undefined;
  let adapter: SQLiteAdapter | undefined;
  const scale = parseBenchScale();
  const isLargeScale = scale.workflowCount > CI_WORKFLOW_COUNT;

  afterEach(async () => {
    await adapter?.close();
    adapter = undefined;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('listWorkflows p95 stays under 200ms with many workflows', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bench-list-wf-'));
    adapter = await SQLiteAdapter.create(join(tmpDir, 'invoker.db'), { ownerCapability: true });

    const seeded = seedManyWorkflows(adapter, {
      workflowCount: scale.workflowCount,
      tasksPerWorkflow: 1,
      eventsPerTask: 10,
    });
    expect(seeded.workflowIds.length).toBe(scale.workflowCount);

    let result: ReturnType<SQLiteAdapter['listWorkflows']> | undefined;
    const stats = benchmark(() => { result = adapter!.listWorkflows(); });

    expect(result!.length).toBe(scale.workflowCount);
    expect(
      stats.p95,
      `listWorkflows p95=${stats.p95.toFixed(1)}ms max=${stats.max.toFixed(1)}ms (workflows=${scale.workflowCount})`,
    ).toBeLessThan(CHEAP_IPC_P95_BUDGET_MS);
  });

  it('paginated getEvents p95 stays under 200ms on fat event table', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bench-get-events-'));
    adapter = await SQLiteAdapter.create(join(tmpDir, 'invoker.db'), { ownerCapability: true });

    const seeded = seedMainProcessHitchFixture(adapter, {
      taskCount: 1,
      eventsPerTask: scale.eventsPerTask * scale.tasksPerWorkflow,
      actionsPerKind: 1,
    });
    const taskId = `${seeded.workflowId}/t0`;
    expect(seeded.eventCount).toBeGreaterThanOrEqual(1000);

    let result: ReturnType<typeof getEventsPage> | undefined;
    const stats = benchmark(() => {
      result = getEventsPage(adapter!, taskId, { limit: 20, sortBy: 'desc' });
    });

    expect(result!.length).toBe(20);
    expect(
      stats.p95,
      `getEvents(limit:20) p95=${stats.p95.toFixed(1)}ms max=${stats.max.toFixed(1)}ms (events=${seeded.eventCount})`,
    ).toBeLessThan(CHEAP_IPC_P95_BUDGET_MS);
  });

  it('syncAllFromDb + getAllTasks p95 stays under 200ms', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bench-sync-all-'));
    adapter = await SQLiteAdapter.create(join(tmpDir, 'invoker.db'), { ownerCapability: true });

    const seeded = seedManyWorkflows(adapter, {
      workflowCount: scale.workflowCount,
      tasksPerWorkflow: scale.tasksPerWorkflow,
      eventsPerTask: 10,
    });
    expect(seeded.totalTasks).toBe(scale.workflowCount * scale.tasksPerWorkflow);

    const orchestrator = new Orchestrator({
      persistence: adapter as never,
      messageBus: new InMemoryBus(),
      maxConcurrency: 4,
    });

    let tasks: ReturnType<Orchestrator['getAllTasks']> | undefined;
    const stats = benchmark(() => {
      orchestrator.syncAllFromDb();
      tasks = orchestrator.getAllTasks();
    });

    expect(tasks!.length).toBe(seeded.totalTasks);
    expect(
      stats.p95,
      `syncAllFromDb+getAllTasks p95=${stats.p95.toFixed(1)}ms max=${stats.max.toFixed(1)}ms (tasks=${seeded.totalTasks})`,
    ).toBeLessThan(CHEAP_IPC_P95_BUDGET_MS);
  });

  it('buildCurrentActionGraphSnapshot p95 stays under 100ms on hitch fixture', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bench-ag-snapshot-'));
    adapter = await SQLiteAdapter.create(join(tmpDir, 'invoker.db'), { ownerCapability: true });

    const seeded = seedMainProcessHitchFixture(adapter, {
      taskCount: 40,
      eventsPerTask: scale.eventsPerTask,
      actionsPerKind: 20,
    });
    expect(seeded.eventCount).toBeGreaterThanOrEqual(10_000);

    const orchestrator = new Orchestrator({
      persistence: adapter as never,
      messageBus: new InMemoryBus(),
      maxConcurrency: 4,
    });
    orchestrator.syncAllFromDb();

    const invokerConfig: InvokerConfig = {};
    let snapshot: ReturnType<typeof buildCurrentActionGraphSnapshot> | undefined;
    const stats = benchmark(() => {
      snapshot = buildCurrentActionGraphSnapshot({
        orchestrator,
        persistence: adapter!,
        invokerConfig,
      });
    });

    expect(snapshot!.nodes.length).toBeGreaterThan(0);
    expect(
      stats.p95,
      `actionGraphSnapshot p95=${stats.p95.toFixed(1)}ms max=${stats.max.toFixed(1)}ms (events=${seeded.eventCount})`,
    ).toBeLessThan(ACTION_GRAPH_P95_BUDGET_MS);
  });

  it('buildCurrentActionGraphSnapshot p95 stays under 100ms with 200 workflows × 250 events (sidebar cardinality)', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bench-ag-sidebar-'));
    adapter = await SQLiteAdapter.create(join(tmpDir, 'invoker.db'), { ownerCapability: true });

    const seeded = seedManyWorkflows(adapter, {
      workflowCount: scale.workflowCount,
      tasksPerWorkflow: 2,
      eventsPerTask: scale.eventsPerTask,
    });
    expect(seeded.workflowIds.length).toBe(scale.workflowCount);

    const orchestrator = new Orchestrator({
      persistence: adapter as never,
      messageBus: new InMemoryBus(),
      maxConcurrency: 4,
    });
    orchestrator.syncAllFromDb();

    const invokerConfig: InvokerConfig = {};
    let snapshot: ReturnType<typeof buildCurrentActionGraphSnapshot> | undefined;
    const stats = benchmark(() => {
      snapshot = buildCurrentActionGraphSnapshot({
        orchestrator,
        persistence: adapter!,
        invokerConfig,
      });
    });

    expect(snapshot!.nodes.length).toBeGreaterThan(0);
    expect(
      stats.p95,
      `actionGraphSnapshot p95=${stats.p95.toFixed(1)}ms max=${stats.max.toFixed(1)}ms (workflows=${scale.workflowCount}, events=${seeded.totalEvents})`,
    ).toBeLessThan(ACTION_GRAPH_P95_BUDGET_MS);
  });

  it.skipIf(!isLargeScale)('reports DB size for large-scale benchmark', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bench-db-size-'));
    const dbPath = join(tmpDir, 'invoker.db');
    adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });

    seedManyWorkflows(adapter, {
      workflowCount: scale.workflowCount,
      tasksPerWorkflow: scale.tasksPerWorkflow,
      eventsPerTask: scale.eventsPerTask,
    });

    const stat = statSync(dbPath);
    const sizeMB = stat.size / (1024 * 1024);
    console.info(`[ui-read-scale-bench] DB size: ${sizeMB.toFixed(1)} MB (scale=${process.env.INVOKER_BENCH_SCALE})`);
    expect(sizeMB).toBeGreaterThan(10);
  });
});

describe('unbounded getEvents proof', () => {
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

  it('proves unbounded adapter.getEvents(taskId) is expensive on large event tables', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bench-unbounded-'));
    adapter = await SQLiteAdapter.create(join(tmpDir, 'invoker.db'), { ownerCapability: true });

    const seeded = seedMainProcessHitchFixture(adapter, {
      taskCount: 1,
      eventsPerTask: 20_000,
      actionsPerKind: 1,
    });
    const taskId = `${seeded.workflowId}/t0`;

    const unboundedStats = benchmark(() => { adapter!.getEvents(taskId); }, { warmup: 1, iterations: 5 });
    const boundedStats = benchmark(
      () => { getEventsPage(adapter!, taskId, { limit: 20, sortBy: 'desc' }); },
      { warmup: 1, iterations: 5 },
    );

    expect(unboundedStats.p50).toBeGreaterThan(boundedStats.p50 * 2);
    expect(boundedStats.p95).toBeLessThan(50);
  });

  it('SQLiteAdapter.getEvents(taskId) 1-arg overload still exists and is unbounded', () => {
    expect(typeof SQLiteAdapter.prototype.getEvents).toBe('function');
    expect(SQLiteAdapter.prototype.getEvents.length).toBe(1);
  });
});
