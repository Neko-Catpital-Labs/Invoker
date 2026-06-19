import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowInspector } from '../components/WorkflowInspector.js';
import type { TaskState, WorkflowMeta } from '../types.js';

function makeTask(partial?: Partial<TaskState>): TaskState {
  return {
    id: 'task-1',
    description: 'Task',
    status: 'running',
    dependencies: [],
    config: { workflowId: 'wf-1', prompt: 'Fix failing tests', executionAgent: 'codex' },
    execution: { reviewUrl: 'https://github.com/org/repo/pull/12' },
    taskStateVersion: 1,
    ...partial,
  };
}

const workflow: WorkflowMeta = {
  id: 'wf-1',
  name: 'Workflow 1',
  status: 'running',
  baseBranch: 'main',
};

describe('WorkflowInspector', () => {
  it('keeps advanced metadata collapsed by default', () => {
    render(
      <WorkflowInspector
        workflow={workflow}
        task={makeTask({ status: 'failed' })}
        collapsed={false}
        advancedExpanded={false}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    expect(screen.getByText(/Advanced metadata/i)).toBeInTheDocument();
    expect(screen.queryByText(/workflow id:/i)).not.toBeInTheDocument();
  });

  it('hides the Pull Request section for a non-review-gate task even when reviewUrl is set', () => {
    render(
      <WorkflowInspector
        workflow={{ ...workflow, status: 'review_ready' }}
        task={makeTask({
          status: 'completed',
          config: { workflowId: 'wf-1', prompt: 'Fix failing tests' },
          execution: { reviewUrl: 'https://github.com/org/repo/pull/12' },
        })}
        collapsed={false}
        advancedExpanded={false}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    expect(screen.queryByText('Pull Request')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /github\.com/i })).not.toBeInTheDocument();
  });

  it('hides the Pull Request section for a review gate when its workflow is not review_ready', () => {
    render(
      <WorkflowInspector
        workflow={{ ...workflow, status: 'running' }}
        task={makeTask({
          id: '__merge__wf-1',
          description: 'Merge gate',
          status: 'review_ready',
          config: { workflowId: 'wf-1', isMergeNode: true },
          execution: { reviewUrl: 'https://github.com/org/repo/pull/34' },
        })}
        collapsed={false}
        advancedExpanded={false}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    expect(screen.queryByText('Pull Request')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /github\.com/i })).not.toBeInTheDocument();
  });

  it('shows the PR link for a review-ready review gate in a review-ready workflow', () => {
    render(
      <WorkflowInspector
        workflow={{ ...workflow, status: 'review_ready' }}
        task={makeTask({
          id: '__merge__wf-1',
          description: 'Merge gate',
          status: 'review_ready',
          config: { workflowId: 'wf-1', isMergeNode: true },
          execution: { reviewUrl: 'https://github.com/org/repo/pull/34' },
        })}
        collapsed={false}
        advancedExpanded={false}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    expect(screen.getByText('Pull Request')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /github\.com/i });
    expect(link).toHaveAttribute('href', 'https://github.com/org/repo/pull/34');
  });

  it('resolves the review-ready merge node PR URL for workflow-only selection when the workflow is review_ready', () => {
    const mergeTask = makeTask({
      id: '__merge__wf-1',
      description: 'Merge gate',
      status: 'review_ready',
      config: { workflowId: 'wf-1', isMergeNode: true },
      execution: { reviewUrl: 'https://github.com/org/repo/pull/34' },
    });
    const otherTask = makeTask({
      id: 'task-2',
      execution: { reviewUrl: 'https://github.com/org/repo/pull/12' },
    });

    render(
      <WorkflowInspector
        workflow={{ ...workflow, status: 'review_ready' }}
        task={null}
        workflowTasks={new Map([
          [otherTask.id, otherTask],
          [mergeTask.id, mergeTask],
        ])}
        collapsed={false}
        advancedExpanded={false}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    expect(screen.getByText('Pull Request')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /github\.com/i });
    expect(link).toHaveAttribute('href', 'https://github.com/org/repo/pull/34');
  });

  it('can be collapsed and restored', () => {
    const { rerender } = render(
      <WorkflowInspector
        workflow={workflow}
        task={makeTask()}
        collapsed={true}
        advancedExpanded={false}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Maximize inspector' })).toBeInTheDocument();

    rerender(
      <WorkflowInspector
        workflow={workflow}
        task={makeTask()}
        collapsed={false}
        advancedExpanded={false}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );
    expect(screen.getByText('Workflow 1')).toBeInTheDocument();
  });

  it('uses the selected workflow title as the side panel title without a generic inspector label', () => {
    render(
      <WorkflowInspector
        workflow={workflow}
        task={null}
        workflowTasks={new Map([['task-1', makeTask()]])}
        collapsed={false}
        advancedExpanded={false}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Workflow 1');
    expect(screen.queryByText('Workflow 1 task DAG')).not.toBeInTheDocument();
    expect(screen.queryByText('Inspector')).not.toBeInTheDocument();
  });

  it('uses the selected task title as the side panel title without a generic inspector label', () => {
    render(
      <WorkflowInspector
        workflow={workflow}
        task={makeTask({ description: 'Fix cancellation race', status: 'failed' })}
        collapsed={false}
        advancedExpanded={false}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Fix cancellation race');
    expect(screen.queryByText('Inspector')).not.toBeInTheDocument();
  });

  it('renders selected task title and selected task status first', () => {
    render(
      <WorkflowInspector
        workflow={workflow}
        task={makeTask({ description: 'Fix cancellation race', status: 'failed' })}
        collapsed={false}
        advancedExpanded={false}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    expect(screen.getByText('Fix cancellation race')).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
  });

  it('does not render prompt content for workflow-only selection', () => {
    render(
      <WorkflowInspector
        workflow={workflow}
        task={null}
        collapsed={false}
        advancedExpanded={false}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    expect(screen.queryByTestId('prompt-command-display')).not.toBeInTheDocument();
    expect(screen.queryByText('No prompt or command available.')).not.toBeInTheDocument();
  });

  it('does not render prompt content for non-AI and non-command tasks', () => {
    render(
      <WorkflowInspector
        workflow={workflow}
        task={makeTask({ config: { workflowId: 'wf-1', runnerKind: 'merge', isMergeNode: true } })}
        collapsed={false}
        advancedExpanded={false}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    expect(screen.queryByTestId('prompt-command-display')).not.toBeInTheDocument();
    expect(screen.queryByText('No prompt or command available.')).not.toBeInTheDocument();
  });

  it('edits AI agent from a dropdown', () => {
    const onEditAgent = vi.fn();
    render(
      <WorkflowInspector
        workflow={workflow}
        task={makeTask()}
        executionAgents={['claude', 'codex']}
        collapsed={false}
        advancedExpanded={false}
        onEditAgent={onEditAgent}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    fireEvent.change(screen.getByTestId('execution-agent-select'), { target: { value: 'claude' } });
    expect(onEditAgent).toHaveBeenCalledWith('task-1', 'claude');
  });

  it('double-click edits prompt and saves through callback', () => {
    const onEditPrompt = vi.fn();
    render(
      <WorkflowInspector
        workflow={workflow}
        task={makeTask({ status: 'failed' })}
        collapsed={false}
        advancedExpanded={false}
        onEditPrompt={onEditPrompt}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    fireEvent.doubleClick(screen.getByTestId('prompt-command-display'));
    fireEvent.change(screen.getByTestId('edit-prompt-input'), { target: { value: 'New prompt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save & Re-run' }));

    expect(onEditPrompt).toHaveBeenCalledWith('task-1', 'New prompt');
  });

  it('double-click edits command and saves through callback', () => {
    const onEditCommand = vi.fn();
    render(
      <WorkflowInspector
        workflow={workflow}
        task={makeTask({ status: 'failed', config: { workflowId: 'wf-1', command: 'pnpm test' } })}
        collapsed={false}
        advancedExpanded={false}
        onEditCommand={onEditCommand}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    fireEvent.doubleClick(screen.getByTestId('prompt-command-display'));
    fireEvent.change(screen.getByTestId('edit-command-input'), { target: { value: 'pnpm test --runInBand' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save & Re-run' }));

    expect(onEditCommand).toHaveBeenCalledWith('task-1', 'pnpm test --runInBand');
  });

  it('edits executor pool outside advanced metadata', () => {
    const onEditPool = vi.fn();
    render(
      <WorkflowInspector
        workflow={workflow}
        task={makeTask({ config: { workflowId: 'wf-1', prompt: 'Fix failing tests', poolId: 'mixed-local-ssh' } })}
        executionPools={['mixed-local-ssh', 'pnpm-ssh']}
        collapsed={false}
        advancedExpanded={true}
        onEditPool={onEditPool}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    fireEvent.change(screen.getByTestId('executor-pool-select'), { target: { value: 'pnpm-ssh' } });
    expect(onEditPool).toHaveBeenCalledWith('task-1', 'pnpm-ssh');
    expect(screen.queryByText(/executor:/i)).not.toBeInTheDocument();
  });

  it('sets workflow-level merge mode to external review', () => {
    const onSetMergeMode = vi.fn(async () => {});
    const mergeTask = makeTask({
      id: '__merge__wf-1',
      description: 'Merge gate',
      status: 'pending',
      config: { workflowId: 'wf-1', isMergeNode: true },
      execution: {},
    });

    render(
      <WorkflowInspector
        workflow={{ ...workflow, mergeMode: 'manual' }}
        task={null}
        workflowTasks={new Map([[mergeTask.id, mergeTask]])}
        collapsed={false}
        advancedExpanded={false}
        onSetMergeMode={onSetMergeMode}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    fireEvent.change(screen.getByTestId('workflow-merge-mode-select'), { target: { value: 'external_review' } });
    expect(onSetMergeMode).toHaveBeenCalledWith('wf-1', 'external_review');
  });

  it('shows workflow-level conversion for a review-ready merge gate without a PR URL', () => {
    const onSetMergeMode = vi.fn(async () => {});
    const mergeTask = makeTask({
      id: '__merge__wf-1',
      description: 'Merge gate',
      status: 'review_ready',
      config: { workflowId: 'wf-1', isMergeNode: true },
      execution: {},
    });

    render(
      <WorkflowInspector
        workflow={{ ...workflow, status: 'review_ready', mergeMode: 'manual' }}
        task={null}
        workflowTasks={new Map([[mergeTask.id, mergeTask]])}
        collapsed={false}
        advancedExpanded={false}
        onSetMergeMode={onSetMergeMode}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    const convertButton = screen.getByRole('button', { name: 'Use GitHub review' });
    expect(convertButton).toBeInTheDocument();

    fireEvent.click(convertButton);
    expect(onSetMergeMode).toHaveBeenCalledWith('wf-1', 'external_review');
  });
});
