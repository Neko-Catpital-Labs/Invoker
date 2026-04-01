import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

describe('StatusBar click debounce behavior', () => {
  const mockOnStatusClick = vi.fn();
  const mockOnStatusDoubleClick = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Single-click behavior', () => {
    it('invokes onStatusClick after 200ms delay on single click', () => {
      const tasks = new Map<string, TaskState>([
        ['task-1', makeTask('completed')],
      ]);

      render(
        <StatusBar
          tasks={tasks}
          onStatusClick={mockOnStatusClick}
          onStatusDoubleClick={mockOnStatusDoubleClick}
        />,
      );

      const completedLabel = screen.getByText(/Completed:/);
      fireEvent.click(completedLabel);

      // Should not fire immediately
      expect(mockOnStatusClick).not.toHaveBeenCalled();

      // Advance timers by 199ms (just before threshold)
      vi.advanceTimersByTime(199);
      expect(mockOnStatusClick).not.toHaveBeenCalled();

      // Advance timers by 1ms more (exactly at 200ms)
      vi.advanceTimersByTime(1);
      expect(mockOnStatusClick).toHaveBeenCalledTimes(1);
      expect(mockOnStatusClick).toHaveBeenCalledWith('completed');
      expect(mockOnStatusDoubleClick).not.toHaveBeenCalled();
    });

    it('invokes onStatusClick for running status after delay', () => {
      const tasks = new Map<string, TaskState>([
        ['task-1', makeTask('running')],
      ]);

      render(
        <StatusBar
          tasks={tasks}
          onStatusClick={mockOnStatusClick}
          onStatusDoubleClick={mockOnStatusDoubleClick}
        />,
      );

      const runningLabel = screen.getByText(/Running:/);
      fireEvent.click(runningLabel);

      vi.advanceTimersByTime(200);
      expect(mockOnStatusClick).toHaveBeenCalledWith('running');
    });

    it('invokes onStatusClick for failed status after delay', () => {
      const tasks = new Map<string, TaskState>([
        ['task-1', makeTask('failed')],
      ]);

      render(
        <StatusBar
          tasks={tasks}
          onStatusClick={mockOnStatusClick}
          onStatusDoubleClick={mockOnStatusDoubleClick}
        />,
      );

      const failedLabel = screen.getByText(/Failed:/);
      fireEvent.click(failedLabel);

      vi.advanceTimersByTime(200);
      expect(mockOnStatusClick).toHaveBeenCalledWith('failed');
    });

    it('invokes onStatusClick for pending status after delay', () => {
      const tasks = new Map<string, TaskState>([
        ['task-1', makeTask('pending')],
      ]);

      render(
        <StatusBar
          tasks={tasks}
          onStatusClick={mockOnStatusClick}
          onStatusDoubleClick={mockOnStatusDoubleClick}
        />,
      );

      const pendingLabel = screen.getByText(/Pending:/);
      fireEvent.click(pendingLabel);

      vi.advanceTimersByTime(200);
      expect(mockOnStatusClick).toHaveBeenCalledWith('pending');
    });
  });

  describe('Double-click behavior', () => {
    it('clears pending single-click timer and invokes only onStatusDoubleClick', () => {
      const tasks = new Map<string, TaskState>([
        ['task-1', makeTask('completed')],
      ]);

      render(
        <StatusBar
          tasks={tasks}
          onStatusClick={mockOnStatusClick}
          onStatusDoubleClick={mockOnStatusDoubleClick}
        />,
      );

      const completedLabel = screen.getByText(/Completed:/);

      // First click starts the timer
      fireEvent.click(completedLabel);
      expect(mockOnStatusClick).not.toHaveBeenCalled();

      // Advance time by 50ms (before single-click would fire)
      vi.advanceTimersByTime(50);

      // Second click (double-click) should clear the timer
      fireEvent.doubleClick(completedLabel);

      // onStatusDoubleClick should fire immediately
      expect(mockOnStatusDoubleClick).toHaveBeenCalledTimes(1);
      expect(mockOnStatusDoubleClick).toHaveBeenCalledWith('completed');

      // Advance remaining time to verify single-click doesn't fire
      vi.advanceTimersByTime(200);
      expect(mockOnStatusClick).not.toHaveBeenCalled();
    });

    it('prevents single-click from firing when double-click occurs within debounce window', () => {
      const tasks = new Map<string, TaskState>([
        ['task-1', makeTask('failed')],
      ]);

      render(
        <StatusBar
          tasks={tasks}
          onStatusClick={mockOnStatusClick}
          onStatusDoubleClick={mockOnStatusDoubleClick}
        />,
      );

      const failedLabel = screen.getByText(/Failed:/);

      // Simulate rapid clicks (double-click pattern)
      fireEvent.click(failedLabel);
      vi.advanceTimersByTime(100); // Wait 100ms
      fireEvent.doubleClick(failedLabel);

      // Only double-click should have fired
      expect(mockOnStatusDoubleClick).toHaveBeenCalledTimes(1);
      expect(mockOnStatusDoubleClick).toHaveBeenCalledWith('failed');

      // Verify single-click never fires even after full delay
      vi.advanceTimersByTime(300);
      expect(mockOnStatusClick).not.toHaveBeenCalled();
    });

    it('double-click on running status clears timer and fires double-click handler', () => {
      const tasks = new Map<string, TaskState>([
        ['task-1', makeTask('running')],
      ]);

      render(
        <StatusBar
          tasks={tasks}
          onStatusClick={mockOnStatusClick}
          onStatusDoubleClick={mockOnStatusDoubleClick}
        />,
      );

      const runningLabel = screen.getByText(/Running:/);
      fireEvent.click(runningLabel);
      fireEvent.doubleClick(runningLabel);

      expect(mockOnStatusDoubleClick).toHaveBeenCalledWith('running');

      vi.advanceTimersByTime(300);
      expect(mockOnStatusClick).not.toHaveBeenCalled();
    });
  });

  describe('Multiple sequential clicks', () => {
    it('resets debounce timer on each new click before timeout', () => {
      const tasks = new Map<string, TaskState>([
        ['task-1', makeTask('completed')],
      ]);

      render(
        <StatusBar
          tasks={tasks}
          onStatusClick={mockOnStatusClick}
          onStatusDoubleClick={mockOnStatusDoubleClick}
        />,
      );

      const completedLabel = screen.getByText(/Completed:/);

      // First click
      fireEvent.click(completedLabel);
      vi.advanceTimersByTime(150);

      // Second click (before first would fire) - should reset timer
      fireEvent.click(completedLabel);
      vi.advanceTimersByTime(150);

      // Third click (before second would fire) - should reset timer again
      fireEvent.click(completedLabel);

      // Now wait full 200ms from the last click
      vi.advanceTimersByTime(200);

      // Should only fire once (for the last click)
      expect(mockOnStatusClick).toHaveBeenCalledTimes(1);
      expect(mockOnStatusClick).toHaveBeenCalledWith('completed');
    });
  });

  describe('Edge cases', () => {
    it('does not crash when onStatusClick is undefined', () => {
      const tasks = new Map<string, TaskState>([
        ['task-1', makeTask('completed')],
      ]);

      render(<StatusBar tasks={tasks} />);

      const completedLabel = screen.getByText(/Completed:/);
      fireEvent.click(completedLabel);

      vi.advanceTimersByTime(200);

      // Should not crash
      expect(mockOnStatusClick).not.toHaveBeenCalled();
    });

    it('does not crash when onStatusDoubleClick is undefined', () => {
      const tasks = new Map<string, TaskState>([
        ['task-1', makeTask('completed')],
      ]);

      render(
        <StatusBar
          tasks={tasks}
          onStatusClick={mockOnStatusClick}
        />,
      );

      const completedLabel = screen.getByText(/Completed:/);
      fireEvent.doubleClick(completedLabel);

      // Should not crash
      expect(mockOnStatusDoubleClick).not.toHaveBeenCalled();
    });

    it('clears timer on unmount to prevent memory leaks', () => {
      const tasks = new Map<string, TaskState>([
        ['task-1', makeTask('completed')],
      ]);

      const { unmount } = render(
        <StatusBar
          tasks={tasks}
          onStatusClick={mockOnStatusClick}
          onStatusDoubleClick={mockOnStatusDoubleClick}
        />,
      );

      const completedLabel = screen.getByText(/Completed:/);
      fireEvent.click(completedLabel);

      // Unmount before timer fires
      unmount();

      // Advance timers after unmount
      vi.advanceTimersByTime(300);

      // Callback should not fire after unmount
      // (This would crash if timer wasn't cleared, or at minimum call the callback unnecessarily)
      expect(mockOnStatusClick).not.toHaveBeenCalled();
    });
  });

  describe('Different status filters', () => {
    it('handles clicks on conditional status labels (needs_input)', () => {
      const tasks = new Map<string, TaskState>([
        ['task-1', makeTask('needs_input')],
      ]);

      render(
        <StatusBar
          tasks={tasks}
          onStatusClick={mockOnStatusClick}
          onStatusDoubleClick={mockOnStatusDoubleClick}
        />,
      );

      const inputLabel = screen.getByText(/Input:/);
      fireEvent.click(inputLabel);

      vi.advanceTimersByTime(200);
      expect(mockOnStatusClick).toHaveBeenCalledWith('needs_input');
    });

    it('handles clicks on awaiting_approval status', () => {
      const tasks = new Map<string, TaskState>([
        ['task-1', makeTask('awaiting_approval')],
      ]);

      render(
        <StatusBar
          tasks={tasks}
          onStatusClick={mockOnStatusClick}
          onStatusDoubleClick={mockOnStatusDoubleClick}
        />,
      );

      const approvalLabel = screen.getByText(/Approval:/);
      fireEvent.click(approvalLabel);

      vi.advanceTimersByTime(200);
      expect(mockOnStatusClick).toHaveBeenCalledWith('awaiting_approval');
    });

    it('handles clicks on blocked status', () => {
      const tasks = new Map<string, TaskState>([
        ['task-1', makeTask('blocked')],
      ]);

      render(
        <StatusBar
          tasks={tasks}
          onStatusClick={mockOnStatusClick}
          onStatusDoubleClick={mockOnStatusDoubleClick}
        />,
      );

      const blockedLabel = screen.getByText(/Blocked:/);
      fireEvent.click(blockedLabel);

      vi.advanceTimersByTime(200);
      expect(mockOnStatusClick).toHaveBeenCalledWith('blocked');
    });
  });
});
