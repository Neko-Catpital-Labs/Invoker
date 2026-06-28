import { describe, it, expect, vi } from 'vitest';
import {
  answerOwnerReadQuery,
  buildOwnerReadQueryHandlers,
  type OwnerReadQueryHandlers,
} from '../owner-read-query.js';

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
    listWorkflows: vi.fn(() => [{ id: 'wf-1' }]),
    loadWorkflowBundle: vi.fn((id: string) => ({ workflow: { id }, tasks: [] })),
    getReviewGate: vi.fn(() => ({ gate: true })),
    getEvents: vi.fn(() => [{ e: 1 }]),
    getTaskById: vi.fn((id: string) => ({ id })),
    getTaskOutput: vi.fn(() => 'output-text'),
    getOutputChunks: vi.fn(() => [{ c: 1 }]),
    getOutputTail: vi.fn(() => ({ tail: 1 })),
    replayOutput: vi.fn((id: string, off: number) => [{ id, off }]),
    getAllCompletedTasks: vi.fn(() => [{ id: 'done' }]),
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

  it('routes the snapshot kinds to their handlers', () => {
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

  it('wraps and routes the param-bearing read kinds', () => {
    const h = makeHandlers();
    expect(answerOwnerReadQuery({ kind: 'workflows' }, h)).toEqual({ workflows: [{ id: 'wf-1' }] });
    expect(answerOwnerReadQuery({ kind: 'workflow', workflowId: 'wf-9' }, h)).toEqual({ workflow: { id: 'wf-9' }, tasks: [] });
    expect(h.loadWorkflowBundle).toHaveBeenCalledWith('wf-9');
    expect(answerOwnerReadQuery({ kind: 'review-gate', workflowId: 'wf-9' }, h)).toEqual({ reviewGate: { gate: true } });
    expect(answerOwnerReadQuery({ kind: 'events', taskId: 't-1' }, h)).toEqual({ events: [{ e: 1 }] });
    expect(h.getEvents).toHaveBeenCalledWith('t-1');
    expect(answerOwnerReadQuery({ kind: 'task-by-id', taskId: 't-1' }, h)).toEqual({ task: { id: 't-1' } });
    expect(answerOwnerReadQuery({ kind: 'task-output', taskId: 't-1' }, h)).toEqual({ output: 'output-text' });
    expect(answerOwnerReadQuery({ kind: 'output-chunks', taskId: 't-1' }, h)).toEqual({ chunks: [{ c: 1 }] });
    expect(answerOwnerReadQuery({ kind: 'output-tail', taskId: 't-1' }, h)).toEqual({ tail: { tail: 1 } });
    expect(answerOwnerReadQuery({ kind: 'replay-output', taskId: 't-1', fromOffset: 42 }, h)).toEqual({ chunks: [{ id: 't-1', off: 42 }] });
    expect(h.replayOutput).toHaveBeenCalledWith('t-1', 42);
    expect(answerOwnerReadQuery({ kind: 'all-completed-tasks' }, h)).toEqual({ tasks: [{ id: 'done' }] });
  });

  it('null-coalesces task-by-id, review-gate, and output-tail', () => {
    const h = makeHandlers({
      getTaskById: vi.fn(() => undefined),
      getReviewGate: vi.fn(() => undefined),
      getOutputTail: vi.fn(() => undefined),
    });
    expect(answerOwnerReadQuery({ kind: 'task-by-id', taskId: 'x' }, h)).toEqual({ task: null });
    expect(answerOwnerReadQuery({ kind: 'review-gate', workflowId: 'x' }, h)).toEqual({ reviewGate: null });
    expect(answerOwnerReadQuery({ kind: 'output-tail', taskId: 'x' }, h)).toEqual({ tail: null });
  });

  it('calls onActivity once per query and rejects unknown kinds', () => {
    const h = makeHandlers();
    answerOwnerReadQuery({ kind: 'queue' }, h);
    expect(h.onActivity).toHaveBeenCalledTimes(1);
    expect(() => answerOwnerReadQuery({ kind: 'bogus' }, h)).toThrow(/Unsupported headless query: bogus/);
    expect(() => answerOwnerReadQuery({}, h)).toThrow(/Unsupported headless query: undefined/);
  });

  it('rejects malformed params before invoking handlers', () => {
    const h = makeHandlers();
    // Missing workflowId must not reach loadWorkflowBundle('') (which would
    // syncFromDb('') and mutate the owner cache for an invalid id).
    expect(() => answerOwnerReadQuery({ kind: 'workflow' }, h)).toThrow(/workflowId/);
    expect(h.loadWorkflowBundle).not.toHaveBeenCalled();
    expect(() => answerOwnerReadQuery({ kind: 'review-gate' }, h)).toThrow(/workflowId/);
    expect(() => answerOwnerReadQuery({ kind: 'events' }, h)).toThrow(/taskId/);
    expect(() => answerOwnerReadQuery({ kind: 'task-by-id' }, h)).toThrow(/taskId/);
    expect(h.getEvents).not.toHaveBeenCalled();
    // Non-finite / negative replay offsets must be rejected too.
    expect(() => answerOwnerReadQuery({ kind: 'replay-output', taskId: 't', fromOffset: -1 }, h)).toThrow(/fromOffset/);
    expect(() => answerOwnerReadQuery({ kind: 'replay-output', taskId: 't', fromOffset: Number.NaN }, h)).toThrow(/fromOffset/);
    expect(h.replayOutput).not.toHaveBeenCalled();
  });
});

describe('buildOwnerReadQueryHandlers', () => {
  function fakes() {
    return {
      orchestrator: {
        getQueueStatus: () => ({ q: 1 }),
        getWorkflowStatus: () => ({ w: 1 }),
        getAllTasks: () => [{ id: 't' }],
        syncAllFromDb: vi.fn(),
        syncFromDb: vi.fn(),
      },
      persistence: {
        listWorkflows: () => [{ id: 'wf' }],
        loadWorkflow: (id: string) => (id === 'missing' ? undefined : { id, name: 'n' }),
        loadTasks: () => [{ id: 't', config: {} }],
        loadTask: (id: string) => ({ id }),
        getEvents: () => [{ e: 1 }],
        getTaskOutput: () => 'out',
        getOutputChunks: () => [{ c: 1 }],
        getOutputTail: () => ({ t: 1 }),
        replayOutputFrom: (id: string, off: number) => [{ id, off }],
        loadAllCompletedTasks: () => [{ id: 'done' }],
      },
    };
  }
  function build(orch: Record<string, unknown> = {}, persist: Record<string, unknown> = {}) {
    const f = fakes();
    return buildOwnerReadQueryHandlers({
      ownerModeLabel: 'gui',
      getUiPerfStats: () => ({}),
      resetUiPerfStats: () => {},
      getStreamSequence: () => 5,
      resolveInvokerHomeRoot: () => '/home',
      orchestrator: { ...f.orchestrator, ...orch } as never,
      persistence: { ...f.persistence, ...persist } as never,
      getActionGraphSnapshot: () => ({ ag: 1 }),
    });
  }

  it('passes reads straight through to persistence', () => {
    const h = build();
    expect(h.listWorkflows()).toEqual([{ id: 'wf' }]);
    expect(h.getEvents('t1')).toEqual([{ e: 1 }]);
    expect(h.getTaskOutput('t1')).toBe('out');
    expect(h.getTaskById('t1')).toEqual({ id: 't1' });
    expect(h.getOutputChunks('t1')).toEqual([{ c: 1 }]);
    expect(h.replayOutput('t1', 9)).toEqual([{ id: 't1', off: 9 }]);
    expect(h.getAllCompletedTasks()).toEqual([{ id: 'done' }]);
  });

  it('loadWorkflowBundle syncs that workflow first, then returns workflow + tasks', () => {
    const syncFromDb = vi.fn();
    const h = build({ syncFromDb });
    expect(h.loadWorkflowBundle('wf-9')).toEqual({ workflow: { id: 'wf-9', name: 'n' }, tasks: [{ id: 't', config: {} }] });
    expect(syncFromDb).toHaveBeenCalledWith('wf-9');
  });

  it('getReviewGate returns null for an unknown workflow', () => {
    expect(build().getReviewGate('missing')).toBeNull();
  });

  it('getTasksSnapshot refreshes only when asked', () => {
    const syncAllFromDb = vi.fn();
    const h = build({ syncAllFromDb });
    expect(h.getTasksSnapshot({ refresh: false })).toEqual({
      tasks: [{ id: 't' }],
      workflows: [{ id: 'wf' }],
      streamSequence: 5,
      invokerHomeRoot: '/home',
    });
    expect(syncAllFromDb).not.toHaveBeenCalled();
    h.getTasksSnapshot({ refresh: true });
    expect(syncAllFromDb).toHaveBeenCalledTimes(1);
  });
});
