/**
 * useTasks — workflows-changed must clear workflow metadata when main sends [].
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useTasks } from '../hooks/useTasks.js';
import { makeUITask } from './helpers/mock-invoker.js';

describe('useTasks', () => {
  let workflowsChangedHandler: ((wfList: unknown[]) => void) | undefined;
  let taskGraphEventHandler: ((event: unknown) => void) | undefined;

  beforeEach(() => {
    vi.useRealTimers();
    workflowsChangedHandler = undefined;
    taskGraphEventHandler = undefined;
    (window as unknown as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__ = {
      tasks: [],
      workflows: [],
    };
    (window as unknown as { invoker: Record<string, unknown> }).invoker = {
      getTasks: vi.fn().mockResolvedValue({ tasks: [], workflows: [] }),
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
      onTaskGraphEvent: vi.fn(() => () => {}),
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
      onTaskGraphEvent: vi.fn(() => () => {}),
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

  it('loads the startup snapshot on mount when bootstrap is empty', async () => {
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
      onTaskGraphEvent: vi.fn(() => () => {}),
      onWorkflowsChanged: vi.fn(() => () => {}),
    };

    const { result } = renderHook(() => useTasks());

    await waitFor(() => {
      expect(getTasks).toHaveBeenCalledTimes(1);
      expect(getTasks).toHaveBeenLastCalledWith();
    });

    await waitFor(() => {
      expect(result.current.tasks.get('fetched-1')?.description).toBe('Fetched');
      expect(result.current.workflows.get('wf-x')?.name).toBe('WF X');
    });
  });

  it('ignores a stale startup snapshot after a graph event arrives first', async () => {
    let releaseStartupSnapshot: (value: { tasks: ReturnType<typeof makeUITask>[]; workflows: unknown[]; streamSequence: number }) => void;
    let taskGraphEventHandler: ((event: unknown) => void) | undefined;
    const startupSnapshot = new Promise<{ tasks: ReturnType<typeof makeUITask>[]; workflows: unknown[]; streamSequence: number }>((resolve) => {
      releaseStartupSnapshot = resolve;
    });
    const liveTask = makeUITask({ id: 'live-1', description: 'Live task' });
    (window as unknown as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__ = {
      tasks: [],
      workflows: [],
    };
    (window as unknown as { invoker: Record<string, unknown> }).invoker = {
      getTasks: vi.fn().mockReturnValue(startupSnapshot),
      onTaskGraphEvent: vi.fn((cb: (event: unknown) => void) => {
        taskGraphEventHandler = cb;
        return () => {};
      }),
      onWorkflowsChanged: vi.fn(() => () => {}),
    };

    const { result } = renderHook(() => useTasks());

    await waitFor(() => {
      expect(taskGraphEventHandler).toBeDefined();
    });

    await act(async () => {
      taskGraphEventHandler!({
        type: 'snapshot',
        tasks: [liveTask],
        workflows: [],
        reason: 'test-live-snapshot',
        streamSequence: 7,
      });
      await new Promise((resolve) => setTimeout(resolve, 130));
    });

    await waitFor(() => {
      expect(result.current.tasks.get('live-1')?.description).toBe('Live task');
    });

    await act(async () => {
      releaseStartupSnapshot!({ tasks: [], workflows: [], streamSequence: 0 });
    });

    expect(result.current.tasks.get('live-1')?.description).toBe('Live task');
    expect(result.current.tasks.size).toBe(1);
  });

  it('forced refresh after a hydrated bootstrap requests a graph refresh and waits for the snapshot event', async () => {
    const bootTask = makeUITask({ id: 'boot-1', description: 'Boot' });
    const refreshedTask = makeUITask({ id: 'refreshed-1', description: 'Refreshed' });
    let taskGraphEventHandler: ((event: unknown) => void) | undefined;
    (window as unknown as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__ = {
      tasks: [bootTask],
      workflows: [{ id: 'wf-1', name: 'WF 1', status: 'running' }],
    };
    const refreshTaskGraph = vi.fn(async () => {
      taskGraphEventHandler?.({
        type: 'snapshot',
        tasks: [refreshedTask],
        workflows: [],
        reason: 'test-refresh',
        streamSequence: 0,
      });
    });
    (window as unknown as { invoker: Record<string, unknown> }).invoker = {
      getTasks: vi.fn().mockResolvedValue({ tasks: [bootTask], workflows: [] }),
      refreshTaskGraph,
      onTaskGraphEvent: vi.fn((cb: (event: unknown) => void) => {
        taskGraphEventHandler = cb;
        return () => {};
      }),
      onWorkflowsChanged: vi.fn(() => () => {}),
    };

    const { result } = renderHook(() => useTasks());

    expect(refreshTaskGraph).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.refreshTaskGraph();
    });

    expect(refreshTaskGraph).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(result.current.tasks.has('refreshed-1')).toBe(true);
      expect(result.current.tasks.has('boot-1')).toBe(false);
    });
  });


  it('forced refresh calls refreshTaskGraph instead of getTasks', async () => {
    const getTasks = vi.fn().mockResolvedValue({ tasks: [], workflows: [] });
    const refreshTaskGraph = vi.fn(async () => {});
    (window as unknown as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__ = {
      tasks: [makeUITask({ id: 'boot-1' })],
      workflows: [],
    };
    (window as unknown as { invoker: Record<string, unknown> }).invoker = {
      getTasks,
      refreshTaskGraph,
      onTaskGraphEvent: vi.fn(() => () => {}),
      onWorkflowsChanged: vi.fn(() => () => {}),
    };

    const { result } = renderHook(() => useTasks());

    await act(async () => {
      await result.current.refreshTaskGraph();
    });

    await waitFor(() => {
      expect(refreshTaskGraph).toHaveBeenCalledTimes(1);
      expect(getTasks).not.toHaveBeenCalled();
    });
  });

  it('refreshes workflow metadata via listWorkflows when a created delta introduces a new workflow', async () => {
    let taskGraphEventHandler: ((event: unknown) => void) | undefined;
    const getTasks = vi.fn().mockResolvedValue({ tasks: [], workflows: [] });
    const listWorkflows = vi.fn().mockResolvedValue([
      { id: 'wf-2', name: 'Workflow 2', status: 'running' },
    ]);
    (window as unknown as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__ = {
      tasks: [makeUITask({ id: 'boot-1', description: 'Boot task' })],
      workflows: [],
    };
    (window as unknown as { invoker: Record<string, unknown> }).invoker = {
      getTasks,
      listWorkflows,
      onTaskGraphEvent: vi.fn((cb: (event: unknown) => void) => {
        taskGraphEventHandler = cb;
        return () => {};
      }),
      onWorkflowsChanged: vi.fn(() => () => {}),
    };

    const { result } = renderHook(() => useTasks());

    await waitFor(() => {
      expect(taskGraphEventHandler).toBeDefined();
    });

    await act(async () => {
      taskGraphEventHandler!({
        type: 'delta',
        delta: {
          type: 'created',
          task: makeUITask({ id: 'wf-2/task-1', workflowId: 'wf-2', status: 'pending' }),
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 130));
    });

    await waitFor(() => {
      expect(listWorkflows).toHaveBeenCalledTimes(1);
      expect(getTasks).not.toHaveBeenCalled();
      expect(result.current.workflows.get('wf-2')?.name).toBe('Workflow 2');
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
      onTaskGraphEvent: vi.fn((cb: (event: unknown) => void) => {
        taskGraphEventHandler = cb;
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
      taskGraphEventHandler!({
        type: 'delta',
        delta: {
          type: 'updated',
          taskId: 'wf-1/task-a',
          changes: { status: 'pending' },
          taskStateVersion: 2,
          previousTaskStateVersion: 1,
        },
      });
      taskGraphEventHandler!({
        type: 'delta',
        delta: {
          type: 'updated',
          taskId: 'wf-1/task-b',
          changes: { status: 'pending' },
          taskStateVersion: 2,
          previousTaskStateVersion: 1,
        },
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
      onTaskGraphEvent: vi.fn((cb: (event: unknown) => void) => {
        taskGraphEventHandler = cb;
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
      taskGraphEventHandler!({
        type: 'delta',
        delta: {
          type: 'updated',
          taskId: 'wf-1/add-regression-coverage',
          changes: { status: 'failed' },
          taskStateVersion: 2,
          previousTaskStateVersion: 1,
        },
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
