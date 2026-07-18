/**
 * Component test: History view rendering, filters, timeline expand, and live deltas.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { vi } from 'vitest';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { TaskEvent, TaskHistoryEntry, WorkflowMeta } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

const workflows: WorkflowMeta[] = [{ id: 'wf-history', name: 'History WF', status: 'running' }];

function makeHistoryEntry(overrides: Partial<TaskHistoryEntry> = {}): TaskHistoryEntry {
  return {
    ...makeUITask({
      id: 'task-alpha',
      description: 'First history task',
      status: 'completed',
      workflowId: 'wf-history',
    }),
    workflowName: 'History WF',
    lastEventAt: '2026-07-01T12:00:00.000Z',
    eventCount: 2,
    ...overrides,
  };
}

async function chooseGraphMenuItem(testId: string): Promise<void> {
  fireEvent.click(screen.getByTestId('graph-more-button'));
  await waitFor(() => {
    expect(screen.getByTestId('graph-more-menu')).toBeInTheDocument();
  });
  fireEvent.click(screen.getByTestId(testId));
}

describe('History view (component)', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('loads history rows from getHistoryTasks', async () => {
    const completed = makeHistoryEntry();
    const failed = makeHistoryEntry({
      id: 'task-beta',
      description: 'Failed history task',
      status: 'failed',
      lastEventAt: '2026-07-01T11:00:00.000Z',
      execution: { exitCode: 1, error: 'boom' },
    });
    mock.setHistoryTasks([completed, failed]);
    act(() => mock.setTasks([completed, failed], workflows));

    render(<App />);
    await chooseGraphMenuItem('rail-history');

    await waitFor(() => {
      expect(screen.getByTestId('history-view')).toBeInTheDocument();
      expect(screen.getByTestId('history-row-task-alpha')).toBeInTheDocument();
      expect(screen.getByTestId('history-row-task-beta')).toBeInTheDocument();
    });
    expect(screen.getByRole('searchbox', { name: 'Search history' })).toBeInTheDocument();
    expect(screen.getByTestId('history-row-task-alpha')).toHaveTextContent('Completed');
    expect(screen.getByTestId('history-row-task-beta')).toHaveTextContent('Failed');
    expect(screen.getByText('2 / 2')).toBeInTheDocument();
  });

  it('expands a row and renders newest-first timeline events', async () => {
    const failed = makeHistoryEntry({
      id: 'task-beta',
      description: 'Failed history task',
      status: 'failed',
    });
    const events: TaskEvent[] = [
      {
        id: 1,
        taskId: 'task-beta',
        eventType: 'task.running',
        createdAt: '2026-07-01T10:00:00.000Z',
      },
      {
        id: 2,
        taskId: 'task-beta',
        eventType: 'task.failed',
        createdAt: '2026-07-01T10:01:00.000Z',
        payload: JSON.stringify({ exitCode: 1, error: 'Command exited non-zero' }),
      },
    ];
    mock.setHistoryTasks([failed]);
    mock.setEvents('task-beta', events);
    act(() => mock.setTasks([failed], workflows));

    render(<App />);
    await chooseGraphMenuItem('rail-history');

    await waitFor(() => {
      expect(screen.getByTestId('history-row-task-beta')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('history-expand-task-beta'));

    await waitFor(() => {
      expect(screen.getByTestId('history-timeline-task-beta')).toBeInTheDocument();
    });

    const timeline = screen.getByTestId('history-timeline-task-beta');
    expect(timeline).toHaveTextContent('Failed');
    expect(timeline).toHaveTextContent('Running');
    expect(timeline).toHaveTextContent('exit 1');
    expect(timeline).toHaveTextContent('Command exited non-zero');
    expect(mock.api.getEvents).toHaveBeenCalledWith('task-beta', { limit: 50, sortBy: 'desc' });

    const labels = Array.from(timeline.querySelectorAll('li span.font-medium')).map((el) => el.textContent);
    expect(labels[0]).toBe('Failed');
    expect(labels[1]).toBe('Running');
  });

  it('applies live deltas from onTaskGraphEvent', async () => {
    const older = makeHistoryEntry({
      id: 'task-older',
      description: 'Older task',
      lastEventAt: '2026-07-01T10:00:00.000Z',
    });
    const newer = makeHistoryEntry({
      id: 'task-newer',
      description: 'Newer task',
      lastEventAt: '2026-07-01T12:00:00.000Z',
    });
    mock.setHistoryTasks([newer, older]);
    act(() => mock.setTasks([newer, older], workflows));

    render(<App />);
    await chooseGraphMenuItem('rail-history');

    await waitFor(() => {
      expect(screen.getByTestId('history-task-list')).toBeInTheDocument();
    });

    const before = Array.from(screen.getByTestId('history-task-list').querySelectorAll('[data-testid^="history-row-"]'))
      .map((el) => el.getAttribute('data-testid'));
    expect(before[0]).toBe('history-row-task-newer');

    act(() => {
      mock.fireDelta({
        type: 'updated',
        taskId: 'task-older',
        changes: { status: 'running' },
        taskStateVersion: 2,
        previousTaskStateVersion: 1,
      });
    });

    await waitFor(() => {
      const after = Array.from(screen.getByTestId('history-task-list').querySelectorAll('[data-testid^="history-row-"]'))
        .map((el) => el.getAttribute('data-testid'));
      expect(after[0]).toBe('history-row-task-older');
      expect(screen.getByTestId('history-row-task-older')).toHaveTextContent('Running');
    });
  });

  it('filters by status chip and shows closed status option', async () => {
    const completed = makeHistoryEntry({ id: 'task-done', description: 'Done task', status: 'completed' });
    const closed = makeHistoryEntry({
      id: 'task-closed',
      description: 'Closed task',
      status: 'closed',
      lastEventAt: '2026-07-01T09:00:00.000Z',
    });
    mock.setHistoryTasks([completed, closed]);
    act(() => mock.setTasks([completed, closed], workflows));

    render(<App />);
    await chooseGraphMenuItem('rail-history');

    await waitFor(() => {
      expect(screen.getByTestId('history-row-task-done')).toBeInTheDocument();
      expect(screen.getByTestId('history-row-task-closed')).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: 'Closed' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Closed' }));

    await waitFor(() => {
      expect(screen.queryByTestId('history-row-task-done')).not.toBeInTheDocument();
      expect(screen.getByTestId('history-row-task-closed')).toBeInTheDocument();
      expect(screen.getByText('1 / 2')).toBeInTheDocument();
    });
  });

  it('shows empty state when there is no history', async () => {
    mock.setHistoryTasks([]);
    act(() => mock.setTasks([], workflows));

    render(<App />);
    await chooseGraphMenuItem('rail-history');

    await waitFor(() => {
      expect(screen.getByTestId('history-view')).toBeInTheDocument();
      expect(screen.getByText('No task history yet')).toBeInTheDocument();
    });
  });
});
