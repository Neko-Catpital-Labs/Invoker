import { afterEach, describe, expect, it, vi } from 'vitest';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import type { Workflow } from '../adapter.js';

const testWorkflow: Workflow = {
  id: 'wf-timing',
  name: 'Timing Workflow',
  status: 'running',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('SQLiteAdapter transaction timing hooks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits committed and rolled-back transaction durations without changing SQL results', async () => {
    const onTransactionDuration = vi.fn();
    const adapter = await SQLiteAdapter.create(':memory:', { onTransactionDuration });
    onTransactionDuration.mockClear();

    try {
      const result = adapter.runInTransaction(() => {
        adapter.saveWorkflow(testWorkflow);
        return 'committed-result';
      });

      expect(result).toBe('committed-result');
      expect(adapter.loadWorkflow(testWorkflow.id)).toBeDefined();

      expect(() =>
        adapter.runInTransaction(() => {
          adapter.saveWorkflow({ ...testWorkflow, id: 'wf-rolled-back' });
          throw new Error('rollback sentinel');
        }),
      ).toThrow('rollback sentinel');

      expect(adapter.loadWorkflow('wf-rolled-back')).toBeUndefined();
      expect(onTransactionDuration).toHaveBeenCalledTimes(2);
      expect(onTransactionDuration.mock.calls.map(([info]) => info.outcome)).toEqual([
        'committed',
        'rolled_back',
      ]);
      for (const [info] of onTransactionDuration.mock.calls) {
        expect(info.durationMs).toEqual(expect.any(Number));
        expect(info.durationMs).toBeGreaterThanOrEqual(0);
      }
    } finally {
      adapter.close();
    }
  });

  it('does not let transaction duration callback failures escape runTransaction', async () => {
    const onTransactionDuration = vi.fn(() => {
      throw new Error('observer failed');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = await SQLiteAdapter.create(':memory:', { onTransactionDuration });
    onTransactionDuration.mockClear();

    try {
      expect(
        adapter.runInTransaction(() => {
          adapter.saveWorkflow({ ...testWorkflow, id: 'wf-observer-failure' });
          return 'result survives observer failure';
        }),
      ).toBe('result survives observer failure');

      expect(adapter.loadWorkflow('wf-observer-failure')).toBeDefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('onTransactionDuration callback failed'));
    } finally {
      adapter.close();
    }
  });

  it('emits busy failures and preserves the original SQLite error', async () => {
    const onBusyFailure = vi.fn(() => {
      throw new Error('busy observer failed');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = await SQLiteAdapter.create(':memory:', { onBusyFailure });
    const internalDb = (adapter as unknown as { db: { run(sql: string, params?: unknown[]): void } }).db;
    const originalRun = internalDb.run.bind(internalDb);
    const busyError = Object.assign(new Error('database is busy'), { errcode: 5 });
    vi.spyOn(internalDb, 'run').mockImplementation((sql: string, params?: unknown[]) => {
      if (sql === 'BEGIN IMMEDIATE') throw busyError;
      return originalRun(sql, params);
    });

    try {
      expect(() => adapter.runInTransaction(() => 'unreached')).toThrow(busyError);
      expect(onBusyFailure).toHaveBeenCalledTimes(1);
      expect(onBusyFailure).toHaveBeenCalledWith(expect.objectContaining({
        operation: 'transaction_begin',
        durationMs: expect.any(Number),
        message: 'database is busy',
        errcode: 5,
      }));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('onBusyFailure callback failed'));
    } finally {
      adapter.close();
    }
  });
});
