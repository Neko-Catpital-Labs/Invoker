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
  let taskDeltaHandler: ((delta: unknown) => void) | undefined;
  let taskGraphEventHandler: ((event: unknown) => void) | undefined;

  beforeEach(() => {
    vi.useRealTimers();
    workflowsChangedHandler = undefined;
    taskDeltaHandler = undefined;
    taskGraphEventHandler = undefined;
    (window as unknown as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__ = {
      tasks: [],
      workflows: [],
    };
    (window as unknown as { invoker: Record<string, unknown> }).invoker = {
      getTasks: vi.fn().mockResolvedValue({ tasks: [], workflows: [] }),
      onTaskDelta: vi.fn((cb: (delta: unknown) => void) => {
        taskDeltaHandler = cb;
        return () => {};
      }),
      onTaskGraphEvent: vi.fn((cb: (event: unknown) => void) => {
        taskGraphEventHandler = cb;
        return () => {};
      }),
      onWorkflowsChanged: vi.fn((cb: (wfList: unknown[]) => void) => {
        workflowsChangedHandler = cb;
        return () => {};
      }),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('applies task graph delta events from the graph event channel', async () => {
    const task = makeUITask({ id: 'wf-1/task-1', workflowId: 'wf-1', status: 'pending' });
    (window as unknown as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__ = {
      tasks: [task],
      workflows: [{ id: 'wf-1', name: 'Workflow 1', status: 'pending' }],
    };

    const { result } = renderHook(() => useTasks());

    await waitFor(() => {
      expect(taskGraphEventHandler).toBeDefined();
    });

    await act(async () => {
      taskGraphEventHandler!({
        type: 'delta',
        delta: {
          type: 'updated',
          taskId: 'wf-1/task-1',
          changes: { status: 'running' },
          taskStateVersion: 2,
          previousTaskStateVersion: 1,
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 110));
    });

    expect(result.current.tasks.get('wf-1/task-1')?.status).toBe('running');
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

  it('skips the immediate non-forced snapshot when bootstrap already hydrated state', async () => {
    const bootA = makeUITask({ id: 'boot-a', description: 'Bootstrap A' });
    const bootB = makeUITask({ id: 'boot-b', description: 'Bootstrap B' });
    const getTasks = vi.fn().mockResolvedValue({ tasks: [bootA, bootB], workflows: [] });
    const reportUiPerf = vi.fn();
    (window as unknown as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__ = {
      tasks: [bootA, bootB],
      workflows: [{ id: 'wf-1', name: 'Workflow 1', status: 'running' }],
    };
    (window as unknown as { invoker: Record<string, unknown> }).invoker = {
      getTasks,
      reportUiPerf,
      onTaskDelta: vi.fn(() => () => {}),
      onWorkflowsChanged: vi.fn(() => () => {}),
    };

    const { result } = renderHook(() => useTasks());

    await waitFor(() => {
      expect(reportUiPerf).toHaveBeenCalledWith(
        'startup_snapshot_skipped_bootstrap_complete',
        expect.objectContaining({
          bootstrapTaskCount: 2,
          bootstrapWorkflowCount: 1,
        }),
      );
    });

    expect(getTasks).not.toHaveBeenCalled();
    expect(reportUiPerf).not.toHaveBeenCalledWith(
      'useTasks_snapshot_replace',
      expect.anything(),
    );
    expect(result.current.tasks.size).toBe(2);
    expect(result.current.workflows.size).toBe(1);
  });

  it('falls back to fetchAll on mount when bootstrap is empty', async () => {
    const fetched = makeUITask({ id: 'fetched-1', description: 'Fetched' });
    const getTasks = vi.fn().mockResolvedValue({
      tasks: [fetched],
      workflows: [{ id: 'wf-x', name: 'WF X', status: 'running' }],
    });
    (window as unknown as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__ = {
      tasks: [],
      workflows: [],
    };
    (window as unknown as { invoker: Record<string, unknown> }).invoker = {
      getTasks,
      onTaskDelta: vi.fn(() => () => {}),
      onWorkflowsChanged: vi.fn(() => () => {}),
    };

    const { result } = renderHook(() => useTasks());

    await waitFor(() => {
      expect(getTasks).toHaveBeenCalledTimes(1);
      expect(getTasks).toHaveBeenLastCalledWith(false);
    });

    await waitFor(() => {
      expect(result.current.tasks.get('fetched-1')?.description).toBe('Fetched');
      expect(result.current.workflows.get('wf-x')?.name).toBe('WF X');
    });
  });

  it('forced refresh after a hydrated bootstrap still calls getTasks(true) and replaces state', async () => {
    const bootTask = makeUITask({ id: 'boot-1', description: 'Boot' });
    const refreshedTask = makeUITask({ id: 'refreshed-1', description: 'Refreshed' });
    const getTasks = vi.fn().mockResolvedValue({ tasks: [refreshedTask], workflows: [] });
    (window as unknown as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__ = {
      tasks: [bootTask],
      workflows: [{ id: 'wf-1', name: 'WF 1', status: 'running' }],
    };
    (window as unknown as { invoker: Record<string, unknown> }).invoker = {
      getTasks,
      onTaskDelta: vi.fn(() => () => {}),
      onWorkflowsChanged: vi.fn(() => () => {}),
    };

    const { result } = renderHook(() => useTasks());

    expect(getTasks).not.toHaveBeenCalled();

    await act(async () => {
      result.current.refreshTasks(true);
    });

    await waitFor(() => {
      expect(getTasks).toHaveBeenCalledTimes(1);
      expect(getTasks).toHaveBeenLastCalledWith(true);
    });

    await waitFor(() => {
      expect(result.current.tasks.has('refreshed-1')).toBe(true);
      expect(result.current.tasks.has('boot-1')).toBe(false);
    });
  });

  it('non-forced refresh after a hydrated bootstrap still calls getTasks and replaces state', async () => {
    const bootTask = makeUITask({ id: 'boot-1', description: 'Boot' });
    const updated = makeUITask({ id: 'boot-1', description: 'Updated' });
    const getTasks = vi.fn().mockResolvedValue({ tasks: [updated], workflows: [] });
    (window as unknown as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__ = {
      tasks: [bootTask],
      workflows: [{ id: 'wf-1', name: 'WF 1', status: 'running' }],
    };
    (window as unknown as { invoker: Record<string, unknown> }).invoker = {
      getTasks,
      onTaskDelta: vi.fn(() => () => {}),
      onWorkflowsChanged: vi.fn(() => () => {}),
    };

    const { result } = renderHook(() => useTasks());

    expect(getTasks).not.toHaveBeenCalled();

    await act(async () => {
      result.current.refreshTasks();
    });

    await waitFor(() => {
      expect(getTasks).toHaveBeenCalledTimes(1);
      expect(getTasks).toHaveBeenLastCalledWith(false);
    });

    await waitFor(() => {
      expect(result.current.tasks.get('boot-1')?.description).toBe('Updated');
      expect(result.current.workflows.size).toBe(0);
    });
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

  it('keeps backend-sent workflow status until workflows-changed refreshes metadata', async () => {
    const taskA = makeUITask({ id: 'wf-1/task-a', workflowId: 'wf-1', status: 'failed' });
    const taskB = makeUITask({ id: 'wf-1/task-b', workflowId: 'wf-1', status: 'completed' });
    (window as unknown as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__ = {
      tasks: [taskA, taskB],
      workflows: [{ id: 'wf-1', name: 'Workflow 1', status: 'failed' }],
    };
    (window as unknown as { invoker: Record<string, unknown> }).invoker = {
      getTasks: vi.fn().mockResolvedValue({
        tasks: [taskA, taskB],
        workflows: [{ id: 'wf-1', name: 'Workflow 1', status: 'failed' }],
      }),
      onTaskDelta: vi.fn((cb: (delta: unknown) => void) => {
        taskDeltaHandler = cb;
        return () => {};
      }),
      onWorkflowsChanged: vi.fn((cb: (wfList: unknown[]) => void) => {
        workflowsChangedHandler = cb;
        return () => {};
      }),
    };

    const { result } = renderHook(() => useTasks());
    expect(result.current.workflows.get('wf-1')?.status).toBe('failed');

    await act(async () => {
      taskDeltaHandler!({
        type: 'updated',
        taskId: 'wf-1/task-a',
        changes: { status: 'pending' },
        taskStateVersion: 2,
        previousTaskStateVersion: 1,
      });
      taskDeltaHandler!({
        type: 'updated',
        taskId: 'wf-1/task-b',
        changes: { status: 'pending' },
        taskStateVersion: 2,
        previousTaskStateVersion: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 110));
    });

    await waitFor(() => {
      expect(result.current.tasks.get('wf-1/task-a')?.status).toBe('pending');
      expect(result.current.tasks.get('wf-1/task-b')?.status).toBe('pending');
    });
    expect(result.current.workflows.get('wf-1')?.status).toBe('failed');

    act(() => {
      workflowsChangedHandler!([
        {
          id: 'wf-1',
          name: 'Workflow 1',
          status: 'pending',
          rollup: {
            status: 'pending',
            countsByStatus: {
              pending: 2,
              running: 0,
              fixing_with_ai: 0,
              completed: 0,
              failed: 0,
              closed: 0,
              needs_input: 0,
              blocked: 0,
              review_ready: 0,
              awaiting_approval: 0,
              stale: 0,
            },
            failedTasks: [],
            fixingTasks: [],
            waitingTasks: [],
          },
        },
      ]);
    });

    expect(result.current.workflows.get('wf-1')?.status).toBe('pending');
    expect(result.current.workflows.get('wf-1')?.rollup?.countsByStatus.pending).toBe(2);
    expect(result.current.workflows.get('wf-1')?.name).toBe('Workflow 1');
  });

  it('does not locally recompute failed dependency paths from task deltas', async () => {
    const failedTask = makeUITask({
      id: 'wf-1/add-regression-coverage',
      workflowId: 'wf-1',
      status: 'running',
    });
    const downstreamTask = makeUITask({
      id: 'wf-1/run-focused-tests',
      workflowId: 'wf-1',
      status: 'pending',
      dependencies: ['wf-1/add-regression-coverage'],
    });
    const mergeTask = makeUITask({
      id: '__merge__wf-1',
      workflowId: 'wf-1',
      status: 'pending',
      isMergeNode: true,
      dependencies: ['wf-1/run-focused-tests'],
    });
    (window as unknown as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__ = {
      tasks: [failedTask, downstreamTask, mergeTask],
      workflows: [{ id: 'wf-1', name: 'Workflow 1', status: 'running' }],
    };
    (window as unknown as { invoker: Record<string, unknown> }).invoker = {
      getTasks: vi.fn().mockResolvedValue({
        tasks: [failedTask, downstreamTask, mergeTask],
        workflows: [{ id: 'wf-1', name: 'Workflow 1', status: 'running' }],
      }),
      onTaskDelta: vi.fn((cb: (delta: unknown) => void) => {
        taskDeltaHandler = cb;
        return () => {};
      }),
      onWorkflowsChanged: vi.fn((cb: (wfList: unknown[]) => void) => {
        workflowsChangedHandler = cb;
        return () => {};
      }),
    };

    const { result } = renderHook(() => useTasks());
    expect(result.current.workflows.get('wf-1')?.status).toBe('running');

    await act(async () => {
      taskDeltaHandler!({
        type: 'updated',
        taskId: 'wf-1/add-regression-coverage',
        changes: { status: 'failed' },
        taskStateVersion: 2,
        previousTaskStateVersion: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 110));
    });

    await waitFor(() => {
      expect(result.current.tasks.get('wf-1/add-regression-coverage')?.status).toBe('failed');
    });
    expect(result.current.workflows.get('wf-1')?.status).toBe('running');

    act(() => {
      workflowsChangedHandler!([{ id: 'wf-1', name: 'Workflow 1', status: 'failed' }]);
    });

    expect(result.current.workflows.get('wf-1')?.status).toBe('failed');
  });
});
