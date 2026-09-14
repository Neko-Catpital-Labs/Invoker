import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import { InMemoryBus } from '@invoker/test-kit';
import { Orchestrator } from '@invoker/workflow-core';

describe('plan intake transaction', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('leaves no stored workflow when a task write fails partway through intake', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'invoker-plan-intake-transaction-'));
    tempDirs.push(dir);
    const persistence = await SQLiteAdapter.create(join(dir, 'invoker.db'), { ownerCapability: true });
    const orchestrator = new Orchestrator({
      persistence,
      messageBus: new InMemoryBus(),
      maxConcurrency: 1,
      resolveRepoDefaultBranch: () => 'master',
    });
    const originalSaveTask = persistence.saveTask.bind(persistence);
    let saveCount = 0;
    vi.spyOn(persistence, 'saveTask').mockImplementation((workflowId, task) => {
      saveCount += 1;
      if (saveCount === 2) throw new Error('injected task write failure');
      originalSaveTask(workflowId, task);
    });

    expect(() => orchestrator.loadPlan({
      name: 'atomic intake',
      repoUrl: 'file:///tmp/atomic-intake',
      tasks: [
        { id: 'first', description: 'first', command: 'echo first' },
        { id: 'second', description: 'second', command: 'echo second' },
      ],
    })).toThrow('injected task write failure');

    expect(persistence.listWorkflows()).toEqual([]);
    expect(persistence.getAllTaskIds()).toEqual([]);
    expect(saveCount).toBe(2);
    persistence.close();
  });
});
