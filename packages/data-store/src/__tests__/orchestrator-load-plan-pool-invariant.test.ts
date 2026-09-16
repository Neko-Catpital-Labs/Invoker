import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILT_IN_LOCAL_EXECUTION_POOL_ID, Orchestrator } from '@invoker/workflow-core';
import type { OrchestratorMessageBus } from '@invoker/workflow-core';
import { SQLiteAdapter } from '../sqlite-adapter.js';

class NoopBus implements OrchestratorMessageBus {
  publish(): void {}
  subscribe(): () => void {
    return () => undefined;
  }
}

describe('SQLite-backed Orchestrator.loadPlan pool invariant', () => {
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

  it('persists default worktree tasks with a concrete built-in pool', async () => {
    cleanupDir = mkdtempSync(join(tmpdir(), 'invoker-load-plan-pool-invariant-'));
    adapter = await SQLiteAdapter.create(join(cleanupDir, 'invoker.db'), { ownerCapability: true });

    const orchestrator = new Orchestrator({
      persistence: adapter,
      messageBus: new NoopBus(),
      maxConcurrency: 1,
      resolveRepoDefaultBranch: () => 'master',
    });

    orchestrator.loadPlan({
      name: 'pool invariant repro',
      repoUrl: 'memory://repo',
      tasks: [{ id: 'root', description: 'root', command: 'echo root' }],
    });

    const task = adapter.loadTask(orchestrator.getWorkflowIds()[0] + '/root');
    expect(task?.config).toMatchObject({
      runnerKind: 'worktree',
      poolId: BUILT_IN_LOCAL_EXECUTION_POOL_ID,
    });
  });
});
