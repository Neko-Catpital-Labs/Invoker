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

  it('leaves no stored workflow when event logging fails after task writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'invoker-plan-intake-transaction-'));
    tempDirs.push(dir);
    const persistence = await SQLiteAdapter.create(join(dir, 'invoker.db'), { ownerCapability: true });
    const orchestrator = new Orchestrator({
      persistence,
      messageBus: new InMemoryBus(),
      maxConcurrency: 1,
      resolveRepoDefaultBranch: () => 'master',
    });
    const saveTasks = vi.spyOn(persistence, 'saveTasks');
    const logEvents = vi.spyOn(persistence, 'logEvents').mockImplementation((events) => {
      expect(events.length).toBeGreaterThan(0);
      throw new Error('injected event logging failure');
    });

    expect(() => orchestrator.loadPlan({
      name: 'atomic intake',
      repoUrl: 'file:///tmp/atomic-intake',
      tasks: [
        { id: 'first', description: 'first', command: 'echo first' },
        { id: 'second', description: 'second', command: 'echo second' },
      ],
    })).toThrow('injected event logging failure');

    expect(persistence.listWorkflows()).toEqual([]);
    expect(persistence.getAllTaskIds()).toEqual([]);
    expect(saveTasks).toHaveBeenCalledTimes(1);
    expect(logEvents).toHaveBeenCalledTimes(1);
    persistence.close();
  });
});
