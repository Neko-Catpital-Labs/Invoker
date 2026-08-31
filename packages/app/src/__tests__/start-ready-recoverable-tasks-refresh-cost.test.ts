import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import { InMemoryBus } from '@invoker/test-kit';
import { Orchestrator } from '@invoker/workflow-core';
import type { TaskState } from '@invoker/workflow-core';
import { runStartReady } from '../start-ready.js';

/**
 * runStartReadyAsync's recoverable-tasks loop
 * (packages/app/src/start-ready.ts:335-338) calls
 * `orchestrator.prepareTaskForNewAttempt(task.id, ...)` once per recoverable
 * task found system-wide, and `prepareTaskForNewAttempt` unconditionally
 * calls the orchestrator's private `refreshFromDb()` at its own top
 * (packages/workflow-core/src/orchestrator.ts:1307-1308) — a full reload of
 * every task in every active workflow, not just the recoverable task's own
 * workflow. On DO1's real backlog this measured 350-400s for a single
 * `invoker:start-ready` dispatch.
 *
 * This seeds two runs against the same on-disk shape (many small active
 * workflows) that differ only in how many recoverable tasks exist, and
 * shows the batch-reload call count (and wall time) scales with the
 * recoverable-task count instead of staying constant.
 */

const SMALL_WORKFLOW_COUNT = 300;
const RECOVERABLE_TASK_COUNT = 8;

async function seedAndRun(recoverableCount: number): Promise<{ batchLoadCalls: number; elapsedMs: number }> {
  const dbDir = mkdtempSync(path.join(tmpdir(), 'invoker-start-ready-refresh-'));
  const dbPath = path.join(dbDir, 'invoker.db');
  try {
    const realisticDescription = 'x'.repeat(4800);
    const realisticPrompt = 'y'.repeat(3000);

    const seedAdapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    try {
      for (let i = 0; i < SMALL_WORKFLOW_COUNT; i += 1) {
        const wfId = `wf-small-${i}`;
        const nowIso = new Date().toISOString();
        seedAdapter.saveWorkflow({ id: wfId, name: wfId, createdAt: nowIso, updatedAt: nowIso } as any);
        const createdAt = new Date();
        const isRecoverable = i < recoverableCount;
        // A stale startedAt (well past ATTEMPT_LEASE_MS) with no matching
        // `attempts` row is what makes isTaskExecutionActive() report this
        // 'running' task as not-active, so collectRecoverableTasks() picks
        // it up as orphaned/recoverable instead of still-in-flight.
        const staleStartedAt = new Date(createdAt.getTime() - 24 * 60 * 60 * 1000);
        seedAdapter.saveTask(wfId, {
          id: `${wfId}/t0`,
          description: realisticDescription,
          prompt: realisticPrompt,
          status: isRecoverable ? 'running' : 'completed',
          dependencies: [],
          createdAt,
          config: { workflowId: wfId },
          execution: isRecoverable
            ? { startedAt: staleStartedAt }
            : { exitCode: 0 },
        } as TaskState);
      }
    } finally {
      seedAdapter.close();
    }

    const bootAdapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    try {
      let batchLoadCalls = 0;
      const realLoadTasksForWorkflows = bootAdapter.loadTasksForWorkflows.bind(bootAdapter);
      (bootAdapter as any).loadTasksForWorkflows = (workflowIds: string[]) => {
        batchLoadCalls += 1;
        return realLoadTasksForWorkflows(workflowIds);
      };

      const orchestrator = new Orchestrator({
        persistence: bootAdapter as any,
        messageBus: new InMemoryBus(),
        maxConcurrency: 200,
      });

      const start = performance.now();
      await runStartReady(orchestrator as any, {});
      const elapsedMs = performance.now() - start;

      return { batchLoadCalls, elapsedMs };
    } finally {
      bootAdapter.close();
    }
  } finally {
    rmSync(dbDir, { recursive: true, force: true });
  }
}

describe('runStartReady pays one full refreshFromDb per recoverable task', () => {
  afterEach(() => {
    // seedAndRun cleans up its own temp dir.
  });

  it.fails(
    'batch-reload call count scales with recoverable-task count instead of staying constant',
    async () => {
      const zero = await seedAndRun(0);
      const withRecoverable = await seedAndRun(RECOVERABLE_TASK_COUNT);

      // eslint-disable-next-line no-console
      console.log(
        `runStartReady with 0 recoverable tasks: ${zero.batchLoadCalls} batch reloads, ${zero.elapsedMs.toFixed(1)}ms; `
          + `with ${RECOVERABLE_TASK_COUNT} recoverable tasks: ${withRecoverable.batchLoadCalls} batch reloads, `
          + `${withRecoverable.elapsedMs.toFixed(1)}ms`,
      );

      // Desired invariant: the recoverable-tasks loop must not pay one full
      // cross-workflow reload per recoverable task found system-wide.
      expect(withRecoverable.batchLoadCalls - zero.batchLoadCalls).toBe(0);
    },
    120_000,
  );
});
