/**
 * Repro: deleting (or detaching from) an upstream workflow must clear the
 * dependent's externalDependencies in the real SQLite store.
 *
 * `Orchestrator.detachWorkflowInternal` clears the last dependency by passing
 * `externalDependencies: undefined` to `updateWorkflow`. The test-kit
 * InMemoryPersistence honors that (presence semantics), but SQLiteAdapter
 * skipped undefined fields, leaving a dangling dependency row. The dependent's
 * external gate then evaluates to "missing prerequisite" forever and every
 * task in it is pinned at pending — observed live after deleting an upstream
 * workflow whose dependent had exactly one external dependency.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Orchestrator } from '@invoker/workflow-core';
import type { OrchestratorMessageBus } from '@invoker/workflow-core';
import { SQLiteAdapter } from '../sqlite-adapter.js';

class NoopBus implements OrchestratorMessageBus {
  publish(): void {}
  subscribe(): () => void {
    return () => undefined;
  }
}

describe('delete/detach upstream workflow clears dependent externalDependencies', () => {
  let adapter: SQLiteAdapter | undefined;
  let cleanupDir: string | undefined;

  afterEach(() => {
    adapter?.close();
    adapter = undefined;
    if (cleanupDir) {
      rmSync(cleanupDir, { recursive: true, force: true });
      cleanupDir = undefined;
    }
  });

  async function setupStack(): Promise<{
    orchestrator: Orchestrator;
    upstreamWfId: string;
    downstreamWfId: string;
    downstreamRootId: string;
  }> {
    cleanupDir = mkdtempSync(join(tmpdir(), 'invoker-delete-dependent-cleanup-'));
    adapter = await SQLiteAdapter.create(join(cleanupDir, 'invoker.db'), { ownerCapability: true });

    const orchestrator = new Orchestrator({
      persistence: adapter,
      messageBus: new NoopBus(),
      maxConcurrency: 8,
      resolveRepoTargetBranch: () => 'main',
    });

    orchestrator.loadPlan({
      name: 'upstream',
      baseBranch: 'master',
      repoUrl: 'memory://test-repo',
      featureBranch: 'feature/upstream',
      tasks: [{ id: 'leaf', description: 'upstream leaf' }],
    });
    const upstreamWfId = orchestrator.getAllTasks()
      .find((t) => !t.config.isMergeNode)!.config.workflowId!;

    orchestrator.loadPlan({
      name: 'downstream',
      baseBranch: 'feature/upstream',
      repoUrl: 'memory://test-repo',
      featureBranch: 'feature/downstream',
      externalDependencies: [
        { workflowId: upstreamWfId, taskId: '__merge__', requiredStatus: 'completed' },
      ],
      tasks: [{ id: 'root', description: 'downstream root' }],
    });
    const downstreamRootId = orchestrator.getAllTasks()
      .find((t) => !t.config.isMergeNode && t.id.endsWith('/root'))!.id;
    const downstreamWfId = downstreamRootId.split('/')[0]!;

    expect(adapter.loadWorkflow(downstreamWfId)!.externalDependencies).toHaveLength(1);
    return { orchestrator, upstreamWfId, downstreamWfId, downstreamRootId };
  }

  it('deleteWorkflow(upstream) clears the single dangling dependency and unblocks the dependent', async () => {
    const { orchestrator, upstreamWfId, downstreamWfId, downstreamRootId } = await setupStack();

    orchestrator.deleteWorkflow(upstreamWfId);

    const survivor = adapter!.loadWorkflow(downstreamWfId)!;
    expect(survivor.externalDependencies).toBeUndefined();
    // The detach provenance must be recorded.
    expect(survivor.externalDependencyChanges?.length ?? 0).toBeGreaterThan(0);

    // With no dangling gate the dependent's root task must dispatch.
    const started = orchestrator.startExecution();
    expect(started.map((t) => t.id)).toContain(downstreamRootId);
  });

  it('detachWorkflow with a single dependency clears it and unblocks the dependent', async () => {
    const { orchestrator, upstreamWfId, downstreamWfId, downstreamRootId } = await setupStack();

    orchestrator.detachWorkflow(downstreamWfId, upstreamWfId);

    expect(adapter!.loadWorkflow(downstreamWfId)!.externalDependencies).toBeUndefined();

    const started = orchestrator.startExecution();
    expect(started.map((t) => t.id)).toContain(downstreamRootId);
  });
});
