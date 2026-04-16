/**
 * useTasks — workflows-changed must clear workflow metadata when main sends [].
 * Overlapping getTasks responses: older empty snapshot must not wipe after refreshTasks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useTasks } from '../hooks/useTasks.js';
import { makeUITask } from './helpers/mock-invoker.js';

describe('useTasks', () => {
  let workflowsChangedHandler: ((wfList: unknown[]) => void) | undefined;

  beforeEach(() => {
    workflowsChangedHandler = undefined;
    (window as unknown as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__ = {
      tasks: [],
      workflows: [],
    };
    (window as unknown as { invoker: Record<string, unknown> }).invoker = {
      getTasks: vi.fn().mockResolvedValue({ tasks: [], workflows: [] }),
      onTaskDelta: vi.fn(() => () => {}),
      onWorkflowsChanged: vi.fn((cb: (wfList: unknown[]) => void) => {
        workflowsChangedHandler = cb;
        return () => {};
      }),
    };
  });

  afterEach(() => {
    delete (window as unknown as { invoker?: unknown }).invoker;
    delete (window as unknown as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__;
  });

  it('hydrates initial state from preload bootstrap before async getTasks resolves', async () => {
    const bootTask = makeUITask({ id: 'boot-1', description: 'Boot Task' });
    (window as unknown as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__ = {
      tasks: [bootTask],
      workflows: [],
    };
    (window as unknown as { invoker: Record<string, unknown> }).invoker = {
      getTasks: vi.fn().mockResolvedValue({ tasks: [bootTask], workflows: [] }),
      onTaskDelta: vi.fn(() => () => {}),
      onWorkflowsChanged: vi.fn(() => () => {}),
    };

    const { result } = renderHook(() => useTasks());

    expect(result.current.tasks.get('boot-1')?.description).toBe('Boot Task');
  });

  it('clears workflows when onWorkflowsChanged receives an empty array', async () => {
    const { result } = renderHook(() => useTasks());

    await waitFor(() => {
      expect(workflowsChangedHandler).toBeDefined();
    });

    act(() => {
      workflowsChangedHandler!([
        {
          id: 'wf-1',
          name: 'Test workflow',
          status: 'completed',
        },
      ]);
    });

    expect(result.current.workflows.size).toBe(1);
    expect(result.current.workflows.get('wf-1')?.name).toBe('Test workflow');

    act(() => {
      workflowsChangedHandler!([]);
    });

    expect(result.current.workflows.size).toBe(0);
  });

  it('replaces workflows when onWorkflowsChanged receives a non-empty list', async () => {
    const { result } = renderHook(() => useTasks());

    await waitFor(() => {
      expect(workflowsChangedHandler).toBeDefined();
    });

    act(() => {
      workflowsChangedHandler!([
        { id: 'wf-a', name: 'A', status: 'running' },
        { id: 'wf-b', name: 'B', status: 'running' },
      ]);
    });

    expect(result.current.workflows.size).toBe(2);

    act(() => {
      workflowsChangedHandler!([{ id: 'wf-b', name: 'B', status: 'failed' }]);
    });

    expect(result.current.workflows.size).toBe(1);
    expect(result.current.workflows.has('wf-a')).toBe(false);
    expect(result.current.workflows.get('wf-b')?.status).toBe('failed');
  });

  it('ignores stale getTasks when a newer refresh returned tasks', async () => {
    let releaseFirst: (v: { tasks: ReturnType<typeof makeUITask>[]; workflows: unknown[] }) => void;
    const firstPending = new Promise<{ tasks: ReturnType<typeof makeUITask>[]; workflows: unknown[] }>((resolve) => {
      releaseFirst = resolve;
    });

    const t1 = makeUITask({ id: 't1', description: 'Alpha' });
    (window as unknown as { invoker: Record<string, unknown> }).invoker = {
      getTasks: vi
        .fn()
        .mockReturnValueOnce(firstPending)
        .mockResolvedValue({ tasks: [t1], workflows: [] }),
      onTaskDelta: vi.fn(() => () => {}),
      onWorkflowsChanged: vi.fn(() => () => {}),
    };

    const { result } = renderHook(() => useTasks());

    await act(async () => {
      result.current.refreshTasks();
    });

    await waitFor(() => {
      expect(result.current.tasks.size).toBe(1);
      expect(result.current.tasks.get('t1')?.description).toBe('Alpha');
    });

    await act(async () => {
      releaseFirst!({ tasks: [], workflows: [] });
    });

    expect(result.current.tasks.size).toBe(1);
    expect(result.current.tasks.get('t1')?.id).toBe('t1');
  });

  it('passes forceRefresh flag to getTasks when requested', async () => {
    const getTasks = vi.fn().mockResolvedValue({ tasks: [], workflows: [] });
    (window as unknown as { invoker: Record<string, unknown> }).invoker = {
      getTasks,
      onTaskDelta: vi.fn(() => () => {}),
      onWorkflowsChanged: vi.fn(() => () => {}),
    };

    const { result } = renderHook(() => useTasks());

    await act(async () => {
      result.current.refreshTasks(true);
    });

    await waitFor(() => {
      expect(getTasks).toHaveBeenCalled();
      expect(getTasks).toHaveBeenLastCalledWith(true);
    });
  });
});
