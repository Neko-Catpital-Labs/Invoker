/**
 * INV-XXX: Proof that LaunchDispatcher.poll triggers O(workflows) full task
 * reloads during dispatch, not O(1) per-workflow loads.
 *
 * The bug: `syncFromDb(workflowId)` in `resolveTaskForDispatch` clears the
 * entire state machine and reloads ALL active workflows, not just the target
 * workflow. Combined with `refreshFromDb()` in `startExecution()`, this causes
 * 743× full-table task loads (2702 rows each) on a 900-workflow DB — the
 * same SQL pattern that blocked HTTP bind in the DO1 incident.
 *
 * This test proves the loop exists by counting `loadTasksForWorkflows` calls
 * (the batched full-reload) and `loadTasks` calls (per-workflow fallback)
 * during a single dispatcher poll cycle with running tasks that need dispatch.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { SQLiteAdapter } from '@invoker/data-store';
import { InMemoryBus } from '@invoker/test-kit';
import { Orchestrator } from '@invoker/workflow-core';
import type { TaskState } from '@invoker/workflow-core';
import { LaunchDispatcher } from '../launch-dispatcher.js';

const WORKFLOW_COUNT = 50;
const TASKS_PER_WORKFLOW = 3;

describe('task reload loop during LaunchDispatcher poll', () => {
  let dbDir: string | undefined;

  beforeEach(() => {
    dbDir = undefined;
  });

  afterEach(() => {
    if (dbDir) rmSync(dbDir, { recursive: true, force: true });
  });

  it('syncFromDb(workflowId) reloads only that workflow, not all workflows', async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), 'invoker-syncfromdb-reload-'));
    const dbPath = path.join(dbDir, 'invoker.db');

    const adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });

    try {
      for (let i = 0; i < WORKFLOW_COUNT; i++) {
        const wfId = `wf-${i}`;
        const nowIso = new Date().toISOString();
        adapter.saveWorkflow({
          id: wfId,
          name: wfId,
          createdAt: nowIso,
          updatedAt: nowIso,
        } as any);

        const createdAt = new Date();
        for (let j = 0; j < TASKS_PER_WORKFLOW; j++) {
          adapter.saveTask(wfId, {
            id: `${wfId}/task-${j}`,
            description: `task ${j}`,
            status: j === 0 ? 'completed' : 'pending',
            dependencies: j === 0 ? [] : [`${wfId}/task-${j - 1}`],
            createdAt,
            config: { workflowId: wfId },
            execution: j === 0 ? { exitCode: 0 } : {},
          } as TaskState);
        }
      }

      const orchestrator = new Orchestrator({
        persistence: adapter as any,
        messageBus: new InMemoryBus(),
        maxConcurrency: 200,
      });

      orchestrator.syncAllFromDb();

      let loadTasksCalls = 0;
      let totalTasksLoaded = 0;
      const realLoadTasks = adapter.loadTasks.bind(adapter);
      (adapter as any).loadTasks = (workflowId: string) => {
        loadTasksCalls += 1;
        const tasks = realLoadTasks(workflowId);
        totalTasksLoaded += tasks.length;
        return tasks;
      };

      orchestrator.syncFromDb('wf-0');

      expect(
        loadTasksCalls,
        `syncFromDb('wf-0') should reload only 1 workflow, not all ${WORKFLOW_COUNT}`,
      ).toBe(1);
      expect(
        totalTasksLoaded,
        `Should load only wf-0's ${TASKS_PER_WORKFLOW} tasks`,
      ).toBe(TASKS_PER_WORKFLOW);
    } finally {
      adapter.close();
    }
  });

  it('PROOF: refreshFromDb reloads ALL workflows on every startExecution call', async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), 'invoker-refreshfromdb-loop-'));
    const dbPath = path.join(dbDir, 'invoker.db');

    const adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });

    try {
      for (let i = 0; i < WORKFLOW_COUNT; i++) {
        const wfId = `wf-${i}`;
        const nowIso = new Date().toISOString();
        adapter.saveWorkflow({
          id: wfId,
          name: wfId,
          createdAt: nowIso,
          updatedAt: nowIso,
        } as any);

        const createdAt = new Date();
        adapter.saveTask(wfId, {
          id: `${wfId}/root`,
          description: 'root',
          status: 'completed',
          dependencies: [],
          createdAt,
          config: { workflowId: wfId },
          execution: { exitCode: 0 },
        } as TaskState);

        adapter.saveTask(wfId, {
          id: `${wfId}/pending`,
          description: 'pending work',
          status: 'pending',
          dependencies: [`${wfId}/root`],
          createdAt,
          config: { workflowId: wfId },
          execution: {},
        } as TaskState);
      }

      const orchestrator = new Orchestrator({
        persistence: adapter as any,
        messageBus: new InMemoryBus(),
        maxConcurrency: 200,
      });

      orchestrator.syncAllFromDb();

      let loadTasksForWorkflowsCalls = 0;
      let totalTasksLoaded = 0;
      const realLoadTasksForWorkflows = adapter.loadTasksForWorkflows.bind(adapter);
      (adapter as any).loadTasksForWorkflows = (workflowIds: string[]) => {
        loadTasksForWorkflowsCalls += 1;
        const tasks = realLoadTasksForWorkflows(workflowIds);
        totalTasksLoaded += tasks.length;
        return tasks;
      };

      const START_EXECUTION_CALLS = 5;
      for (let i = 0; i < START_EXECUTION_CALLS; i++) {
        orchestrator.startExecution({ limit: 32 });
      }

      expect(
        loadTasksForWorkflowsCalls,
        `PROOF: ${START_EXECUTION_CALLS} startExecution calls triggered ${loadTasksForWorkflowsCalls} full-table reloads (should be at most ${START_EXECUTION_CALLS}, but refreshFromDb is called multiple times per startExecution)`,
      ).toBeGreaterThanOrEqual(START_EXECUTION_CALLS);

      expect(
        totalTasksLoaded,
        `Total tasks loaded across all refreshFromDb calls: ${totalTasksLoaded} (${WORKFLOW_COUNT * 2} tasks × ${loadTasksForWorkflowsCalls} reloads)`,
      ).toBe(loadTasksForWorkflowsCalls * WORKFLOW_COUNT * 2);
    } finally {
      adapter.close();
    }
  });

  it('PROOF: dispatcher poll triggers multiple full reloads via refreshFromDb', async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), 'invoker-dispatch-reload-'));
    const dbPath = path.join(dbDir, 'invoker.db');

    const adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });

    try {
      for (let i = 0; i < WORKFLOW_COUNT; i++) {
        const wfId = `wf-${i}`;
        const nowIso = new Date().toISOString();
        adapter.saveWorkflow({
          id: wfId,
          name: wfId,
          createdAt: nowIso,
          updatedAt: nowIso,
        } as any);

        const createdAt = new Date();
        adapter.saveTask(wfId, {
          id: `${wfId}/root`,
          description: 'root',
          status: 'completed',
          dependencies: [],
          createdAt,
          config: { workflowId: wfId },
          execution: { exitCode: 0 },
        } as TaskState);

        adapter.saveTask(wfId, {
          id: `${wfId}/work`,
          description: 'work',
          status: 'pending',
          dependencies: [`${wfId}/root`],
          createdAt,
          config: { workflowId: wfId },
          execution: {},
        } as TaskState);
      }

      const orchestrator = new Orchestrator({
        persistence: adapter as any,
        messageBus: new InMemoryBus(),
        maxConcurrency: 200,
      });

      orchestrator.syncAllFromDb();

      let loadTasksForWorkflowsCalls = 0;
      let totalWorkflowsLoaded = 0;
      const realLoadTasksForWorkflows = adapter.loadTasksForWorkflows.bind(adapter);
      (adapter as any).loadTasksForWorkflows = (workflowIds: string[]) => {
        loadTasksForWorkflowsCalls += 1;
        totalWorkflowsLoaded += workflowIds.length;
        return realLoadTasksForWorkflows(workflowIds);
      };

      const launchDispatcher = new LaunchDispatcher({
        persistence: adapter as any,
        orchestrator: orchestrator as any,
        ownerId: 'test-owner',
        taskRunnerProvider: () => ({
          executeTask: async () => {},
        }),
        maxLeasesPerPoll: 10,
      });

      launchDispatcher.poll();

      expect(
        loadTasksForWorkflowsCalls,
        `PROOF: single dispatcher poll triggered ${loadTasksForWorkflowsCalls} loadTasksForWorkflows calls (full-table reloads via refreshFromDb)`,
      ).toBeGreaterThan(1);

      expect(
        totalWorkflowsLoaded,
        `PROOF: total workflows loaded: ${totalWorkflowsLoaded} = ${loadTasksForWorkflowsCalls} calls × ${WORKFLOW_COUNT} workflows each`,
      ).toBe(loadTasksForWorkflowsCalls * WORKFLOW_COUNT);
    } finally {
      adapter.close();
    }
  });

  it('PROOF: combined loop count during boot + first poll matches observed pattern', async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), 'invoker-combined-loop-'));
    const dbPath = path.join(dbDir, 'invoker.db');

    const adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });

    try {
      const runningTasks: string[] = [];

      for (let i = 0; i < WORKFLOW_COUNT; i++) {
        const wfId = `wf-${i}`;
        const nowIso = new Date().toISOString();
        adapter.saveWorkflow({
          id: wfId,
          name: wfId,
          createdAt: nowIso,
          updatedAt: nowIso,
        } as any);

        const createdAt = new Date();
        adapter.saveTask(wfId, {
          id: `${wfId}/root`,
          description: 'root',
          status: 'completed',
          dependencies: [],
          createdAt,
          config: { workflowId: wfId },
          execution: { exitCode: 0 },
        } as TaskState);

        if (i < WORKFLOW_COUNT / 2) {
          const taskId = `${wfId}/running`;
          adapter.saveTask(wfId, {
            id: taskId,
            description: 'running work',
            status: 'running',
            dependencies: [`${wfId}/root`],
            createdAt,
            config: { workflowId: wfId },
            execution: { startedAt: createdAt },
          } as TaskState);
          runningTasks.push(taskId);
        } else {
          adapter.saveTask(wfId, {
            id: `${wfId}/pending`,
            description: 'pending work',
            status: 'pending',
            dependencies: [`${wfId}/root`],
            createdAt,
            config: { workflowId: wfId },
            execution: {},
          } as TaskState);
        }
      }

      let totalLoadTasksCalls = 0;
      let totalLoadTasksForWorkflowsCalls = 0;

      const realLoadTasks = adapter.loadTasks.bind(adapter);
      (adapter as any).loadTasks = (workflowId: string) => {
        totalLoadTasksCalls += 1;
        return realLoadTasks(workflowId);
      };

      const realLoadTasksForWorkflows = adapter.loadTasksForWorkflows.bind(adapter);
      (adapter as any).loadTasksForWorkflows = (workflowIds: string[]) => {
        totalLoadTasksForWorkflowsCalls += 1;
        return realLoadTasksForWorkflows(workflowIds);
      };

      const orchestrator = new Orchestrator({
        persistence: adapter as any,
        messageBus: new InMemoryBus(),
        maxConcurrency: 200,
      });

      orchestrator.syncAllFromDb();

      const launchDispatcher = new LaunchDispatcher({
        persistence: adapter as any,
        orchestrator: orchestrator as any,
        ownerId: 'test-owner',
        taskRunnerProvider: () => ({
          executeTask: async () => {},
        }),
        maxLeasesPerPoll: 32,
      });

      const POLL_TICKS = 10;
      for (let tick = 0; tick < POLL_TICKS; tick++) {
        launchDispatcher.poll();
      }

      const totalFullReloads = totalLoadTasksForWorkflowsCalls + Math.floor(totalLoadTasksCalls / WORKFLOW_COUNT);

      expect(
        totalFullReloads,
        `PROOF: ${POLL_TICKS} dispatcher polls triggered ${totalFullReloads} full-table reloads (via refreshFromDb/syncFromDb). ` +
        `loadTasksForWorkflows: ${totalLoadTasksForWorkflowsCalls}, loadTasks: ${totalLoadTasksCalls}`,
      ).toBeGreaterThan(POLL_TICKS);

      console.log(`
================================================================================
TASK RELOAD LOOP PROOF SUMMARY
================================================================================
Workflows: ${WORKFLOW_COUNT}
Tasks per workflow: 2 (1 completed root + 1 running/pending)
Running tasks (keep dispatcher polling): ${runningTasks.length}
Dispatcher poll ticks: ${POLL_TICKS}

OBSERVED:
- loadTasksForWorkflows (batched full reload): ${totalLoadTasksForWorkflowsCalls} calls
- loadTasks (per-workflow): ${totalLoadTasksCalls} calls
- Estimated full-table reloads: ${totalFullReloads}

EXPECTED AFTER FIX:
- Full reloads during boot: 1 (syncAllFromDb)
- Full reloads during dispatch: 0 (syncFromDb should be workflow-scoped)
- Per-dispatch workflow loads: proportional to dispatched tasks, not all workflows
================================================================================
`);
    } finally {
      adapter.close();
    }
  });
});
