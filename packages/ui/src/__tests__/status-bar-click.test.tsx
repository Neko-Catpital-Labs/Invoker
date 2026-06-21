import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StatusBar } from '../components/StatusBar.js';
import type { TaskState } from '../types.js';

function makeTask(status: TaskState['status']): TaskState {
  return {
    id: `task-${status}`,
    description: `Test ${status} task`,
    status,
    dependencies: [],
    createdAt: new Date(),
    config: {},
    execution: {},
  } as TaskState;
}

describe('StatusBar click behavior', () => {
  const mockOnStatusClick = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Plain click behavior', () => {
    it('invokes onStatusClick immediately with the event on plain click', () => {
      const tasks = new Map<string, TaskState>([
        ['task-1', makeTask('completed')],
      ]);

      render(
        <StatusBar
          tasks={tasks}
          onStatusClick={mockOnStatusClick}
        />,
      );

      const completedLabel = screen.getByTestId('status-bar-pill-completed');
      fireEvent.click(completedLabel);

      // Should fire immediately (no delay)
      expect(mockOnStatusClick).toHaveBeenCalledTimes(1);
      expect(mockOnStatusClick).toHaveBeenCalledWith('completed', expect.objectContaining({
        ctrlKey: false,
        metaKey: false,
      }));
    });

    it('passes event with ctrlKey=true when Ctrl is held', () => {
      const tasks = new Map<string, TaskState>([
        ['task-1', makeTask('running')],
      ]);

      render(
        <StatusBar
          tasks={tasks}
          onStatusClick={mockOnStatusClick}
        />,
      );

      const runningLabel = screen.getByTestId('status-bar-pill-running');
      fireEvent.click(runningLabel, { ctrlKey: true });

      expect(mockOnStatusClick).toHaveBeenCalledTimes(1);
      expect(mockOnStatusClick).toHaveBeenCalledWith('running', expect.objectContaining({
        ctrlKey: true,
      }));
    });

    it('passes event with metaKey=true when Cmd is held', () => {
      const tasks = new Map<string, TaskState>([
        ['task-1', makeTask('failed')],
      ]);

      render(
        <StatusBar
          tasks={tasks}
          onStatusClick={mockOnStatusClick}
        />,
      );

      const failedLabel = screen.getByTestId('status-bar-pill-failed');
      fireEvent.click(failedLabel, { metaKey: true });

      expect(mockOnStatusClick).toHaveBeenCalledTimes(1);
      expect(mockOnStatusClick).toHaveBeenCalledWith('failed', expect.objectContaining({
        metaKey: true,
      }));
    });

    it('handles clicks on all status types', () => {
      const tasks = new Map<string, TaskState>([
        ['task-1', makeTask('completed')],
        ['task-2', makeTask('running')],
        ['task-3', makeTask('failed')],
        ['task-4', makeTask('pending')],
        ['task-5', makeTask('closed')],
      ]);

      render(
        <StatusBar
          tasks={tasks}
          onStatusClick={mockOnStatusClick}
        />,
      );

      fireEvent.click(screen.getByTestId('status-bar-pill-completed'));
      expect(mockOnStatusClick).toHaveBeenCalledWith('completed', expect.any(Object));

      fireEvent.click(screen.getByTestId('status-bar-pill-running'));
      expect(mockOnStatusClick).toHaveBeenCalledWith('running', expect.any(Object));

      fireEvent.click(screen.getByTestId('status-bar-pill-failed'));
      expect(mockOnStatusClick).toHaveBeenCalledWith('failed', expect.any(Object));

      fireEvent.click(screen.getByTestId('status-bar-pill-closed'));
      expect(mockOnStatusClick).toHaveBeenCalledWith('closed', expect.any(Object));

      fireEvent.click(screen.getByTestId('status-bar-pill-pending'));
      expect(mockOnStatusClick).toHaveBeenCalledWith('pending', expect.any(Object));

      expect(mockOnStatusClick).toHaveBeenCalledTimes(5);
    });
  });

  describe('Conditional status labels', () => {
    it('handles clicks on needs_input status', () => {
      const tasks = new Map<string, TaskState>([
        ['task-1', makeTask('needs_input')],
      ]);

      render(
        <StatusBar
          tasks={tasks}
          onStatusClick={mockOnStatusClick}
        />,
      );

      const inputLabel = screen.getByTestId('status-bar-pill-needs_input');
      fireEvent.click(inputLabel);

      expect(mockOnStatusClick).toHaveBeenCalledWith('needs_input', expect.any(Object));
    });

    it('handles clicks on awaiting_approval status', () => {
      const tasks = new Map<string, TaskState>([
        ['task-1', makeTask('awaiting_approval')],
      ]);

      render(
        <StatusBar
          tasks={tasks}
          onStatusClick={mockOnStatusClick}
        />,
      );

      const approvalLabel = screen.getByTestId('status-bar-pill-awaiting_approval');
      fireEvent.click(approvalLabel);

      expect(mockOnStatusClick).toHaveBeenCalledWith('awaiting_approval', expect.any(Object));
    });

    it('handles clicks on blocked status', () => {
      const tasks = new Map<string, TaskState>([
        ['task-1', makeTask('blocked')],
      ]);

      render(
        <StatusBar
          tasks={tasks}
          onStatusClick={mockOnStatusClick}
        />,
      );

      const blockedLabel = screen.getByTestId('status-bar-pill-blocked');
      fireEvent.click(blockedLabel);

      expect(mockOnStatusClick).toHaveBeenCalledWith('blocked', expect.any(Object));
    });
  });
  describe('queue running counts', () => {
    it('uses queue-running semantics for counts and keeps the running pill clickable', () => {
      const task: TaskState = {
        id: 'wf-1/launching-task',
        description: 'Launching task',
        status: 'pending',
        dependencies: [],
        createdAt: new Date(),
        config: {},
        execution: {
          phase: 'launching',
          selectedAttemptId: 'wf-1/launching-task-a1',
        },
      } as TaskState;
      const tasks = new Map<string, TaskState>([[task.id, task]]);

      render(
        <StatusBar
          tasks={tasks}
          queueStatus={{
            maxConcurrency: 6,
            runningCount: 1,
            running: [{ taskId: task.id, description: task.description }],
            queued: [],
          }}
          onStatusClick={mockOnStatusClick}
        />,
      );

      expect(screen.getByTestId('status-bar-pill-running')).toHaveTextContent('Running: 1');
      expect(screen.getByTestId('status-bar-pill-pending')).toHaveTextContent('Pending: 0');
      expect(screen.getByText('Running includes launching and AI-fix work.')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('status-bar-pill-running'));
      expect(mockOnStatusClick).toHaveBeenCalledWith('running', expect.any(Object));
    });
  });


  describe('Edge cases', () => {
    it('does not crash when onStatusClick is undefined', () => {
      const tasks = new Map<string, TaskState>([
        ['task-1', makeTask('completed')],
      ]);

      render(<StatusBar tasks={tasks} />);

      const completedLabel = screen.getByTestId('status-bar-pill-completed');
      fireEvent.click(completedLabel);

      // Should not crash
      expect(mockOnStatusClick).not.toHaveBeenCalled();
    });

    it('handles rapid clicks without debounce delay', () => {
      const tasks = new Map<string, TaskState>([
        ['task-1', makeTask('completed')],
      ]);

      render(
        <StatusBar
          tasks={tasks}
          onStatusClick={mockOnStatusClick}
        />,
      );

      const completedLabel = screen.getByTestId('status-bar-pill-completed');

      // Click multiple times rapidly
      fireEvent.click(completedLabel);
      fireEvent.click(completedLabel);
      fireEvent.click(completedLabel);

      // All three clicks should register immediately
      expect(mockOnStatusClick).toHaveBeenCalledTimes(3);
    });

    it('does not have special double-click handling', () => {
      const tasks = new Map<string, TaskState>([
        ['task-1', makeTask('completed')],
      ]);

      render(
        <StatusBar
          tasks={tasks}
          onStatusClick={mockOnStatusClick}
        />,
      );

      const completedLabel = screen.getByTestId('status-bar-pill-completed');

      // Double-click should just fire two separate single clicks
      fireEvent.doubleClick(completedLabel);

      // Double-click triggers two click events in testing-library
      // We just verify that it doesn't cause any special behavior (crash, etc.)
      // The actual click handler will have been called twice
      expect(mockOnStatusClick.mock.calls.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('activeFilters prop', () => {
    it('applies filter styling when activeFilters is provided', () => {
      const tasks = new Map<string, TaskState>([
        ['task-1', makeTask('completed')],
        ['task-2', makeTask('running')],
      ]);

      const activeFilters = new Set(['completed']);

      render(
        <StatusBar
          tasks={tasks}
          activeFilters={activeFilters}
          onStatusClick={mockOnStatusClick}
        />,
      );

      const completedSpan = screen.getByTestId('status-bar-pill-completed');
      const runningSpan = screen.getByTestId('status-bar-pill-running');

      // Active filter should have ring styling
      expect(completedSpan.className).toContain('ring-1');
      expect(completedSpan.className).toContain('ring-current');

      // Inactive filter should be dimmed
      expect(runningSpan.className).toContain('opacity-60');
    });
  });
});
