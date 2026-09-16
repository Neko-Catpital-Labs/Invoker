import { afterEach, describe, expect, it, vi } from 'vitest';
import { Orchestrator } from '@invoker/workflow-core';
import type { OrchestratorMessageBus } from '@invoker/workflow-core';
import { SQLiteAdapter } from '../sqlite-adapter.js';

class NoopBus implements OrchestratorMessageBus {
  publish(): void {}
  subscribe(): () => void {
    return () => undefined;
  }
}

function sqliteScalar(db: SQLiteAdapter, sql: string): number {
  const result = (db as any).db.exec(sql) as Array<{ values: unknown[][] }>;
  return Number(result[0]?.values?.[0]?.[0] ?? 0);
}

describe('loadPlan transactionality with SQLite persistence', () => {
  let adapter: SQLiteAdapter | undefined;

  afterEach(() => {
    adapter?.close();
    adapter = undefined;
  });

  it('rolls back workflow and task rows when event logging fails during intake', async () => {
    adapter = await SQLiteAdapter.create(':memory:', { ownerCapability: true });
    const originalLogEvents = adapter.logEvents.bind(adapter);
    vi.spyOn(adapter, 'logEvents').mockImplementation((events) => {
      originalLogEvents(events.slice(0, 1));
      throw new Error('simulated loadPlan event failure');
    });

    const orchestrator = new Orchestrator({
      persistence: adapter,
      messageBus: new NoopBus(),
      maxConcurrency: 1,
      resolveRepoDefaultBranch: () => 'master',
    });

    expect(() => orchestrator.loadPlan({
      name: 'atomic intake',
      repoUrl: 'memory://atomic-intake',
      baseBranch: 'master',
      featureBranch: 'plan/atomic-intake',
      tasks: [
        { id: 'first', description: 'first task' },
        { id: 'second', description: 'second task', dependencies: ['first'] },
      ],
    })).toThrow('simulated loadPlan event failure');

    expect(adapter.listWorkflows()).toEqual([]);
    expect(sqliteScalar(adapter, 'SELECT COUNT(*) FROM tasks')).toBe(0);
    expect(sqliteScalar(adapter, 'SELECT COUNT(*) FROM events')).toBe(0);
    expect(sqliteScalar(adapter, 'SELECT COUNT(*) FROM sync_journal')).toBe(0);
  });
});
