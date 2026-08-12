import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import { InMemoryBus } from '@invoker/test-kit';
import { Orchestrator } from '@invoker/workflow-core';
import type { TaskState } from '@invoker/workflow-core';

/**
 * Reproduces the DO1 incident's actual startup shape (not the same code
 * path as launch-dispatcher-topup-event-loop-lag.test.ts, which measures a
 * single in-process startExecution() burst): a real owner process cold
 * booting against an already-large, already-persisted database file --
 * hundreds of workflows accumulated over weeks, most finished, but with a
 * real backlog of ready-but-undispatched tasks nobody had drained.
 *
 * The DB here is seeded directly through SQLiteAdapter (the same
 * persistence layer production uses, not an in-memory mock) and written to
 * a real on-disk file. Boot is measured through the same two calls
 * main.ts's real startup path makes: Orchestrator.syncAllFromDb() (the
 * "orchestrator.restore.full-snapshot" phase) followed by
 * Orchestrator.startExecution() (the first LaunchDispatcher poll tick).
 */

const WORKFLOW_COUNT = 300;

describe('orchestrator cold boot against a large persisted DB', () => {
  let dbDir: string | undefined;

  afterEach(() => {
    if (dbDir) rmSync(dbDir, { recursive: true, force: true });
    dbDir = undefined;
  });

  it(
    'boots a ~900-task / 300-workflow DB without per-workflow task reloads',
    async () => {
      dbDir = mkdtempSync(path.join(tmpdir(), 'invoker-cold-boot-'));
      const dbPath = path.join(dbDir, 'invoker.db');

      const seedAdapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
      let activeWorkflowCount = 0;
      try {
        for (let i = 0; i < WORKFLOW_COUNT; i += 1) {
          const wfId = `wf-seed-${i}`;
          const nowIso = new Date().toISOString();
          seedAdapter.saveWorkflow({
            id: wfId,
            name: wfId,
            createdAt: nowIso,
            updatedAt: nowIso,
          } as any);

          const createdAt = new Date();
          seedAdapter.saveTask(wfId, {
            id: `${wfId}/a`,
            description: 'a',
            status: 'completed',
            dependencies: [],
            createdAt,
            config: { workflowId: wfId },
            execution: { exitCode: 0 },
          } as TaskState);
          seedAdapter.saveTask(wfId, {
            id: `${wfId}/b`,
            description: 'b',
            status: 'completed',
            dependencies: [`${wfId}/a`],
            createdAt,
            config: { workflowId: wfId },
            execution: { exitCode: 0 },
          } as TaskState);

          // Two-thirds of workflows still carry a ready, undispatched task
          // -- the real DO1 shape: a large backlog of ready work nobody
          // had drained, sitting alongside a much larger pile of finished
          // history.
          const isActive = i % 3 !== 0;
          if (isActive) activeWorkflowCount += 1;
          seedAdapter.saveTask(wfId, {
            id: `${wfId}/c`,
            description: 'c',
            status: isActive ? 'pending' : 'completed',
            dependencies: [`${wfId}/b`],
            createdAt,
            config: { workflowId: wfId },
            execution: isActive ? {} : { exitCode: 0 },
          } as TaskState);
        }
      } finally {
        seedAdapter.close();
      }

      const bootAdapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
      try {
        const snapshotSpy = vi.spyOn(bootAdapter, 'loadWorkflowTaskSnapshot');
        const bulkTaskLoadSpy = vi.spyOn(bootAdapter, 'loadTasksForWorkflows');
        const perWorkflowTaskLoadSpy = vi.spyOn(bootAdapter, 'loadTasks');
        const orchestrator = new Orchestrator({
          persistence: bootAdapter as any,
          messageBus: new InMemoryBus(),
          maxConcurrency: 200,
        });

        orchestrator.syncAllFromDb();
        const started = orchestrator.startExecution();

        expect(started.length).toBe(activeWorkflowCount);
        // Before the refreshFromDb() N+1 fix (see scheduler-domain.ts),
        // getTaskLaunchReadinessImpl() reloaded every active workflow's
        // tasks from the DB once per ready task, so this scaled with the
        // ready-task backlog and could take seconds to minutes on a
        // large, unhealthy DB (confirmed live on the affected production
        // host, INV-279). Assert the DB access pattern directly instead of
        // relying on a CI-runner wall-clock threshold.
        expect(snapshotSpy).toHaveBeenCalledTimes(1);
        expect(bulkTaskLoadSpy.mock.calls.length).toBeLessThanOrEqual(5);
        expect(perWorkflowTaskLoadSpy).not.toHaveBeenCalled();
      } finally {
        bootAdapter.close();
      }
    },
    30_000,
  );
});
