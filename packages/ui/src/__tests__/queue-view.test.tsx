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

  it('renders queue sub-tabs and switches between running, queued, and pending', async () => {
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
    const getEvents = vi.fn(async () => []);
    (window as unknown as { invoker: unknown }).invoker = { getQueueStatus, getEvents };

    render(
      <QueueView
        tasks={tasks}
        onTaskClick={onTaskClick}
        onCancel={onCancel}
        selectedTaskId={null}
      />,
    );

    await waitFor(() => expect(getQueueStatus).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Running (1)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Queued (1)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pending (2)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Action History (0)' })).toBeInTheDocument();
    expect(screen.getByText('phase: Executing')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Queued (1)'));
    expect(screen.getByText('pri: 0')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Pending (2)'));
    expect(screen.getByText('deps: running-task')).toBeInTheDocument();
  });

  it('shows only supported auto-fix enqueue phases in Action History and supports click-through', async () => {
    const failedTask = makeUITask({
      id: 'wf-1/run-all-fixture-tests',
      status: 'failed',
      description: 'failing task',
    });
    const otherTask = makeUITask({
      id: 'wf-2/another-task',
      status: 'failed',
      description: 'another task',
    });
    const tasks = new Map<string, TaskState>([
      [failedTask.id, failedTask],
      [otherTask.id, otherTask],
    ]);

    const getQueueStatus = vi.fn(async () => ({
      maxConcurrency: 6,
      runningCount: 0,
      running: [],
      queued: [],
    }));
    const getEvents = vi.fn(async (taskId: string) => {
      if (taskId === failedTask.id) {
        return [
          {
            id: 10,
            taskId,
            eventType: 'debug.auto-fix',
            payload: JSON.stringify({ phase: 'schedule-enqueue', status: 'failed', autoFixAttempts: 0 }),
            createdAt: '2026-04-16 08:33:08',
          },
          {
            id: 11,
            taskId,
            eventType: 'debug.auto-fix',
            payload: JSON.stringify({ phase: 'resolve-conflict-start', agent: 'claude' }),
            createdAt: '2026-04-16 08:33:09',
          },
        ];
      }
      return [];
    });
    (window as unknown as { invoker: unknown }).invoker = { getQueueStatus, getEvents };

    render(
      <QueueView
        tasks={tasks}
        onTaskClick={onTaskClick}
        onCancel={onCancel}
        selectedTaskId={null}
      />,
    );

    await waitFor(() => expect(getEvents).toHaveBeenCalled());
    fireEvent.click(screen.getByText('Action History (1)'));
    expect(screen.getByText('run-all-fixture-tests')).toBeInTheDocument();
    expect(screen.getByText('schedule-enqueue')).toBeInTheDocument();
    expect(screen.getByText('status=failed attempts=0')).toBeInTheDocument();

    fireEvent.click(screen.getByText('run-all-fixture-tests'));
    expect(onTaskClick).toHaveBeenCalledWith(expect.objectContaining({ id: failedTask.id }));
  });
});
