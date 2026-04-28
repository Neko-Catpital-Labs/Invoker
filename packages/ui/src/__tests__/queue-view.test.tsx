import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueueView } from '../components/QueueView.js';
import { makeUITask } from './helpers/mock-invoker.js';
import type { TaskState } from '../types.js';

describe('QueueView', () => {
  const onTaskClick = vi.fn();
  const onCancel = vi.fn();

  beforeEach(() => {
    onTaskClick.mockReset();
    onCancel.mockReset();
    vi.stubGlobal('confirm', vi.fn(() => true));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders action queue in running-then-queued order and separates backlog', async () => {
    const runningTask = makeUITask({
      id: 'wf-1/running-task',
      status: 'running',
      description: 'running task',
      execution: { phase: 'executing' },
    });
    const queuedTask = makeUITask({
      id: 'wf-1/queued-task',
      status: 'pending',
      description: 'queued task',
    });
    const blockedTask = makeUITask({
      id: 'wf-1/pending-task',
      status: 'blocked',
      description: 'pending task',
      dependencies: ['wf-1/running-task'],
    });
    const tasks = new Map<string, TaskState>([
      [runningTask.id, runningTask],
      [queuedTask.id, queuedTask],
      [blockedTask.id, blockedTask],
    ]);

    const getQueueStatus = vi.fn(async () => ({
      maxConcurrency: 6,
      runningCount: 1,
      running: [{ taskId: runningTask.id, description: runningTask.description }],
      queued: [{ taskId: queuedTask.id, priority: 0, description: queuedTask.description }],
    }));
    (window as unknown as { invoker: unknown }).invoker = { getQueueStatus };

    render(
      <QueueView
        tasks={tasks}
        onTaskClick={onTaskClick}
        onCancel={onCancel}
        selectedTaskId={null}
      />,
    );

    await waitFor(() => expect(getQueueStatus).toHaveBeenCalled());
    expect(screen.getByText('Action Queue (2)')).toBeInTheDocument();
    expect(screen.getByText('Backlog (1)')).toBeInTheDocument();
    expect(screen.getByText('#1')).toBeInTheDocument();
    expect(screen.getByText('#2')).toBeInTheDocument();
    // Canonical status labels instead of raw "running"/"queued"
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('phase: Executing')).toBeInTheDocument();
    expect(screen.getByText('priority: 0')).toBeInTheDocument();
    expect(screen.getByText('deps: running-task')).toBeInTheDocument();
  });

  it('supports click-through and cancel actions in queue rows', async () => {
    const runningTask = makeUITask({
      id: 'wf-1/run-all-fixture-tests',
      status: 'running',
      description: 'failing task',
      execution: { phase: 'executing' },
    });
    const queuedTask = makeUITask({
      id: 'wf-2/another-task',
      status: 'pending',
      description: 'another task',
    });
    const tasks = new Map<string, TaskState>([
      [runningTask.id, runningTask],
      [queuedTask.id, queuedTask],
    ]);

    const getQueueStatus = vi.fn(async () => ({
      maxConcurrency: 6,
      runningCount: 1,
      running: [{ taskId: runningTask.id, description: runningTask.description }],
      queued: [{ taskId: queuedTask.id, priority: 1, description: queuedTask.description }],
    }));
    (window as unknown as { invoker: unknown }).invoker = { getQueueStatus };

    render(
      <QueueView
        tasks={tasks}
        onTaskClick={onTaskClick}
        onCancel={onCancel}
        selectedTaskId={null}
      />,
    );

    await waitFor(() => expect(getQueueStatus).toHaveBeenCalled());

    fireEvent.click(screen.getByText('run-all-fixture-tests'));
    expect(onTaskClick).toHaveBeenCalledWith(expect.objectContaining({ id: runningTask.id }));

    fireEvent.click(screen.getAllByText('Cancel')[0]);
    expect(onCancel).toHaveBeenCalledWith(runningTask.id);
  });

  it('renders merge gate ids with a stable label', async () => {
    const mergeGateTask = makeUITask({
      id: '__merge__wf-123',
      status: 'blocked',
      description: 'Workflow gate for queued merge',
      dependencies: ['wf-1/build'],
    });
    const tasks = new Map<string, TaskState>([
      [mergeGateTask.id, mergeGateTask],
    ]);

    const getQueueStatus = vi.fn(async () => ({
      maxConcurrency: 6,
      runningCount: 0,
      running: [],
      queued: [],
    }));
    (window as unknown as { invoker: unknown }).invoker = { getQueueStatus };

    render(
      <QueueView
        tasks={tasks}
        onTaskClick={onTaskClick}
        onCancel={onCancel}
        selectedTaskId={null}
      />,
    );

    await waitFor(() => expect(getQueueStatus).toHaveBeenCalled());
    expect(screen.getByText('merge gate')).toBeInTheDocument();
    expect(screen.queryByText('__merge__wf-123')).not.toBeInTheDocument();
  });

  it('places manual-action tasks in Action Queue with canonical labels', async () => {
    const fixingTask = makeUITask({
      id: 'wf-1/fixing-task',
      status: 'fixing_with_ai',
      description: 'AI fix in progress',
    });
    const needsInputTask = makeUITask({
      id: 'wf-1/input-task',
      status: 'needs_input',
      description: 'waiting for input',
    });
    const reviewTask = makeUITask({
      id: 'wf-1/review-task',
      status: 'review_ready',
      description: 'ready for review',
    });
    const approvalTask = makeUITask({
      id: 'wf-1/approval-task',
      status: 'awaiting_approval',
      description: 'needs approval',
    });
    const blockedTask = makeUITask({
      id: 'wf-1/blocked-task',
      status: 'blocked',
      description: 'blocked by something',
      dependencies: ['wf-1/fixing-task'],
    });
    const tasks = new Map<string, TaskState>([
      [fixingTask.id, fixingTask],
      [needsInputTask.id, needsInputTask],
      [reviewTask.id, reviewTask],
      [approvalTask.id, approvalTask],
      [blockedTask.id, blockedTask],
    ]);

    const getQueueStatus = vi.fn(async () => ({
      maxConcurrency: 6,
      runningCount: 0,
      running: [],
      queued: [],
    }));
    (window as unknown as { invoker: unknown }).invoker = { getQueueStatus };

    render(
      <QueueView
        tasks={tasks}
        onTaskClick={onTaskClick}
        onCancel={onCancel}
        selectedTaskId={null}
      />,
    );

    await waitFor(() => expect(getQueueStatus).toHaveBeenCalled());

    // All manual-action tasks land in Action Queue
    expect(screen.getByText('Action Queue (4)')).toBeInTheDocument();
    expect(screen.getByText('Backlog (1)')).toBeInTheDocument();

    // Canonical status labels
    expect(screen.getByText('Fixing With AI')).toBeInTheDocument();
    expect(screen.getByText('Needs Input')).toBeInTheDocument();
    expect(screen.getByText('Review Ready')).toBeInTheDocument();
    expect(screen.getByText('Awaiting Approval')).toBeInTheDocument();

    // Blocked task stays in backlog
    expect(screen.getByText('blocked by something')).toBeInTheDocument();
  });

  it('shows pending tasks in Action Queue when scheduler-queued with canonical Pending label', async () => {
    const pendingTask = makeUITask({
      id: 'wf-1/pending-task',
      status: 'pending',
      description: 'waiting to run',
    });
    const tasks = new Map<string, TaskState>([
      [pendingTask.id, pendingTask],
    ]);

    const getQueueStatus = vi.fn(async () => ({
      maxConcurrency: 6,
      runningCount: 0,
      running: [],
      queued: [{ taskId: pendingTask.id, priority: 5, description: pendingTask.description }],
    }));
    (window as unknown as { invoker: unknown }).invoker = { getQueueStatus };

    render(
      <QueueView
        tasks={tasks}
        onTaskClick={onTaskClick}
        onCancel={onCancel}
        selectedTaskId={null}
      />,
    );

    await waitFor(() => expect(getQueueStatus).toHaveBeenCalled());
    expect(screen.getByText('Action Queue (1)')).toBeInTheDocument();
    expect(screen.getByText('Backlog (0)')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('priority: 5')).toBeInTheDocument();
  });
});
