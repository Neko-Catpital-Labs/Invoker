import { describe, it, expect, vi } from 'vitest';
import { answerOwnerReadQuery, type OwnerReadQueryHandlers } from '../owner-read-query.js';

function makeHandlers(over: Partial<OwnerReadQueryHandlers> = {}): OwnerReadQueryHandlers {
  return {
    ownerModeLabel: 'gui',
    onActivity: vi.fn(),
    getUiPerfStats: vi.fn(() => ({ mainDeltaToUi: 7 })),
    resetUiPerfStats: vi.fn(),
    getQueueStatus: vi.fn(() => ({ runningCount: 2 })),
    getWorkflowStatus: vi.fn(() => ({ 'wf-1': 'running' })),
    getTasksSnapshot: vi.fn(({ refresh }) => ({ tasks: [], workflows: [], refreshed: refresh })),
    getActionGraphSnapshot: vi.fn(() => ({ nodes: [] })),
    ...over,
  };
}

describe('answerOwnerReadQuery', () => {
  it('ui-perf merges the owner label with the stats; reset only when asked', () => {
    const h = makeHandlers({ ownerModeLabel: 'standalone' });
    expect(answerOwnerReadQuery({ kind: 'ui-perf' }, h)).toEqual({ ownerMode: 'standalone', mainDeltaToUi: 7 });
    expect(h.resetUiPerfStats).not.toHaveBeenCalled();
    answerOwnerReadQuery({ kind: 'ui-perf', reset: true }, h);
    expect(h.resetUiPerfStats).toHaveBeenCalledTimes(1);
  });

  it('routes each read kind to its handler', () => {
    const h = makeHandlers();
    expect(answerOwnerReadQuery({ kind: 'queue' }, h)).toEqual({ runningCount: 2 });
    expect(answerOwnerReadQuery({ kind: 'workflow-status' }, h)).toEqual({ 'wf-1': 'running' });
    expect(answerOwnerReadQuery({ kind: 'action-graph' }, h)).toEqual({ nodes: [] });
  });

  it('refreshes the snapshot only for task-graph-refresh', () => {
    const h = makeHandlers();
    expect(answerOwnerReadQuery({ kind: 'tasks' }, h)).toMatchObject({ refreshed: false });
    expect(answerOwnerReadQuery({ kind: 'task-graph-refresh' }, h)).toMatchObject({ refreshed: true });
    expect(h.getTasksSnapshot).toHaveBeenNthCalledWith(1, { refresh: false });
    expect(h.getTasksSnapshot).toHaveBeenNthCalledWith(2, { refresh: true });
  });

  it('calls onActivity once per query and rejects unknown kinds', () => {
    const h = makeHandlers();
    answerOwnerReadQuery({ kind: 'queue' }, h);
    expect(h.onActivity).toHaveBeenCalledTimes(1);
    expect(() => answerOwnerReadQuery({ kind: 'bogus' }, h)).toThrow(/Unsupported headless query: bogus/);
    expect(() => answerOwnerReadQuery({}, h)).toThrow(/Unsupported headless query: undefined/);
  });
});
