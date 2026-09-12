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

  it('startExecution does not trigger full-table reload when in-memory state is current', async () => {
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
        `${START_EXECUTION_CALLS} startExecution calls should trigger 0 full-table reloads ` +
          `(in-memory state from syncAllFromDb is already current), got ${loadTasksForWorkflowsCalls}`,
      ).toBe(0);

      expect(
        totalTasksLoaded,
        `Total tasks loaded should be 0 (no refreshFromDb during startExecution), got ${totalTasksLoaded}`,
      ).toBe(0);
    } finally {
      adapter.close();
    }
  });

  it('dispatcher poll does not trigger full-table reload after syncAllFromDb', async () => {
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
        `Single dispatcher poll should trigger 0 full-table loadTasksForWorkflows calls ` +
          `(in-memory state is current after syncAllFromDb), got ${loadTasksForWorkflowsCalls}`,
      ).toBe(0);

      expect(
        totalWorkflowsLoaded,
        `Total workflows loaded should be 0 (no refreshFromDb during dispatch), got ${totalWorkflowsLoaded}`,
      ).toBe(0);
    } finally {
      adapter.close();
    }
  });

  it('multiple dispatcher poll ticks do not trigger excessive reloads', async () => {
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

      const orchestrator = new Orchestrator({
        persistence: adapter as any,
        messageBus: new InMemoryBus(),
        maxConcurrency: 200,
      });

      orchestrator.syncAllFromDb();

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

      expect(
        totalLoadTasksForWorkflowsCalls,
        `${POLL_TICKS} dispatcher poll ticks should trigger 0 full-table loadTasksForWorkflows ` +
          `(in-memory state is current), got ${totalLoadTasksForWorkflowsCalls}`,
      ).toBe(0);

      expect(
        totalLoadTasksCalls,
        `${POLL_TICKS} dispatcher poll ticks should trigger 0 per-workflow loadTasks ` +
          `(no syncFromDb calls needed when graph is current), got ${totalLoadTasksCalls}`,
      ).toBe(0);

      console.log(`
================================================================================
TASK RELOAD LOOP FIX VERIFIED
================================================================================
Workflows: ${WORKFLOW_COUNT}
Tasks per workflow: 2 (1 completed root + 1 running/pending)
Running tasks (keep dispatcher polling): ${runningTasks.length}
Dispatcher poll ticks: ${POLL_TICKS}

OBSERVED:
- loadTasksForWorkflows (batched full reload): ${totalLoadTasksForWorkflowsCalls} calls
- loadTasks (per-workflow): ${totalLoadTasksCalls} calls

EXPECTED:
- Full reloads during boot: 1 (syncAllFromDb) — counted before spy installed
- Full reloads during dispatch: 0 (startExecution no longer calls refreshFromDb)
================================================================================
`);
    } finally {
      adapter.close();
    }
  });

  it('drainScheduler with alreadyRefreshed=true skips redundant full-table reload', async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), 'invoker-drain-scheduler-refresh-'));
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
      const realLoadTasksForWorkflows = adapter.loadTasksForWorkflows.bind(adapter);
      (adapter as any).loadTasksForWorkflows = (workflowIds: string[]) => {
        loadTasksForWorkflowsCalls += 1;
        return realLoadTasksForWorkflows(workflowIds);
      };

      (orchestrator as any).drainScheduler({ alreadyRefreshed: true });

      expect(
        loadTasksForWorkflowsCalls,
        `drainScheduler({ alreadyRefreshed: true }) should trigger 0 full-table reloads ` +
          `(in-memory state is current), got ${loadTasksForWorkflowsCalls}`,
      ).toBe(0);
    } finally {
      adapter.close();
    }
  });

  it('drainScheduler without alreadyRefreshed refreshes by default (standalone drain)', async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), 'invoker-drain-scheduler-default-'));
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
      }

      const orchestrator = new Orchestrator({
        persistence: adapter as any,
        messageBus: new InMemoryBus(),
        maxConcurrency: 200,
      });

      orchestrator.syncAllFromDb();

      let loadTasksForWorkflowsCalls = 0;
      const realLoadTasksForWorkflows = adapter.loadTasksForWorkflows.bind(adapter);
      (adapter as any).loadTasksForWorkflows = (workflowIds: string[]) => {
        loadTasksForWorkflowsCalls += 1;
        return realLoadTasksForWorkflows(workflowIds);
      };

      (orchestrator as any).drainScheduler();

      expect(
        loadTasksForWorkflowsCalls,
        `drainScheduler() without options should trigger 1 full-table reload ` +
          `(standalone drains refresh by default)`,
      ).toBe(1);
    } finally {
      adapter.close();
    }
  });
});
