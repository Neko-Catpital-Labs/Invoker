import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

    it('defaults executor select to worktree for prompt-only task when familiarType unset (orchestrator default)', () => {
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

    it('defaults executor select to worktree for command task when familiarType unset (orchestrator default)', () => {
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

    it('selects SSH target when task has familiarType=ssh and remoteTargetId', () => {
      const task = makeTask({
        command: 'echo test',
        status: 'pending',
        config: { command: 'echo test', familiarType: 'ssh', remoteTargetId: 'do-droplet' } as TaskState['config'],
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
      expect(screen.getByText('Approve Fix')).toBeInTheDocument();
      expect(screen.getByText('Reject Fix')).toBeInTheDocument();
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

  describe('PR URL display for merge gates', () => {
    it('renders PR URL link when merge gate task has prUrl', () => {
      const task = makeTask({
        status: 'awaiting_approval',
        config: { isMergeNode: true, workflowId: 'wf-1' } as TaskState['config'],
        execution: { prUrl: 'https://github.com/owner/repo/pull/42' } as TaskState['execution'],
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

    it('renders PR status when merge gate task has prStatus', () => {
      const task = makeTask({
        status: 'awaiting_approval',
        config: { isMergeNode: true, workflowId: 'wf-1' } as TaskState['config'],
        execution: { prUrl: 'https://github.com/owner/repo/pull/42', prStatus: 'Awaiting review' } as TaskState['execution'],
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

    it('does not render PR link when task is not a merge gate', () => {
      const task = makeTask({
        status: 'completed',
        execution: { prUrl: 'https://github.com/owner/repo/pull/99' } as TaskState['execution'],
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
});
