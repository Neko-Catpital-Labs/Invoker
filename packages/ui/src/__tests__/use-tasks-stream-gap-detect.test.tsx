import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useTasks } from '../hooks/useTasks.js';
import { makeUITask } from './helpers/mock-invoker.js';

interface TaskSnapshot {
  tasks: ReturnType<typeof makeUITask>[];
  workflows: unknown[];
  streamSequence: number;
}

function installInvoker(opts: {
  bootstrap?: { tasks: ReturnType<typeof makeUITask>[]; streamSequence: number };
  responses: TaskSnapshot[];
}): {
  getTasksMock: ReturnType<typeof vi.fn>;
  reportUiPerfMock: ReturnType<typeof vi.fn>;
  onTaskGraphEventMock: ReturnType<typeof vi.fn>;
  refreshTaskGraphMock: ReturnType<typeof vi.fn>;
  fireDelta: (delta: unknown) => void;
} {
  let handler: ((event: unknown) => void) | undefined;

  (window as unknown as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__ = opts.bootstrap
    ? { tasks: opts.bootstrap.tasks, workflows: [], streamSequence: opts.bootstrap.streamSequence }
    : { tasks: [], workflows: [] };

  const queue = [...opts.responses];
  const lastResponse = opts.responses[opts.responses.length - 1];
  const getTasksMock = vi.fn(async () => queue.shift() ?? lastResponse);
  const reportUiPerfMock = vi.fn();
  const refreshTaskGraphMock = vi.fn(async () => {
    const response = queue.shift() ?? lastResponse;
    queueMicrotask(() => {
      handler?.({
        type: 'snapshot',
        tasks: response.tasks,
        workflows: response.workflows,
        reason: 'test-refresh',
        streamSequence: response.streamSequence,
      });
    });
  });
  const onTaskGraphEventMock = vi.fn((cb: (event: unknown) => void) => {
    handler = cb;
    return () => { handler = undefined; };
  });

  (window as unknown as { invoker: Record<string, unknown> }).invoker = {
    getTasks: getTasksMock,
    refreshTaskGraph: refreshTaskGraphMock,
    reportUiPerf: reportUiPerfMock,
    onTaskGraphEvent: onTaskGraphEventMock,
    onTaskDelta: vi.fn(() => () => {}),
    onWorkflowsChanged: vi.fn(() => () => {}),
    checkPrStatuses: vi.fn(async () => {}),
  };

  return {
    getTasksMock,
    reportUiPerfMock,
    onTaskGraphEventMock,
    refreshTaskGraphMock,
    fireDelta: (delta) => handler?.({ type: 'delta', delta }),
  };
}

describe('useTasks stream-sequence gap-detect', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    delete (window as unknown as { invoker?: unknown }).invoker;
    delete (window as unknown as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__;
  });

  it('applies a contiguous 1,2,3 stream without re-syncing', async () => {
    const t1 = makeUITask({ id: 't1', status: 'pending' });
    const t2 = makeUITask({ id: 't2', status: 'pending' });
    const t3 = makeUITask({ id: 't3', status: 'pending' });

    const { getTasksMock, reportUiPerfMock, onTaskGraphEventMock, fireDelta } = installInvoker({
      bootstrap: { tasks: [t1, t2, t3], streamSequence: 0 },
      responses: [{ tasks: [t1, t2, t3], workflows: [], streamSequence: 0 }],
    });

    const { result } = renderHook(() => useTasks());

    await waitFor(() => {
      expect(onTaskGraphEventMock).toHaveBeenCalledTimes(1);
    });
    expect(getTasksMock).not.toHaveBeenCalled();

    await act(async () => {
      fireDelta({ type: 'updated', taskId: 't1', changes: { status: 'running' }, taskStateVersion: 2, previousTaskStateVersion: 1, streamSequence: 1 });
      fireDelta({ type: 'updated', taskId: 't2', changes: { status: 'running' }, taskStateVersion: 2, previousTaskStateVersion: 1, streamSequence: 2 });
      fireDelta({ type: 'updated', taskId: 't3', changes: { status: 'running' }, taskStateVersion: 2, previousTaskStateVersion: 1, streamSequence: 3 });
      await new Promise((resolve) => setTimeout(resolve, 130));
    });

    expect(result.current.tasks.get('t1')?.status).toBe('running');
    expect(result.current.tasks.get('t2')?.status).toBe('running');
    expect(result.current.tasks.get('t3')?.status).toBe('running');
    expect(getTasksMock).not.toHaveBeenCalled();
    expect(reportUiPerfMock.mock.calls.filter((c) => c[0] === 'ui_delta_stream_gap_detected')).toHaveLength(0);
  });

  it('detects a 1,2,4 gap and triggers exactly one re-sync via refreshTaskGraph', async () => {
    const initial = [
      makeUITask({ id: 't1', status: 'pending' }),
      makeUITask({ id: 't2', status: 'pending' }),
      makeUITask({ id: 't3', status: 'pending' }),
    ];
    const post = [
      makeUITask({ id: 't1', status: 'running' }),
      makeUITask({ id: 't2', status: 'running' }),
      makeUITask({ id: 't3', status: 'running' }),
    ];

    const { getTasksMock, refreshTaskGraphMock, reportUiPerfMock, onTaskGraphEventMock, fireDelta } = installInvoker({
      bootstrap: { tasks: initial, streamSequence: 0 },
      responses: [
        { tasks: post, workflows: [], streamSequence: 4 },
      ],
    });

    const { result } = renderHook(() => useTasks());

    await waitFor(() => {
      expect(onTaskGraphEventMock).toHaveBeenCalledTimes(1);
    });
    expect(getTasksMock).not.toHaveBeenCalled();

    await act(async () => {
      fireDelta({ type: 'updated', taskId: 't1', changes: { status: 'running' }, taskStateVersion: 2, previousTaskStateVersion: 1, streamSequence: 1 });
      fireDelta({ type: 'updated', taskId: 't2', changes: { status: 'running' }, taskStateVersion: 2, previousTaskStateVersion: 1, streamSequence: 2 });
      fireDelta({ type: 'updated', taskId: 't3', changes: { status: 'running' }, taskStateVersion: 2, previousTaskStateVersion: 1, streamSequence: 4 });
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    await waitFor(() => {
      expect(refreshTaskGraphMock).toHaveBeenCalledTimes(1);
      expect(getTasksMock).not.toHaveBeenCalled();
    });

    const gapReports = reportUiPerfMock.mock.calls.filter((c) => c[0] === 'ui_delta_stream_gap_detected');
    expect(gapReports).toHaveLength(1);
    expect(gapReports[0][1]).toMatchObject({ expected: 3, actual: 4, gapSize: 1 });

    await waitFor(() => {
      expect(result.current.tasks.get('t1')?.status).toBe('running');
      expect(result.current.tasks.get('t2')?.status).toBe('running');
      expect(result.current.tasks.get('t3')?.status).toBe('running');
    });
  });

  it('drops deltas whose sequence is <= the post-resync watermark (stale replays)', async () => {
    const initial = [makeUITask({ id: 't1', status: 'pending' })];
    const post = [makeUITask({ id: 't1', status: 'completed' })];

    const { getTasksMock, refreshTaskGraphMock, onTaskGraphEventMock, fireDelta } = installInvoker({
      bootstrap: { tasks: initial, streamSequence: 0 },
      responses: [
        { tasks: post, workflows: [], streamSequence: 10 },
      ],
    });

    const { result } = renderHook(() => useTasks());

    await waitFor(() => {
      expect(onTaskGraphEventMock).toHaveBeenCalledTimes(1);
    });
    expect(getTasksMock).not.toHaveBeenCalled();

    await act(async () => {
      fireDelta({ type: 'updated', taskId: 't1', changes: { status: 'running' }, taskStateVersion: 2, previousTaskStateVersion: 1, streamSequence: 1 });
      fireDelta({ type: 'updated', taskId: 't1', changes: { status: 'running' }, taskStateVersion: 6, previousTaskStateVersion: 5, streamSequence: 5 });
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    await waitFor(() => {
      expect(refreshTaskGraphMock).toHaveBeenCalledTimes(1);
      expect(result.current.tasks.get('t1')?.status).toBe('completed');
    });

    await act(async () => {
      fireDelta({ type: 'updated', taskId: 't1', changes: { status: 'failed' }, taskStateVersion: 8, previousTaskStateVersion: 7, streamSequence: 7 });
      await new Promise((resolve) => setTimeout(resolve, 130));
    });

    expect(result.current.tasks.get('t1')?.status).toBe('completed');
    expect(refreshTaskGraphMock).toHaveBeenCalledTimes(1);
  });

  it('triggers only ONE re-sync when multiple gaps arrive in quick succession', async () => {
    const initial = [makeUITask({ id: 't1', status: 'pending' })];
    const post = [makeUITask({ id: 't1', status: 'completed' })];

    const { getTasksMock, refreshTaskGraphMock, reportUiPerfMock, onTaskGraphEventMock, fireDelta } = installInvoker({
      bootstrap: { tasks: initial, streamSequence: 0 },
      responses: [
        { tasks: post, workflows: [], streamSequence: 100 },
      ],
    });

    renderHook(() => useTasks());

    await waitFor(() => {
      expect(onTaskGraphEventMock).toHaveBeenCalledTimes(1);
    });
    expect(getTasksMock).not.toHaveBeenCalled();

    await act(async () => {
      fireDelta({ type: 'updated', taskId: 't1', changes: { status: 'running' }, taskStateVersion: 2, previousTaskStateVersion: 1, streamSequence: 5 });
      fireDelta({ type: 'updated', taskId: 't1', changes: { status: 'running' }, taskStateVersion: 3, previousTaskStateVersion: 2, streamSequence: 7 });
      fireDelta({ type: 'updated', taskId: 't1', changes: { status: 'running' }, taskStateVersion: 4, previousTaskStateVersion: 3, streamSequence: 9 });
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    expect(refreshTaskGraphMock).toHaveBeenCalledTimes(1);
    const gapReports = reportUiPerfMock.mock.calls.filter((c) => c[0] === 'ui_delta_stream_gap_detected');
    expect(gapReports).toHaveLength(1);
  });

  it('skips gap-check for deltas without a streamSequence (backward compatibility)', async () => {
    const t1 = makeUITask({ id: 't1', status: 'pending' });

    const { getTasksMock, reportUiPerfMock, onTaskGraphEventMock, fireDelta } = installInvoker({
      bootstrap: { tasks: [t1], streamSequence: 0 },
      responses: [{ tasks: [t1], workflows: [], streamSequence: 0 }],
    });

    const { result } = renderHook(() => useTasks());

    await waitFor(() => {
      expect(onTaskGraphEventMock).toHaveBeenCalledTimes(1);
    });
    expect(getTasksMock).not.toHaveBeenCalled();

    await act(async () => {
      fireDelta({ type: 'updated', taskId: 't1', changes: { status: 'running' }, taskStateVersion: 2, previousTaskStateVersion: 1 });
      await new Promise((resolve) => setTimeout(resolve, 130));
    });

    expect(result.current.tasks.get('t1')?.status).toBe('running');
    expect(getTasksMock).not.toHaveBeenCalled();
    expect(reportUiPerfMock.mock.calls.filter((c) => c[0] === 'ui_delta_stream_gap_detected')).toHaveLength(0);
  });
});
