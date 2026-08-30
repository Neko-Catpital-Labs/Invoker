import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import { InMemoryBus } from '@invoker/test-kit';
import { Orchestrator } from '@invoker/workflow-core';
import type { TaskState } from '@invoker/workflow-core';

/**
 * Reproduces DO1's real proven shape (queried live, 2026-08-30): 687
 * workflows, 2702 tasks, 676 workflows with at least one ready pending
 * task. Unlike orchestrator-cold-boot-large-db.test.ts (a single boot
 * call), this drives repeated startExecution() calls -- the real DO1
 * shape: one call per queued workflow-mutation intent during backlog
 * catch-up (43 queued intents were observed live).
 */

const WORKFLOW_COUNT = 687;
const TASK_COUNT = 2702;
const ACTIVE_WORKFLOW_COUNT = 676;
const REPEATED_CALLS = 20;
const EXTRA_COMPLETED_TASK_COUNT = TASK_COUNT - (WORKFLOW_COUNT * 3);

describe('orchestrator repeated startExecution() during backlog drain', () => {
  let dbDir: string | undefined;

  afterEach(() => {
    if (dbDir) rmSync(dbDir, { recursive: true, force: true });
    dbDir = undefined;
  });

  it(
    `completes ${REPEATED_CALLS} back-to-back startExecution() calls in bounded time for a ${WORKFLOW_COUNT}-workflow / ${ACTIVE_WORKFLOW_COUNT}-active-ready DB`,
    async () => {
      dbDir = mkdtempSync(path.join(tmpdir(), 'invoker-drain-repro-'));
      const dbPath = path.join(dbDir, 'invoker.db');

      const seedAdapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
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
          const realisticDescription = `Fix CI failure in job "required-fast-extra" for workflow ${wfId}: `
            + 'the merge queue job failed with a dependency install error. '.repeat(3);
          seedAdapter.saveTask(wfId, {
            id: `${wfId}/a`,
            description: realisticDescription,
            status: 'completed',
            dependencies: [],
            createdAt,
            config: { workflowId: wfId },
            execution: { exitCode: 0 },
          } as TaskState);
          seedAdapter.saveTask(wfId, {
            id: `${wfId}/b`,
            description: realisticDescription,
            status: 'completed',
            dependencies: [`${wfId}/a`],
            createdAt,
            config: { workflowId: wfId },
            execution: { exitCode: 0 },
          } as TaskState);

          let readyTaskDependency = `${wfId}/b`;
          if (i < EXTRA_COMPLETED_TASK_COUNT) {
            readyTaskDependency = `${wfId}/extra-completed`;
            seedAdapter.saveTask(wfId, {
              id: readyTaskDependency,
              description: realisticDescription,
              status: 'completed',
              dependencies: [`${wfId}/b`],
              createdAt,
              config: { workflowId: wfId },
              execution: { exitCode: 0 },
            } as TaskState);
          }

          const isActive = i < ACTIVE_WORKFLOW_COUNT;
          seedAdapter.saveTask(wfId, {
            id: `${wfId}/c`,
            description: realisticDescription,
            status: isActive ? 'pending' : 'completed',
            dependencies: [readyTaskDependency],
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
        const orchestrator = new Orchestrator({
          persistence: bootAdapter as any,
          messageBus: new InMemoryBus(),
          maxConcurrency: 1000,
        });

        orchestrator.syncAllFromDb();
        expect(orchestrator.getAllTasks()).toHaveLength(TASK_COUNT);
        expect(orchestrator.getExecutableReadyTasks({ alreadyRefreshed: true }))
          .toHaveLength(ACTIVE_WORKFLOW_COUNT);

        // Simulate the real DO1 backlog drain: one startExecution() call
        // per queued workflow-mutation intent, back to back, with nothing
        // completing in between (matching a fresh boot with a backlog of
        // already-ready tasks nobody has drained yet).
        const perCallMs: number[] = [];
        for (let call = 0; call < REPEATED_CALLS; call += 1) {
          const start = performance.now();
          orchestrator.startExecution({ limit: 0 });
          perCallMs.push(performance.now() - start);
        }

        const totalMs = perCallMs.reduce((a, b) => a + b, 0);
        const avgMs = totalMs / REPEATED_CALLS;
        console.log(`per-call ms: ${perCallMs.map((n) => n.toFixed(1)).join(', ')}`);
        console.log(`total=${totalMs.toFixed(1)}ms avg=${avgMs.toFixed(1)}ms over ${REPEATED_CALLS} calls`);

        // Each call should be well under a second once the N+1 is fixed.
        // Before the fix, this scales with ACTIVE_WORKFLOW_COUNT per call
        // (one uncached loadWorkflow() per ready task) and is expected to
        // fail this bound.
        expect(avgMs, `avgMs=${avgMs} per call over ${REPEATED_CALLS} calls (${ACTIVE_WORKFLOW_COUNT} ready tasks/call)`).toBeLessThan(500);
      } finally {
        bootAdapter.close();
      }
    },
    120_000,
  );
});
