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

function workflowTaskMap(...workflowTasks: TaskState[]): Map<string, TaskState> {
  return new Map(workflowTasks.map((workflowTask) => [workflowTask.id, workflowTask]));
}

describe('WorkflowInspector', () => {
  it('keeps advanced metadata collapsed by default', () => {
    render(
      <WorkflowInspector
        workflow={workflow}
        task={makeTask()}
        executionAgents={['codex', 'claude']}
        collapsed={false}
        advancedExpanded={false}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    expect(screen.getByText(/Advanced metadata/i)).toBeInTheDocument();
    expect(screen.queryByText(/workflow id:/i)).not.toBeInTheDocument();
  });

  it('renders PR URL as hyperlink when present', () => {
    render(
      <WorkflowInspector
        workflow={workflow}
        task={makeTask()}
        executionAgents={['codex', 'claude']}
        collapsed={false}
        advancedExpanded={false}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    const link = screen.getByRole('link', { name: /github\.com/i });
    expect(link).toHaveAttribute('href', 'https://github.com/org/repo/pull/12');
  });

  it('keeps the status section before task controls when a task is selected', () => {
    render(
      <WorkflowInspector
        workflow={workflow}
        task={makeTask()}
        executionAgents={['codex', 'claude']}
        collapsed={false}
        advancedExpanded={false}
        onEditAgent={vi.fn()}
        onEditPrompt={vi.fn()}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    const statusLabel = screen.getByText('Task Status');
    const agentLabel = screen.getByText('AI Agent');
    const promptInput = screen.getByTestId('workflow-inspector-prompt-input');

    expect(statusLabel.compareDocumentPosition(agentLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(statusLabel.compareDocumentPosition(promptInput) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows workflow status at the top when only a workflow is selected', () => {
    render(
      <WorkflowInspector
        workflow={{ ...workflow, status: 'running' }}
        task={null}
        executionAgents={['codex', 'claude']}
        collapsed={false}
        advancedExpanded={false}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    const statusLabel = screen.getByText('Workflow Status');
    const pullRequestLabel = screen.getByText('Pull Request');

    expect(screen.getByTestId('workflow-inspector-status-label')).toHaveTextContent('running');
    expect(statusLabel.compareDocumentPosition(pullRequestLabel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('uses the selected workflow merge gate PR URL when only a workflow is selected', () => {
    render(
      <WorkflowInspector
        workflow={workflow}
        task={null}
        workflowTasks={workflowTaskMap(
          makeTask({
            id: 'task-with-pr',
            execution: { reviewUrl: 'https://github.com/org/repo/pull/leaf' },
          }),
          makeTask({
            id: '__merge__wf-1',
            config: { workflowId: 'wf-1', prompt: 'Merge', isMergeNode: true },
            execution: { reviewUrl: 'https://github.com/org/repo/pull/merge' },
          }),
        )}
        executionAgents={['codex', 'claude']}
        collapsed={false}
        advancedExpanded={false}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    const link = screen.getByRole('link', { name: /pull\/merge/i });
    expect(link).toHaveAttribute('href', 'https://github.com/org/repo/pull/merge');
  });

  it('shows no PR linked for workflow selection when no workflow task has a PR URL', () => {
    render(
      <WorkflowInspector
        workflow={workflow}
        task={null}
        workflowTasks={workflowTaskMap(
          makeTask({
            id: '__merge__wf-1',
            config: { workflowId: 'wf-1', prompt: 'Merge', isMergeNode: true },
            execution: {},
          }),
        )}
        executionAgents={['codex', 'claude']}
        collapsed={false}
        advancedExpanded={false}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    expect(screen.getByText('No PR linked')).toBeInTheDocument();
  });

  it('uses the selected task PR URL before the workflow merge gate PR URL', () => {
    render(
      <WorkflowInspector
        workflow={workflow}
        task={makeTask({ execution: { reviewUrl: 'https://github.com/org/repo/pull/task' } })}
        workflowTasks={workflowTaskMap(
          makeTask({
            id: '__merge__wf-1',
            config: { workflowId: 'wf-1', prompt: 'Merge', isMergeNode: true },
            execution: { reviewUrl: 'https://github.com/org/repo/pull/merge' },
          }),
        )}
        executionAgents={['codex', 'claude']}
        collapsed={false}
        advancedExpanded={false}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    const link = screen.getByRole('link', { name: /pull\/task/i });
    expect(link).toHaveAttribute('href', 'https://github.com/org/repo/pull/task');
  });

  it('can be collapsed and restored', () => {
    const { rerender } = render(
      <WorkflowInspector
        workflow={workflow}
        task={makeTask()}
        executionAgents={['codex', 'claude']}
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
        executionAgents={['codex', 'claude']}
        collapsed={false}
        advancedExpanded={false}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );
    expect(screen.getByText('Workflow 1')).toBeInTheDocument();
  });

  it('edits the selected task agent and prompt from inspector controls', () => {
    const onEditAgent = vi.fn();
    const onEditPrompt = vi.fn();

    render(
      <WorkflowInspector
        workflow={workflow}
        task={makeTask({ status: 'pending' })}
        executionAgents={['claude', 'codex']}
        collapsed={false}
        advancedExpanded={false}
        onEditAgent={onEditAgent}
        onEditPrompt={onEditPrompt}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    fireEvent.change(screen.getByTestId('workflow-inspector-agent-select'), {
      target: { value: 'claude' },
    });
    expect(onEditAgent).toHaveBeenCalledWith('task-1', 'claude');

    fireEvent.change(screen.getByTestId('workflow-inspector-prompt-input'), {
      target: { value: 'Fix failing tests and update docs' },
    });
    fireEvent.blur(screen.getByTestId('workflow-inspector-prompt-input'));
    expect(onEditPrompt).toHaveBeenCalledWith('task-1', 'Fix failing tests and update docs');
  });

  it('edits the selected task executor from a primary inspector control', () => {
    const onEditType = vi.fn();

    render(
      <WorkflowInspector
        workflow={workflow}
        task={makeTask({ status: 'pending' })}
        remoteTargets={['remote-a']}
        executionAgents={['claude', 'codex']}
        collapsed={false}
        advancedExpanded={false}
        onEditType={onEditType}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    const select = screen.getByTestId('workflow-inspector-executor-select');
    expect(select).toBeInTheDocument();

    fireEvent.change(select, { target: { value: 'ssh:remote-a' } });
    expect(onEditType).toHaveBeenCalledWith('task-1', 'ssh', 'remote-a');
  });

  it('shows task status instead of workflow status when a task is selected', () => {
    render(
      <WorkflowInspector
        workflow={{ ...workflow, status: 'running' }}
        task={makeTask({ status: 'failed', execution: { error: 'boom' } })}
        executionAgents={['claude', 'codex']}
        collapsed={false}
        advancedExpanded={false}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    expect(screen.getByTestId('workflow-inspector-status-label')).toHaveTextContent('failed');
  });

  it('hides task-only controls when only a workflow is selected', () => {
    render(
      <WorkflowInspector
        workflow={{ ...workflow, status: 'running' }}
        task={null}
        executionAgents={['claude', 'codex']}
        collapsed={false}
        advancedExpanded={false}
        onEditAgent={vi.fn()}
        onEditPrompt={vi.fn()}
        onEditType={vi.fn()}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    expect(screen.getByTestId('workflow-inspector-status-label')).toHaveTextContent('running');
    expect(screen.queryByTestId('workflow-inspector-agent-select')).not.toBeInTheDocument();
    expect(screen.queryByTestId('workflow-inspector-prompt-input')).not.toBeInTheDocument();
    expect(screen.queryByTestId('workflow-inspector-executor-select')).not.toBeInTheDocument();
  });
});
