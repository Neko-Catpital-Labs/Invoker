/**
 * Repro: a headless `delete <workflowId>` delegated to an owner process can
 * time out client-side (DEFAULT_DELEGATION_TIMEOUT_MS in headless-delegation.ts)
 * while the original owner keeps processing it. If the client then bootstraps
 * a second, competing owner that re-runs the same delete after the first
 * owner's delete has already landed, the second owner's stale in-memory task
 * cache makes `preemptWorkflowExecution` (the first step of
 * `headlessDeleteWorkflow`) try to cancel a task that no longer exists in the
 * DB, which throws a raw "FOREIGN KEY constraint failed" instead of the clean
 * "already gone" outcome used elsewhere for idempotent delete races.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Orchestrator, CommandService } from '@invoker/workflow-core';
import type { OrchestratorMessageBus } from '@invoker/workflow-core';
import { SQLiteAdapter } from '@invoker/data-store';
import { preemptWorkflowExecution, type HeadlessDeps } from '../headless-shared.js';

class NoopBus implements OrchestratorMessageBus {
  publish(): void {}
  subscribe(): () => void {
    return () => undefined;
  }
}

describe('headlessDeleteWorkflow race: second owner preempting an already-deleted workflow', () => {
  let adapter1: SQLiteAdapter | undefined;
  let adapter2: SQLiteAdapter | undefined;
  let cleanupDir: string | undefined;

  afterEach(() => {
    adapter1?.close();
    adapter2?.close();
    adapter1 = undefined;
    adapter2 = undefined;
    if (cleanupDir) {
      rmSync(cleanupDir, { recursive: true, force: true });
      cleanupDir = undefined;
    }
  });

  it('preemptWorkflowExecution returns a clean no-op instead of throwing the raw FK error', async () => {
    cleanupDir = mkdtempSync(join(tmpdir(), 'invoker-delete-race-'));
    const dbPath = join(cleanupDir, 'invoker.db');

    adapter1 = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    const orchestrator1 = new Orchestrator({
      persistence: adapter1,
      messageBus: new NoopBus(),
      maxConcurrency: 8,
      resolveRepoDefaultBranch: () => 'main',
    });
    orchestrator1.loadPlan({
      name: 'wf1',
      baseBranch: 'master',
      repoUrl: 'memory://test-repo',
      featureBranch: 'feature/wf1',
      tasks: [{ id: 'leaf', description: 'leaf task' }],
    });
    const workflowId = orchestrator1.getAllTasks()
      .find((t) => !t.config.isMergeNode)!.config.workflowId!;

    // Owner2: a second, separate owner process with its own writable
    // connection to the same DB file. It has already cached this workflow's
    // tasks in memory (e.g. from an earlier sync) before owner1 deletes it.
    adapter2 = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    const orchestrator2 = new Orchestrator({
      persistence: adapter2,
      messageBus: new NoopBus(),
      maxConcurrency: 8,
      resolveRepoDefaultBranch: () => 'main',
    });
    orchestrator2.syncAllFromDb();
    expect(orchestrator2.getAllTasks().some((t) => t.config.workflowId === workflowId)).toBe(true);
    const commandService2 = new CommandService(orchestrator2);

    // Owner1's delete lands first.
    orchestrator1.deleteWorkflow(workflowId);
    expect(adapter1.loadWorkflow(workflowId)).toBeUndefined();

    // Owner2 re-runs the same delegated delete; headlessDeleteWorkflow's
    // first step is exactly this preemption call.
    const deps2 = {
      orchestrator: orchestrator2,
      persistence: adapter2,
      commandService: commandService2,
    } as unknown as HeadlessDeps;

    await expect(preemptWorkflowExecution(workflowId, deps2)).resolves.toEqual({
      cancelled: [],
      runningCancelled: [],
    });
  });
});
