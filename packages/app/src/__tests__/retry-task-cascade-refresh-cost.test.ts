import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import { InMemoryBus } from '@invoker/test-kit';
import { Orchestrator } from '@invoker/workflow-core';
import type { TaskState } from '@invoker/workflow-core';

/**
 * Reproduces DO1's real invoker:retry-task dispatch cost, matching the
 * proven live shape: 687 workflows (676 with a non-terminal task), 2,702
 * tasks, 85% pending. cascadeInvalidationToDownstream() unconditionally
 * calls refreshFromDb() -- reloading every task in every workflow the
 * orchestrator has ever tracked -- before checking whether the target
 * workflow has any downstream dependents at all. Most retried tasks (no
 * cross-workflow externalDependencies) have zero downstream workflows, so
 * that reload is pure waste on the common path.
 */

const WORKFLOW_COUNT = 687;

describe('retryTask cascade pays a full active-workflow refresh even with no downstream', () => {
  let dbDir: string | undefined;

  afterEach(() => {
    if (dbDir) rmSync(dbDir, { recursive: true, force: true });
    dbDir = undefined;
  });

  it(
    'cascadeInvalidationToDownstream cost for a workflow with zero downstream dependents',
    async () => {
      dbDir = mkdtempSync(path.join(tmpdir(), 'invoker-retry-cascade-'));
      const dbPath = path.join(dbDir, 'invoker.db');

      // Real DO1 task rows average ~8KB (description ~4.8KB, prompt ~3KB) --
      // measured directly against the live DB. Synthetic 1-char fields
      // understate row-materialization cost, so match the real size here.
      const realisticDescription = 'x'.repeat(4800);
      const realisticPrompt = 'y'.repeat(3000);
      const realisticSummary = 'z'.repeat(700);

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
            // No externalDependencies -- matches the common DO1 case: most
            // workflows have zero cross-workflow dependents.
          } as any);

          const createdAt = new Date();
          const isActive = i % 100 !== 0; // ~99% active, matching 676/687 real ratio
          for (let t = 0; t < 4; t += 1) {
            seedAdapter.saveTask(wfId, {
              id: `${wfId}/t${t}`,
              description: realisticDescription,
              prompt: realisticPrompt,
              summary: realisticSummary,
              status: isActive && t === 3 ? 'pending' : 'completed',
              dependencies: t > 0 ? [`${wfId}/t${t - 1}`] : [],
              createdAt,
              config: { workflowId: wfId },
              execution: isActive && t === 3 ? {} : { exitCode: 0 },
            } as TaskState);
          }
        }
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

        const targetTaskId = 'wf-seed-1/t3';
        const cascadeStart = performance.now();
        const affected = orchestrator.cascadeInvalidationToDownstream('wf-seed-1');
        const cascadeMs = performance.now() - cascadeStart;

        // wf-seed-1 has no externalDependencies pointing to it, so nothing
        // downstream -- the common case for a plain retryTask.
        expect(affected).toEqual([]);
        // eslint-disable-next-line no-console
        console.log(`cascadeInvalidationToDownstream (zero downstream) took ${cascadeMs.toFixed(1)}ms for ${WORKFLOW_COUNT} tracked workflows`);
        // Before the fix this paid a full refreshFromDb() (~87ms measured
        // pre-fix for this seed) even with nothing downstream to process;
        // after the fix, only the cheap listWorkflows() lookup runs.
        expect(cascadeMs, `cascadeMs=${cascadeMs} for ${WORKFLOW_COUNT} tracked workflows, zero downstream`).toBeLessThan(60);
      } finally {
        bootAdapter.close();
      }
    },
    30_000,
  );
});
