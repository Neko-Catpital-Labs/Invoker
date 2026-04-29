import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TaskPanel } from '../components/TaskPanel.js';
import type { TaskState } from '../types.js';

function makeTask(overrides: Partial<TaskState> & { command?: string; prompt?: string } = {}): TaskState {
  const { command, prompt, ...rest } = overrides;
  return {
    id: 'test-task-1',
    description: 'Test task',
    status: 'pending',
    dependencies: [],
    createdAt: new Date(),
    config: { command, prompt },
    execution: {},
    ...rest,
  } as TaskState;
}

describe('TaskPanel double-click editing', () => {
  const mockOnEditCommand = vi.fn();
  const mockOnProvideInput = vi.fn();
  const mockOnApprove = vi.fn();
  const mockOnReject = vi.fn();
  const mockOnSelectExperiment = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Edit button removal', () => {
    it('does not render Edit button for editable command tasks', () => {
      const task = makeTask({ command: 'echo test', status: 'pending' });
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditCommand={mockOnEditCommand}
        />,
      );

      expect(screen.queryByTestId('edit-command-btn')).not.toBeInTheDocument();
    });

    it('does not render Edit button even when canEditCommand is true', () => {
      const task = makeTask({ command: 'npm test', status: 'completed' });
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditCommand={mockOnEditCommand}
        />,
      );

      expect(screen.queryByTestId('edit-command-btn')).not.toBeInTheDocument();
      expect(screen.queryByText('Edit')).not.toBeInTheDocument();
    });
  });

  describe('Double-click to edit', () => {
    it('enters edit mode when double-clicking command display with canEditCommand true', () => {
      const task = makeTask({ command: 'echo hello', status: 'pending' });
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditCommand={mockOnEditCommand}
        />,
      );

      const commandDisplay = screen.getByTestId('command-display');
      fireEvent.doubleClick(commandDisplay);

      expect(screen.getByTestId('edit-command-input')).toBeInTheDocument();
      expect(screen.getByTestId('save-command-btn')).toBeInTheDocument();
      expect(screen.getByTestId('cancel-edit-btn')).toBeInTheDocument();
    });

    it('does NOT enter edit mode when task is running', () => {
      const task = makeTask({ command: 'echo running', status: 'running' });
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditCommand={mockOnEditCommand}
        />,
      );

      const commandDisplay = screen.getByTestId('command-display');
      fireEvent.doubleClick(commandDisplay);

      expect(screen.queryByTestId('edit-command-input')).not.toBeInTheDocument();
    });

    it('does NOT enter edit mode when onEditCommand is not provided', () => {
      const task = makeTask({ command: 'echo test', status: 'pending' });
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          // no onEditCommand provided
        />,
      );

      const commandDisplay = screen.getByTestId('command-display');
      fireEvent.doubleClick(commandDisplay);

      expect(screen.queryByTestId('edit-command-input')).not.toBeInTheDocument();
    });

    it('does NOT enter edit mode when task has no command', () => {
      const task = makeTask({ command: undefined, status: 'pending' });
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditCommand={mockOnEditCommand}
        />,
      );

      // Should not render command display at all
      expect(screen.queryByTestId('command-display')).not.toBeInTheDocument();
    });

    it('does NOT enter edit mode on Claude tasks (prompt tasks)', () => {
      const task = makeTask({ prompt: 'Write a test', status: 'pending' });
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditCommand={mockOnEditCommand}
        />,
      );

      const commandDisplay = screen.getByTestId('command-display');
      fireEvent.doubleClick(commandDisplay);

      // Should not enter edit mode for prompt tasks
      expect(screen.queryByTestId('edit-command-input')).not.toBeInTheDocument();
    });
  });

  describe('Visual hints', () => {
    it('applies cursor-pointer style to editable command display', () => {
      const task = makeTask({ command: 'echo test', status: 'pending' });
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditCommand={mockOnEditCommand}
        />,
      );

      const commandDisplay = screen.getByTestId('command-display');
      expect(commandDisplay).toHaveClass('cursor-pointer');
    });

    it('applies cursor-text style to non-editable command display', () => {
      const task = makeTask({ command: 'echo running', status: 'running' });
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditCommand={mockOnEditCommand}
        />,
      );

      const commandDisplay = screen.getByTestId('command-display');
      expect(commandDisplay).toHaveClass('cursor-text');
      expect(commandDisplay).not.toHaveClass('cursor-pointer');
    });

    it('applies cursor-text style to Claude task display', () => {
      const task = makeTask({ prompt: 'Test prompt', status: 'pending' });
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditCommand={mockOnEditCommand}
        />,
      );

      const commandDisplay = screen.getByTestId('command-display');
      expect(commandDisplay).toHaveClass('cursor-text');
      expect(commandDisplay).not.toHaveClass('cursor-pointer');
    });

    it('applies hover border effect to editable command display', () => {
      const task = makeTask({ command: 'echo test', status: 'pending' });
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditCommand={mockOnEditCommand}
        />,
      );

      const commandDisplay = screen.getByTestId('command-display');
      expect(commandDisplay).toHaveClass('hover:border-gray-600');
      expect(commandDisplay).toHaveClass('transition-colors');
    });
  });

  describe('Edit mode functionality after double-click', () => {
    it('allows saving edited command after double-click trigger', () => {
      const task = makeTask({ command: 'echo original', status: 'pending' });
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditCommand={mockOnEditCommand}
        />,
      );

      // Double-click to enter edit mode
      const commandDisplay = screen.getByTestId('command-display');
      fireEvent.doubleClick(commandDisplay);

      // Edit the command
      const input = screen.getByTestId('edit-command-input');
      fireEvent.change(input, { target: { value: 'echo modified' } });

      // Save
      const saveBtn = screen.getByTestId('save-command-btn');
      fireEvent.click(saveBtn);

      expect(mockOnEditCommand).toHaveBeenCalledWith('test-task-1', 'echo modified');
    });

    it('allows canceling edit after double-click trigger', () => {
      const task = makeTask({ command: 'echo original', status: 'pending' });
      const { rerender } = render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditCommand={mockOnEditCommand}
        />,
      );

      // Double-click to enter edit mode
      fireEvent.doubleClick(screen.getByTestId('command-display'));

      // Edit the command
      const input = screen.getByTestId('edit-command-input');
      fireEvent.change(input, { target: { value: 'echo modified' } });

      // Cancel
      const cancelBtn = screen.getByTestId('cancel-edit-btn');
      fireEvent.click(cancelBtn);

      // Should not call onEditCommand
      expect(mockOnEditCommand).not.toHaveBeenCalled();

      // Re-render to simulate exit from edit mode
      rerender(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditCommand={mockOnEditCommand}
        />,
      );

      // Should show original command
      expect(screen.getByTestId('command-display')).toHaveTextContent('echo original');
    });

    it('initializes edit input with current command value', () => {
      const task = makeTask({ command: 'npm run build', status: 'completed' });
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditCommand={mockOnEditCommand}
        />,
      );

      fireEvent.doubleClick(screen.getByTestId('command-display'));

      const input = screen.getByTestId('edit-command-input') as HTMLTextAreaElement;
      expect(input.value).toBe('npm run build');
    });
  });

  describe('Text selection compatibility', () => {
    it('allows single click on command display', () => {
      const task = makeTask({ command: 'echo test', status: 'pending' });
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditCommand={mockOnEditCommand}
        />,
      );

      const commandDisplay = screen.getByTestId('command-display');
      fireEvent.click(commandDisplay);

      // Should not enter edit mode on single click
      expect(screen.queryByTestId('edit-command-input')).not.toBeInTheDocument();
    });

    it('has select-text class for text selection support', () => {
      const task = makeTask({ command: 'echo test', status: 'pending' });
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditCommand={mockOnEditCommand}
        />,
      );

      const commandDisplay = screen.getByTestId('command-display');
      expect(commandDisplay).toHaveClass('select-text');
    });
  });

  describe('Edge cases and task states', () => {
    it('handles double-click on pending tasks', () => {
      const task = makeTask({ command: 'echo pending', status: 'pending' });
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditCommand={mockOnEditCommand}
        />,
      );

      fireEvent.doubleClick(screen.getByTestId('command-display'));
      expect(screen.getByTestId('edit-command-input')).toBeInTheDocument();
    });

    it('handles double-click on completed tasks', () => {
      const task = makeTask({ command: 'echo completed', status: 'completed' });
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditCommand={mockOnEditCommand}
        />,
      );

      fireEvent.doubleClick(screen.getByTestId('command-display'));
      expect(screen.getByTestId('edit-command-input')).toBeInTheDocument();
    });

    it('handles double-click on failed tasks', () => {
      const task = makeTask({ command: 'echo failed', status: 'failed' });
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditCommand={mockOnEditCommand}
        />,
      );

      fireEvent.doubleClick(screen.getByTestId('command-display'));
      expect(screen.getByTestId('edit-command-input')).toBeInTheDocument();
    });

    it('blocks double-click on running tasks', () => {
      const task = makeTask({ command: 'echo running', status: 'running' });
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditCommand={mockOnEditCommand}
        />,
      );

      fireEvent.doubleClick(screen.getByTestId('command-display'));
      expect(screen.queryByTestId('edit-command-input')).not.toBeInTheDocument();
    });

    it('does not render command display for empty command string', () => {
      const task = makeTask({ command: '', status: 'pending' });
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditCommand={mockOnEditCommand}
        />,
      );

      // Empty string is falsy, so command display should not render
      expect(screen.queryByTestId('command-display')).not.toBeInTheDocument();
    });
  });

  describe('Command display element', () => {
    it('has data-testid="command-display" for testing', () => {
      const task = makeTask({ command: 'echo test', status: 'pending' });
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditCommand={mockOnEditCommand}
        />,
      );

      expect(screen.getByTestId('command-display')).toBeInTheDocument();
    });

    it('renders command text inside command-display element', () => {
      const task = makeTask({ command: 'pnpm test', status: 'pending' });
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditCommand={mockOnEditCommand}
        />,
      );

      const commandDisplay = screen.getByTestId('command-display');
      expect(commandDisplay).toHaveTextContent('pnpm test');
    });

    it('renders prompt text inside command-display element for Claude tasks', () => {
      const task = makeTask({ prompt: 'Create a new feature', status: 'pending' });
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditCommand={mockOnEditCommand}
        />,
      );

      const commandDisplay = screen.getByTestId('command-display');
      expect(commandDisplay).toHaveTextContent('Create a new feature');
    });
  });

  describe('canEditCommand logic', () => {
    it('canEditCommand is true when command exists, task not running, and onEditCommand provided', () => {
      const task = makeTask({ command: 'echo test', status: 'pending' });
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditCommand={mockOnEditCommand}
        />,
      );

      // Verify by checking cursor style and ability to enter edit mode
      const commandDisplay = screen.getByTestId('command-display');
      expect(commandDisplay).toHaveClass('cursor-pointer');

      fireEvent.doubleClick(commandDisplay);
      expect(screen.getByTestId('edit-command-input')).toBeInTheDocument();
    });

    it('canEditCommand is false when command is undefined', () => {
      const task = makeTask({ command: undefined, status: 'pending' });
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditCommand={mockOnEditCommand}
        />,
      );

      expect(screen.queryByTestId('command-display')).not.toBeInTheDocument();
    });

    it('canEditCommand is false when status is running', () => {
      const task = makeTask({ command: 'echo test', status: 'running' });
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditCommand={mockOnEditCommand}
        />,
      );

      const commandDisplay = screen.getByTestId('command-display');
      expect(commandDisplay).toHaveClass('cursor-text');
      expect(commandDisplay).not.toHaveClass('cursor-pointer');
    });

    it('canEditCommand is false when onEditCommand is not provided', () => {
      const task = makeTask({ command: 'echo test', status: 'pending' });
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          // no onEditCommand
        />,
      );

      const commandDisplay = screen.getByTestId('command-display');
      expect(commandDisplay).toHaveClass('cursor-text');
      expect(commandDisplay).not.toHaveClass('cursor-pointer');
    });
  });

  describe('Executor dropdown for merge nodes', () => {
    it('does not render executor dropdown when task is a merge node', () => {
      const task = {
        ...makeTask({ command: 'echo test', status: 'pending' }),
        config: { command: 'echo test', isMergeNode: true },
      } as TaskState;
      const mockOnEditType = vi.fn();
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditCommand={mockOnEditCommand}
          onEditType={mockOnEditType}
        />,
      );

      expect(screen.queryByTestId('executor-type-select')).not.toBeInTheDocument();
    });

    it('renders executor dropdown for non-merge nodes when onEditType is provided', () => {
      const task = makeTask({
        command: 'echo test',
        status: 'pending',
      });
      const mockOnEditType = vi.fn();
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditCommand={mockOnEditCommand}
          onEditType={mockOnEditType}
        />,
      );

      expect(screen.getByTestId('executor-type-select')).toBeInTheDocument();
    });

    it('defaults executor select to worktree for prompt-only task when executorType unset (orchestrator default)', () => {
      const task = makeTask({
        prompt: 'Write a test',
        status: 'pending',
      });
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditCommand={mockOnEditCommand}
          onEditType={vi.fn()}
        />,
      );

      expect(screen.getByTestId('executor-type-select')).toHaveValue('worktree');
    });

    it('defaults executor select to worktree for command task when executorType unset (orchestrator default)', () => {
      const task = makeTask({
        command: 'echo test',
        status: 'pending',
      });
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditCommand={mockOnEditCommand}
          onEditType={vi.fn()}
        />,
      );

      expect(screen.getByTestId('executor-type-select')).toHaveValue('worktree');
    });

    it('renders SSH remote target options when remoteTargets are provided', () => {
      const task = makeTask({ command: 'echo test', status: 'pending' });
      render(
        <TaskPanel
          task={task}
          remoteTargets={['do-droplet', 'aws-instance']}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditCommand={mockOnEditCommand}
          onEditType={vi.fn()}
        />,
      );

      const select = screen.getByTestId('executor-type-select');
      const options = select.querySelectorAll('option');
      expect(options).toHaveLength(4);
      expect(options[2]).toHaveValue('ssh:do-droplet');
      expect(options[2]).toHaveTextContent('SSH: do-droplet');
      expect(options[3]).toHaveValue('ssh:aws-instance');
      expect(options[3]).toHaveTextContent('SSH: aws-instance');
    });

    it('does not render SSH options when remoteTargets is empty', () => {
      const task = makeTask({ command: 'echo test', status: 'pending' });
      render(
        <TaskPanel
          task={task}
          remoteTargets={[]}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditCommand={mockOnEditCommand}
          onEditType={vi.fn()}
        />,
      );

      const select = screen.getByTestId('executor-type-select');
      const options = select.querySelectorAll('option');
      expect(options).toHaveLength(2);
    });

    it('selects SSH target when task has executorType=ssh and remoteTargetId', () => {
      const task = makeTask({
        command: 'echo test',
        status: 'pending',
        config: { command: 'echo test', executorType: 'ssh', remoteTargetId: 'do-droplet' } as TaskState['config'],
      });
      render(
        <TaskPanel
          task={task}
          remoteTargets={['do-droplet']}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditCommand={mockOnEditCommand}
          onEditType={vi.fn()}
        />,
      );

      expect(screen.getByTestId('executor-type-select')).toHaveValue('ssh:do-droplet');
    });

    it('calls onEditType with ssh and remoteTargetId when SSH option selected', () => {
      const task = makeTask({ command: 'echo test', status: 'pending' });
      const mockOnEditType = vi.fn();
      render(
        <TaskPanel
          task={task}
          remoteTargets={['do-droplet']}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditCommand={mockOnEditCommand}
          onEditType={mockOnEditType}
        />,
      );

      const select = screen.getByTestId('executor-type-select');
      fireEvent.change(select, { target: { value: 'ssh:do-droplet' } });
      expect(mockOnEditType).toHaveBeenCalledWith('test-task-1', 'ssh', 'do-droplet');
    });

    it('calls onEditType without remoteTargetId when non-SSH option selected', () => {
      const task = makeTask({ command: 'echo test', status: 'pending' });
      const mockOnEditType = vi.fn();
      render(
        <TaskPanel
          task={task}
          remoteTargets={['do-droplet']}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditCommand={mockOnEditCommand}
          onEditType={mockOnEditType}
        />,
      );

      const select = screen.getByTestId('executor-type-select');
      fireEvent.change(select, { target: { value: 'docker' } });
      expect(mockOnEditType).toHaveBeenCalledWith('test-task-1', 'docker');
    });
  });

  describe('Fix approval button labels', () => {
    it('shows Approve Fix and Reject Fix for merge node awaiting fix approval', () => {
      const task = makeTask({
        status: 'awaiting_approval',
        config: { isMergeNode: true, workflowId: 'wf-1' } as TaskState['config'],
        execution: { pendingFixError: 'tests failed' } as TaskState['execution'],
      });
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
        />,
      );
      expect(screen.getByRole('button', { name: 'Approve Fix' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Reject Fix' })).toBeInTheDocument();
      expect(screen.queryByText('Approve Merge')).not.toBeInTheDocument();
    });

    it('shows Approve Merge when merge node has no pendingFixError', () => {
      const task = makeTask({
        status: 'awaiting_approval',
        config: { isMergeNode: true, workflowId: 'wf-1' } as TaskState['config'],
        execution: {} as TaskState['execution'],
      });
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
        />,
      );
      expect(screen.getByText('Approve Merge')).toBeInTheDocument();
      expect(screen.getByText('Reject Merge')).toBeInTheDocument();
    });
  });

  describe('Review URL display for merge gates', () => {
    it('renders review URL link when merge gate task has reviewUrl', () => {
      const task = makeTask({
        status: 'awaiting_approval',
        config: { isMergeNode: true, workflowId: 'wf-1' } as TaskState['config'],
        execution: { reviewUrl: 'https://github.com/owner/repo/pull/42' } as TaskState['execution'],
      });
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
        />,
      );

      const link = screen.getByTestId('pr-url-link');
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute('href', 'https://github.com/owner/repo/pull/42');
      expect(link).toHaveTextContent('owner/repo/pull/42');
    });

    it('renders review status when merge gate task has reviewStatus', () => {
      const task = makeTask({
        status: 'awaiting_approval',
        config: { isMergeNode: true, workflowId: 'wf-1' } as TaskState['config'],
        execution: { reviewUrl: 'https://github.com/owner/repo/pull/42', reviewStatus: 'Awaiting review' } as TaskState['execution'],
      });
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
        />,
      );

      const statusEl = screen.getByTestId('pr-status-text');
      expect(statusEl).toBeInTheDocument();
      expect(statusEl).toHaveTextContent('Awaiting review');
    });

    it('does not render review link when task is not a merge gate', () => {
      const task = makeTask({
        status: 'completed',
        execution: { reviewUrl: 'https://github.com/owner/repo/pull/99' } as TaskState['execution'],
      });
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
        />,
      );

      expect(screen.queryByTestId('pr-url-link')).not.toBeInTheDocument();
    });
  });

  describe('Execution agent selector', () => {
    const mockOnEditAgent = vi.fn();

    it('renders agent selector for prompt tasks when onEditAgent + executionAgents provided', () => {
      const task = makeTask({ prompt: 'Write a test', status: 'pending' });
      render(
        <TaskPanel
          task={task}
          executionAgents={['claude', 'codex']}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditAgent={mockOnEditAgent}
        />,
      );

      expect(screen.getByTestId('execution-agent-select')).toBeInTheDocument();
    });

    it('does not render agent selector for command-only tasks', () => {
      const task = makeTask({ command: 'echo test', status: 'pending' });
      render(
        <TaskPanel
          task={task}
          executionAgents={['claude', 'codex']}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditAgent={mockOnEditAgent}
        />,
      );

      expect(screen.queryByTestId('execution-agent-select')).not.toBeInTheDocument();
    });

    it('populates options from executionAgents prop with capitalized labels', () => {
      const task = makeTask({ prompt: 'Write a test', status: 'pending' });
      render(
        <TaskPanel
          task={task}
          executionAgents={['claude', 'codex']}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditAgent={mockOnEditAgent}
        />,
      );

      const select = screen.getByTestId('execution-agent-select');
      const options = select.querySelectorAll('option');
      expect(options).toHaveLength(2);
      expect(options[0]).toHaveTextContent('Claude Task');
      expect(options[1]).toHaveTextContent('Codex Task');
    });

    it('calls onEditAgent with selected value on change', () => {
      const task = makeTask({ prompt: 'Write a test', status: 'pending' });
      render(
        <TaskPanel
          task={task}
          executionAgents={['claude', 'codex']}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditAgent={mockOnEditAgent}
        />,
      );

      const select = screen.getByTestId('execution-agent-select');
      fireEvent.change(select, { target: { value: 'codex' } });
      expect(mockOnEditAgent).toHaveBeenCalledWith('test-task-1', 'codex');
    });

    it('disables selector when task is running', () => {
      const task = makeTask({ prompt: 'Write a test', status: 'running' });
      render(
        <TaskPanel
          task={task}
          executionAgents={['claude', 'codex']}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditAgent={mockOnEditAgent}
        />,
      );

      const select = screen.getByTestId('execution-agent-select');
      expect(select).toBeDisabled();
    });

    it('defaults to claude when executionAgent config is unset', () => {
      const task = makeTask({ prompt: 'Write a test', status: 'pending' });
      render(
        <TaskPanel
          task={task}
          executionAgents={['claude', 'codex']}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditAgent={mockOnEditAgent}
        />,
      );

      const select = screen.getByTestId('execution-agent-select') as HTMLSelectElement;
      expect(select.value).toBe('claude');
    });

    it('selects current agent when executionAgent is set', () => {
      const task = {
        ...makeTask({ prompt: 'Write a test', status: 'pending' }),
        config: { prompt: 'Write a test', executionAgent: 'codex' },
      } as TaskState;
      render(
        <TaskPanel
          task={task}
          executionAgents={['claude', 'codex']}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditAgent={mockOnEditAgent}
        />,
      );

      const select = screen.getByTestId('execution-agent-select') as HTMLSelectElement;
      expect(select.value).toBe('codex');
    });

    it('fallback badge shows capitalized agent name when onEditAgent not provided', () => {
      const task = {
        ...makeTask({ prompt: 'Write a test', status: 'pending' }),
        config: { prompt: 'Write a test', executionAgent: 'codex' },
      } as TaskState;
      render(
        <TaskPanel
          task={task}
          executionAgents={['claude', 'codex']}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          // no onEditAgent
        />,
      );

      expect(screen.queryByTestId('execution-agent-select')).not.toBeInTheDocument();
      expect(screen.getByText('Codex Task')).toBeInTheDocument();
    });

    it('fallback badge defaults to "Claude Task" when executionAgent unset', () => {
      const task = makeTask({ prompt: 'Write a test', status: 'pending' });
      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          // no onEditAgent
        />,
      );

      expect(screen.queryByTestId('execution-agent-select')).not.toBeInTheDocument();
      expect(screen.getByText('Claude Task')).toBeInTheDocument();
    });

    it('renders empty selector gracefully when executionAgents is empty', () => {
      const task = makeTask({ prompt: 'Write a test', status: 'pending' });
      render(
        <TaskPanel
          task={task}
          executionAgents={[]}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onEditAgent={mockOnEditAgent}
        />,
      );

      const select = screen.getByTestId('execution-agent-select');
      const options = select.querySelectorAll('option');
      expect(options).toHaveLength(0);
    });
  });

  describe('Gate Policy in side panel', () => {
    it('renders external gates with resolved status', () => {
      const task = makeTask({
        status: 'pending',
        config: {
          externalDependencies: [
            { workflowId: 'wf-1', taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'completed' },
          ],
        },
      });
      const allTasks = new Map<string, TaskState>([
        ['__merge__wf-1', makeTask({ id: '__merge__wf-1', status: 'review_ready' })],
      ]);

      render(
        <TaskPanel
          task={task}
          allTasks={allTasks}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
        />,
      );

      expect(screen.getByText('Gate Policy')).toBeInTheDocument();
      expect(screen.getByText('Currently')).toBeInTheDocument();
      expect(screen.getByText('Review Ready')).toBeInTheDocument();
      expect(screen.getByText('Unblock at')).toBeInTheDocument();
      expect(screen.getByText('Completed')).toBeInTheDocument();
    });

    it('edits and applies gate policy updates from side panel', async () => {
      const task = makeTask({
        status: 'pending',
        config: {
          externalDependencies: [
            { workflowId: 'wf-1', taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'completed' },
          ],
        },
      });
      const onSetExternalGatePolicies = vi.fn(async () => {});
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

      render(
        <TaskPanel
          task={task}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onSetExternalGatePolicies={onSetExternalGatePolicies}
        />,
      );

      fireEvent.click(screen.getByTestId('gate-policy-edit-btn'));
      fireEvent.change(screen.getByTestId('gate-policy-select-0'), { target: { value: 'review_ready' } });
      fireEvent.click(screen.getByTestId('gate-policy-apply-btn'));

      expect(confirmSpy).toHaveBeenCalled();
      await waitFor(() =>
        expect(onSetExternalGatePolicies).toHaveBeenCalledWith(
          'test-task-1',
          [{ workflowId: 'wf-1', taskId: '__merge__', gatePolicy: 'review_ready' }],
        ),
      );
      confirmSpy.mockRestore();
    });

    it('shows green summary and zero offender cards when all gates are satisfied', () => {
      const task = makeTask({
        status: 'pending',
        config: {
          externalDependencies: [
            { workflowId: 'wf-1', taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'completed' },
          ],
        },
      });
      const allTasks = new Map<string, TaskState>([
        ['__merge__wf-1', makeTask({ id: '__merge__wf-1', status: 'completed' })],
      ]);

      render(
        <TaskPanel
          task={task}
          allTasks={allTasks}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
        />,
      );

      expect(screen.getByText('Gate Policy')).toBeInTheDocument();
      const summary = screen.getByTestId('gate-policy-summary');
      expect(summary).toHaveTextContent('All 1 gate satisfied');
      expect(screen.queryByTestId('gate-policy-offender-wf-1::__merge__')).not.toBeInTheDocument();
      const satisfiedToggle = screen.getByTestId('gate-policy-satisfied-toggle');
      expect(satisfiedToggle).toHaveTextContent('1 satisfied gate');
    });

    it('shows amber summary and one offender card when one gate is blocking', () => {
      const task = makeTask({
        status: 'pending',
        config: {
          externalDependencies: [
            { workflowId: 'wf-1', taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'completed' },
          ],
        },
      });
      const allTasks = new Map<string, TaskState>([
        ['__merge__wf-1', makeTask({ id: '__merge__wf-1', status: 'review_ready' })],
      ]);

      render(
        <TaskPanel
          task={task}
          allTasks={allTasks}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
        />,
      );

      const summary = screen.getByTestId('gate-policy-summary');
      expect(summary).toHaveTextContent('1 gate blocking');
      const offenderRow = screen.getByTestId('gate-policy-offender-wf-1::__merge__');
      expect(offenderRow).toBeInTheDocument();
      const workflowName = offenderRow.querySelector('.text-red-300');
      expect(workflowName).toBeInTheDocument();
      expect(screen.getByText('Currently')).toBeInTheDocument();
      expect(screen.getByText('Review Ready')).toBeInTheDocument();
      expect(screen.getByText('Unblock at')).toBeInTheDocument();
      expect(screen.getByText('Completed')).toBeInTheDocument();
    });

    it('collapses satisfied gates by default in view mode and expands on click', () => {
      const task = makeTask({
        status: 'pending',
        config: {
          externalDependencies: [
            { workflowId: 'wf-1', taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'completed' },
            { workflowId: 'wf-2', taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'completed' },
            { workflowId: 'wf-3', taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'completed' },
          ],
        },
      });
      const allTasks = new Map<string, TaskState>([
        ['__merge__wf-1', makeTask({ id: '__merge__wf-1', status: 'review_ready' })],
        ['__merge__wf-2', makeTask({ id: '__merge__wf-2', status: 'completed' })],
        ['__merge__wf-3', makeTask({ id: '__merge__wf-3', status: 'completed' })],
      ]);

      render(
        <TaskPanel
          task={task}
          allTasks={allTasks}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
        />,
      );

      // Initially satisfied rows should not be visible
      expect(screen.queryByText('__merge__wf-2')).not.toBeInTheDocument();
      expect(screen.queryByText('__merge__wf-3')).not.toBeInTheDocument();

      // Click disclosure to expand
      const satisfiedToggle = screen.getByTestId('gate-policy-satisfied-toggle');
      expect(satisfiedToggle).toHaveTextContent('2 satisfied gates');
      fireEvent.click(satisfiedToggle);

      // Now satisfied rows should be visible
      expect(screen.getByText('__merge__wf-2')).toBeInTheDocument();
      expect(screen.getByText('__merge__wf-3')).toBeInTheDocument();
    });

    it('auto-expands satisfied gates when entering edit mode', () => {
      const task = makeTask({
        status: 'pending',
        config: {
          externalDependencies: [
            { workflowId: 'wf-1', taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'completed' },
            { workflowId: 'wf-2', taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'completed' },
          ],
        },
      });
      const allTasks = new Map<string, TaskState>([
        ['__merge__wf-1', makeTask({ id: '__merge__wf-1', status: 'review_ready' })],
        ['__merge__wf-2', makeTask({ id: '__merge__wf-2', status: 'completed' })],
      ]);
      const onSetExternalGatePolicies = vi.fn(async () => {});

      render(
        <TaskPanel
          task={task}
          allTasks={allTasks}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onSetExternalGatePolicies={onSetExternalGatePolicies}
        />,
      );

      // Initially satisfied row should not be visible
      expect(screen.queryByText('__merge__wf-2')).not.toBeInTheDocument();

      // Click Edit
      fireEvent.click(screen.getByTestId('gate-policy-edit-btn'));

      // Satisfied row should now be visible without clicking disclosure
      expect(screen.getByText('__merge__wf-2')).toBeInTheDocument();
    });

    it('classifies a mixed-policy group as an offender', () => {
      const task = makeTask({
        status: 'pending',
        config: {
          externalDependencies: [
            { workflowId: 'wf-1', taskId: 'task-a', requiredStatus: 'completed', gatePolicy: 'completed' },
            { workflowId: 'wf-1', taskId: 'task-b', requiredStatus: 'completed', gatePolicy: 'review_ready' },
          ],
        },
      });
      const allTasks = new Map<string, TaskState>([
        ['wf-1/task-a', makeTask({ id: 'wf-1/task-a', status: 'completed' })],
        ['wf-1/task-b', makeTask({ id: 'wf-1/task-b', status: 'completed' })],
      ]);

      render(
        <TaskPanel
          task={task}
          allTasks={allTasks}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
        />,
      );

      const offenderA = screen.getByTestId('gate-policy-offender-wf-1::task-a');
      const offenderB = screen.getByTestId('gate-policy-offender-wf-1::task-b');
      expect(offenderA).toBeInTheDocument();
      expect(offenderB).toBeInTheDocument();
      const mixedThresholdEls = screen.getAllByTestId(/gate-policy-mixed-thresholds-/);
      expect(mixedThresholdEls.length).toBeGreaterThan(0);
      expect(mixedThresholdEls[0]).toHaveTextContent('Mixed thresholds');
      const workflowName = offenderA.querySelector('.text-red-300');
      expect(workflowName).toBeInTheDocument();
    });

    it('lowering an offender threshold to match upstream shows the "would unblock now" impact line', async () => {
      const task = makeTask({
        status: 'pending',
        config: {
          externalDependencies: [
            { workflowId: 'wf-1', taskId: '__merge__', requiredStatus: 'completed', gatePolicy: 'completed' },
          ],
        },
      });
      const allTasks = new Map<string, TaskState>([
        ['__merge__wf-1', makeTask({ id: '__merge__wf-1', status: 'review_ready' })],
      ]);
      const onSetExternalGatePolicies = vi.fn(async () => {});

      render(
        <TaskPanel
          task={task}
          allTasks={allTasks}
          onProvideInput={mockOnProvideInput}
          onApprove={mockOnApprove}
          onReject={mockOnReject}
          onSelectExperiment={mockOnSelectExperiment}
          onSetExternalGatePolicies={onSetExternalGatePolicies}
        />,
      );

      // Click Edit
      fireEvent.click(screen.getByTestId('gate-policy-edit-btn'));

      // Change picker to review_ready
      fireEvent.change(screen.getByTestId('gate-policy-select-0'), { target: { value: 'review_ready' } });

      // Check for impact text
      await waitFor(() => {
        const impact = screen.getByTestId('gate-policy-impact-0');
        expect(impact).toHaveTextContent('would unblock now');
      });
    });
  });
});
