import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import { InMemoryBus } from '@invoker/test-kit';
import { Orchestrator } from '@invoker/workflow-core';
import type { TaskState } from '@invoker/workflow-core';

/**
 * Reproduces DO1's real shape: 687 workflows, one holding 828 tasks
 * (matching wf-1788079638126-4). autoStartReadyTasksImpl() ->
 * rebuildPendingLaunchQueue() -> planPendingLaunchQueue() already calls
 * host.refreshFromDb() once for the whole batch; the immediately-following
 * drainSchedulerImpl() call used to refresh again unconditionally, doubling
 * the cost of a full cross-workflow reload for zero new information (any
 * writes rebuildPendingLaunchQueue makes go through writeAndSync, which
 * already keeps the in-memory graph current). retryTask() and
 * startExecution() both go through this path on every dispatch.
 *
 * With syncFromDb(workflowId) now scoped to a single workflow (instead of
 * clearing and reloading ALL active workflows), retryTaskImpl's initial
 * refresh uses the per-workflow loadTasks path instead of the batched
 * loadTasksForWorkflows, so the batchLoadCalls count is now 1 (the single
 * call inside autoStartReadyTasks).
 */

const SMALL_WORKFLOW_COUNT = 686;
const BIG_WORKFLOW_TASK_COUNT = 828;

describe('autoStartReadyTasks pays one full refreshFromDb per dispatch', () => {
  let dbDir: string | undefined;

  afterEach(() => {
    if (dbDir) rmSync(dbDir, { recursive: true, force: true });
    dbDir = undefined;
  });

  it(
    'refreshFromDb is called once per retryTask dispatch (syncFromDb is now workflow-scoped)',
    async () => {
      dbDir = mkdtempSync(path.join(tmpdir(), 'invoker-double-refresh-'));
      const dbPath = path.join(dbDir, 'invoker.db');

      const realisticDescription = 'x'.repeat(4800);
      const realisticPrompt = 'y'.repeat(3000);
      const realisticSummary = 'z'.repeat(700);

      const seedAdapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
      try {
        for (let i = 0; i < SMALL_WORKFLOW_COUNT; i += 1) {
          const wfId = `wf-small-${i}`;
          const nowIso = new Date().toISOString();
          seedAdapter.saveWorkflow({ id: wfId, name: wfId, createdAt: nowIso, updatedAt: nowIso } as any);
          const createdAt = new Date();
          for (let t = 0; t < 4; t += 1) {
            seedAdapter.saveTask(wfId, {
              id: `${wfId}/t${t}`,
              description: realisticDescription,
              prompt: realisticPrompt,
              summary: realisticSummary,
              status: t === 3 ? 'pending' : 'completed',
              dependencies: t > 0 ? [`${wfId}/t${t - 1}`] : [],
              createdAt,
              config: { workflowId: wfId },
              execution: t === 3 ? {} : { exitCode: 0 },
            } as TaskState);
          }
        }

        const bigWfId = 'wf-big-0';
        const bigNowIso = new Date().toISOString();
        seedAdapter.saveWorkflow({ id: bigWfId, name: bigWfId, createdAt: bigNowIso, updatedAt: bigNowIso } as any);
        const bigCreatedAt = new Date();
        for (let t = 0; t < BIG_WORKFLOW_TASK_COUNT; t += 1) {
          const isTarget = t === 118;
          seedAdapter.saveTask(bigWfId, {
            id: isTarget ? `${bigWfId}/investigate-finding-118` : `${bigWfId}/t${t}`,
            description: realisticDescription,
            prompt: realisticPrompt,
            summary: realisticSummary,
            status: isTarget || t % 30 === 0 ? 'failed' : 'completed',
            dependencies: [],
            createdAt: bigCreatedAt,
            config: { workflowId: bigWfId },
            execution: isTarget || t % 30 === 0 ? { error: 'Owner restart' } : { exitCode: 0 },
          } as TaskState);
        }
        seedAdapter.saveTask(bigWfId, {
          id: `__merge__${bigWfId}`,
          description: 'merge',
          status: 'pending',
          dependencies: Array.from({ length: BIG_WORKFLOW_TASK_COUNT }, (_, t) =>
            (t === 118 ? `${bigWfId}/investigate-finding-118` : `${bigWfId}/t${t}`)),
          createdAt: bigCreatedAt,
          config: { workflowId: bigWfId, isMergeNode: true },
          execution: {},
        } as TaskState);
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

        orchestrator.syncAllFromDb();

        const targetTaskId = 'wf-big-0/investigate-finding-118';

        batchLoadCalls = 0;
        const retryStart = performance.now();
        orchestrator.retryTask(targetTaskId);
        const retryMs = performance.now() - retryStart;

        // eslint-disable-next-line no-console
        console.log(
          `orchestrator.retryTask() end-to-end: ${retryMs.toFixed(1)}ms, `
            + `full-batch refreshFromDb calls during dispatch: ${batchLoadCalls}`,
        );

        expect(batchLoadCalls).toBe(1);
      } finally {
        bootAdapter.close();
      }
    },
    60_000,
  );
});
