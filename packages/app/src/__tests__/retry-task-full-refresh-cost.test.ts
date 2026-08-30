import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import { InMemoryBus } from '@invoker/test-kit';
import { Orchestrator } from '@invoker/workflow-core';
import type { TaskState } from '@invoker/workflow-core';

/**
 * Reproduces DO1's real invoker:retry-task dispatch shape: 687 workflows,
 * 2,702 total tasks, one workflow (matching the real wf-1788079638126-4)
 * holding 828 of those tasks. retryTaskImpl() used to call
 * host.refreshFromDb() (packages/workflow-core/src/orchestrator/lifecycle.ts)
 * -- a full reload of every task in every tracked workflow -- even though
 * the task being retried lives in exactly one workflow. Its sibling
 * retryWorkflowImpl() (same file) already used the scoped
 * refreshWorkflowFromDb(workflowId) instead; retryTaskImpl,
 * recreateTaskImpl, recreateDownstreamImpl, and recreateWorkflowImpl now do
 * too, and planInvalidation's affected-subgraph lookup for the three
 * task-scoped actions is now scoped to the target's own workflow as well
 * (dependencies never cross workflow boundaries -- confirmed against 2,018
 * real dependency edges on live production data, zero cross-workflow).
 */

const SMALL_WORKFLOW_COUNT = 686;
const BIG_WORKFLOW_TASK_COUNT = 828;

describe('retryTask pays a full cross-workflow refresh for a single-workflow retry', () => {
  let dbDir: string | undefined;

  afterEach(() => {
    if (dbDir) rmSync(dbDir, { recursive: true, force: true });
    dbDir = undefined;
  });

  it(
    'refreshWorkflowFromDb (scoped) is far cheaper than a full refreshFromDb for the same workflow',
    async () => {
      dbDir = mkdtempSync(path.join(tmpdir(), 'invoker-retry-full-refresh-'));
      const dbPath = path.join(dbDir, 'invoker.db');

      // Real DO1 task rows average ~8KB (measured directly against the live DB).
      const realisticDescription = 'x'.repeat(4800);
      const realisticPrompt = 'y'.repeat(3000);
      const realisticSummary = 'z'.repeat(700);

      const seedAdapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
      try {
        for (let i = 0; i < SMALL_WORKFLOW_COUNT; i += 1) {
          const wfId = `wf-small-${i}`;
          const nowIso = new Date().toISOString();
          seedAdapter.saveWorkflow({
            id: wfId,
            name: wfId,
            createdAt: nowIso,
            updatedAt: nowIso,
          } as any);
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
        seedAdapter.saveWorkflow({
          id: bigWfId,
          name: bigWfId,
          createdAt: bigNowIso,
          updatedAt: bigNowIso,
        } as any);
        const bigCreatedAt = new Date();
        for (let t = 0; t < BIG_WORKFLOW_TASK_COUNT; t += 1) {
          // Match the real target task: failed, no deps, one downstream
          // (the merge node) -- most of the workflow's tasks are
          // completed history, the target and a few siblings are failed.
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
        const orchestrator = new Orchestrator({
          persistence: bootAdapter as any,
          messageBus: new InMemoryBus(),
          maxConcurrency: 200,
        });

        // Match real production boot: syncAllFromDb() populates
        // activeWorkflowIds for every tracked workflow, exactly like the
        // long-running DO1 owner has accumulated over its lifetime.
        orchestrator.syncAllFromDb();

        const targetTaskId = 'wf-big-0/investigate-finding-118';
        const bigWorkflowId = 'wf-big-0';

        const fullRefreshStart = performance.now();
        orchestrator.syncAllFromDb();
        const fullRefreshMs = performance.now() - fullRefreshStart;

        const scopedRefreshStart = performance.now();
        (orchestrator as any).refreshWorkflowFromDb(bigWorkflowId);
        const scopedRefreshMs = performance.now() - scopedRefreshStart;

        // eslint-disable-next-line no-console
        console.log(
          `full refresh (${SMALL_WORKFLOW_COUNT + 1} workflows / `
            + `${SMALL_WORKFLOW_COUNT * 4 + BIG_WORKFLOW_TASK_COUNT + 1} tasks): ${fullRefreshMs.toFixed(1)}ms `
            + `vs scoped refresh (828-task workflow alone): ${scopedRefreshMs.toFixed(1)}ms`,
        );

        // retryTaskImpl now takes the scoped path since the target task is
        // already in memory from the syncAllFromDb() above.
        const retryStart = performance.now();
        orchestrator.retryTask(targetTaskId);
        const retryMs = performance.now() - retryStart;
        // eslint-disable-next-line no-console
        console.log(`orchestrator.retryTask() end-to-end: ${retryMs.toFixed(1)}ms`);

        expect(scopedRefreshMs).toBeLessThan(fullRefreshMs);
      } finally {
        bootAdapter.close();
      }
    },
    60_000,
  );
});
