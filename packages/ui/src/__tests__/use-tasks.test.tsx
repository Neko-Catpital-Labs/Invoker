/**
 * useTasks — workflows-changed must clear workflow metadata when main sends [].
 * Overlapping getTasks responses: older empty snapshot must not wipe after refreshTasks.
 * Bootstrap presence must skip the immediate non-forced getTasks call.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useTasks } from '../hooks/useTasks.js';
import { makeUITask } from './helpers/mock-invoker.js';

describe('useTasks', () => {
  let workflowsChangedHandler: ((wfList: unknown[]) => void) | undefined;
  let taskDeltaHandler: ((delta: unknown) => void) | undefined;

  beforeEach(() => {
    vi.useRealTimers();
    workflowsChangedHandler = undefined;
    taskDeltaHandler = undefined;
    (window as unknown as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__ = {
      tasks: [],
      workflows: [],
    };
    (window as unknown as { invoker: Record<string, unknown> }).invoker = {
      getTasks: vi.fn().mockResolvedValue({ tasks: [], workflows: [] }),
      reportUiPerf: vi.fn(),
      checkPrStatuses: vi.fn(),
      onTaskDelta: vi.fn((cb: (delta: unknown) => void) => {
        taskDeltaHandler = cb;
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
      reportUiPerf: vi.fn(),
      checkPrStatuses: vi.fn(),
      onTaskDelta: vi.fn(() => () => {}),
      onWorkflowsChanged: vi.fn(() => () => {}),
    };

    const { result } = renderHook(() => useTasks());

    // Mount no longer triggers an automatic getTasks (bootstrap is provided),
    // so simulate the overlap with two explicit refresh calls.
    await act(async () => {
      result.current.refreshTasks();
    });
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

  it('skips the immediate non-forced getTasks when preload bootstrap is provided', async () => {
    const bootA = makeUITask({ id: 'boot-a', description: 'Bootstrap A' });
    const bootB = makeUITask({ id: 'boot-b', description: 'Bootstrap B' });
    (window as unknown as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__ = {
      tasks: [bootA, bootB],
      workflows: [{ id: 'wf-1', name: 'Workflow 1', status: 'running' }],
      appStartedAtEpochMs: Date.now() - 1000,
    };
    const getTasks = vi.fn().mockResolvedValue({ tasks: [], workflows: [] });
    const reportUiPerf = vi.fn();
    const checkPrStatuses = vi.fn();
    (window as unknown as { invoker: Record<string, unknown> }).invoker = {
      getTasks,
      reportUiPerf,
      checkPrStatuses,
      onTaskDelta: vi.fn(() => () => {}),
      onWorkflowsChanged: vi.fn(() => () => {}),
    };

    const { result } = renderHook(() => useTasks());

    // Allow the effect to flush and any pending microtasks/queueMicrotask to settle.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(getTasks).not.toHaveBeenCalled();
    expect(result.current.tasks.size).toBe(2);
    expect(result.current.workflows.get('wf-1')?.name).toBe('Workflow 1');
    expect(reportUiPerf).toHaveBeenCalledWith(
      'startup_snapshot_skipped_bootstrap_provided',
      expect.objectContaining({
        bootstrapTaskCount: 2,
        bootstrapWorkflowCount: 1,
      }),
    );
    // Skipping the snapshot must still kick off the PR-status check that
    // fetchAll() would have triggered.
    expect(checkPrStatuses).toHaveBeenCalled();
  });

  it('skips the immediate non-forced getTasks even when bootstrap is empty', async () => {
    (window as unknown as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__ = {
      tasks: [],
      workflows: [],
    };
    const getTasks = vi.fn().mockResolvedValue({ tasks: [], workflows: [] });
    (window as unknown as { invoker: Record<string, unknown> }).invoker = {
      getTasks,
      reportUiPerf: vi.fn(),
      checkPrStatuses: vi.fn(),
      onTaskDelta: vi.fn(() => () => {}),
      onWorkflowsChanged: vi.fn(() => () => {}),
    };

    renderHook(() => useTasks());

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(getTasks).not.toHaveBeenCalled();
  });

  it('falls back to the initial fetchAll when no bootstrap was delivered', async () => {
    delete (window as unknown as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__;
    const getTasks = vi.fn().mockResolvedValue({ tasks: [], workflows: [] });
    (window as unknown as { invoker: Record<string, unknown> }).invoker = {
      getTasks,
      reportUiPerf: vi.fn(),
      checkPrStatuses: vi.fn(),
      onTaskDelta: vi.fn(() => () => {}),
      onWorkflowsChanged: vi.fn(() => () => {}),
    };

    renderHook(() => useTasks());

    await waitFor(() => {
      expect(getTasks).toHaveBeenCalledTimes(1);
      expect(getTasks).toHaveBeenLastCalledWith(false);
    });
  });

  it('still rejects a smaller post-mount non-forced snapshot for bootstrap-seeded state', async () => {
    const bootA = makeUITask({ id: 'boot-a', description: 'Bootstrap A' });
    const bootB = makeUITask({ id: 'boot-b', description: 'Bootstrap B' });
    const smaller = makeUITask({ id: 'boot-a', description: 'Smaller A' });
    (window as unknown as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__ = {
      tasks: [bootA, bootB],
      workflows: [{ id: 'wf-1', name: 'Workflow 1', status: 'running' }],
    };
    const reportUiPerf = vi.fn();
    (window as unknown as { invoker: Record<string, unknown> }).invoker = {
      getTasks: vi.fn().mockResolvedValue({
        tasks: [smaller],
        workflows: [{ id: 'wf-1', name: 'Workflow 1', status: 'running' }],
      }),
      reportUiPerf,
      checkPrStatuses: vi.fn(),
      onTaskDelta: vi.fn(() => () => {}),
      onWorkflowsChanged: vi.fn(() => () => {}),
    };

    const { result } = renderHook(() => useTasks());

    // Mount no longer fetches automatically; a later non-forced refresh
    // (e.g. mutation-driven) returning a smaller snapshot must still be
    // rejected to protect the bootstrapped state.
    await act(async () => {
      result.current.refreshTasks();
    });

    await waitFor(() => {
      expect(window.invoker.getTasks).toHaveBeenCalledWith(false);
    });

    expect(result.current.tasks.size).toBe(2);
    expect(result.current.tasks.get('boot-a')?.description).toBe('Bootstrap A');
    expect(result.current.tasks.get('boot-b')?.description).toBe('Bootstrap B');
    expect(reportUiPerf).toHaveBeenCalledWith(
      'startup_snapshot_skipped_smaller_than_bootstrap',
      expect.objectContaining({
        bootstrapTaskCount: 2,
        snapshotTaskCount: 1,
      }),
    );
  });

  it('passes forceRefresh flag to getTasks when requested', async () => {
    const getTasks = vi.fn().mockResolvedValue({ tasks: [], workflows: [] });
    (window as unknown as { invoker: Record<string, unknown> }).invoker = {
      getTasks,
      reportUiPerf: vi.fn(),
      checkPrStatuses: vi.fn(),
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
