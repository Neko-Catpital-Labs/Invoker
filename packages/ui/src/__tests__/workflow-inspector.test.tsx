import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowInspector } from '../components/WorkflowInspector.js';
import type { TaskState, WorkflowMeta } from '../types.js';
import type { WorkflowMutationFailedEvent } from '@invoker/contracts';

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

  it('shows and changes merge mode for a review-ready merge gate', () => {
    const onSetMergeMode = vi.fn();

    render(
      <WorkflowInspector
        workflow={{ ...workflow, status: 'review_ready', mergeMode: 'manual' }}
        task={makeTask({
          id: '__merge__wf-1',
          description: 'Review gate',
          status: 'review_ready',
          config: { workflowId: 'wf-1', isMergeNode: true },
        })}
        collapsed={false}
        advancedExpanded={false}
        onSetMergeMode={onSetMergeMode}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    expect(screen.getByText('Merge mode')).toBeInTheDocument();
    const select = screen.getByTestId('merge-mode-select');
    expect(select).toHaveValue('manual');
    expect(screen.getByRole('option', { name: 'External review (GitHub)' })).toBeInTheDocument();

    fireEvent.change(select, { target: { value: 'external_review' } });
    expect(onSetMergeMode).toHaveBeenCalledWith('wf-1', 'external_review');
  });

  it('keeps the PR link for a completed review gate in a completed workflow', () => {
    render(
      <WorkflowInspector
        workflow={{ ...workflow, status: 'completed' }}
        task={makeTask({
          id: '__merge__wf-1',
          description: 'Merge gate',
          status: 'completed',
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

  it('hides the PR link for a completed merge gate without a review URL', () => {
    render(
      <WorkflowInspector
        workflow={{ ...workflow, status: 'completed' }}
        task={makeTask({
          id: '__merge__wf-1',
          description: 'Merge gate',
          status: 'completed',
          config: { workflowId: 'wf-1', isMergeNode: true },
          execution: {},
        })}
        collapsed={false}
        advancedExpanded={false}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    expect(screen.queryByText('Pull Request')).not.toBeInTheDocument();
    expect(screen.queryByTestId('inspector-pr-link')).not.toBeInTheDocument();
  });

  it('disables merge mode while a merge gate is running', () => {
    render(
      <WorkflowInspector
        workflow={{ ...workflow, status: 'running', mergeMode: 'manual' }}
        task={makeTask({
          id: '__merge__wf-1',
          description: 'Review gate',
          status: 'running',
          config: { workflowId: 'wf-1', isMergeNode: true },
        })}
        collapsed={false}
        advancedExpanded={false}
        onSetMergeMode={() => Promise.resolve()}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    expect(screen.getByTestId('merge-mode-select')).toBeDisabled();
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

  it('resolves the completed merge node PR URL for workflow-only selection when the workflow is completed', () => {
    const mergeTask = makeTask({
      id: '__merge__wf-1',
      description: 'Merge gate',
      status: 'completed',
      config: { workflowId: 'wf-1', isMergeNode: true },
      execution: { reviewUrl: 'https://github.com/org/repo/pull/34' },
    });
    const otherTask = makeTask({
      id: 'task-2',
      execution: { reviewUrl: 'https://github.com/org/repo/pull/12' },
    });

    render(
      <WorkflowInspector
        workflow={{ ...workflow, status: 'completed' }}
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

  it('shows an empty pull request stack when review gate metadata has no current artifacts', () => {
    render(
      <WorkflowInspector
        workflow={{ ...workflow, status: 'review_ready' }}
        task={null}
        reviewGate={{
          workflowId: 'wf-1',
          mergeTaskId: '__merge__wf-1',
          status: 'review_ready',
          activeGeneration: 0,
          completion: { required: 'all', status: 'approved' },
          ready: false,
          substate: null,
          artifacts: [],
          discardedArtifacts: [],
          edges: [],

        }}
        collapsed={false}
        advancedExpanded={false}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    expect(screen.getByText('Pull Request Stack')).toBeInTheDocument();
    expect(screen.getByText('No pull requests yet')).toBeInTheDocument();
  });

  it('renders a flat pull request stack in artifact order', () => {
    render(
      <WorkflowInspector
        workflow={{ ...workflow, status: 'review_ready' }}
        task={null}
        reviewGate={{
          workflowId: 'wf-1',
          mergeTaskId: '__merge__wf-1',
          status: 'review_ready',
          activeGeneration: 0,
          completion: { required: 'all', status: 'approved' },
          ready: false,
          substate: null,
          artifacts: [
            { id: 'contracts', title: 'Define contracts', url: 'https://example.test/contracts', required: true, status: 'open', generation: 0 },
            { id: 'runtime', title: 'Wire runtime', url: 'https://example.test/runtime', required: true, status: 'open', generation: 0 },
          ],
          discardedArtifacts: [],
          edges: [],

        }}
        collapsed={false}
        advancedExpanded={false}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    expect(screen.getAllByTestId('inspector-pr-link').map((link) => link.textContent)).toEqual([
      'Define contracts',
      'Wire runtime',
    ]);
  });
  it('renders artifact detail lines from typed review metadata', () => {
    render(
      <WorkflowInspector
        workflow={{ ...workflow, status: 'review_ready' }}
        task={null}
        reviewGate={{
          workflowId: 'wf-1',
          mergeTaskId: '__merge__wf-1',
          status: 'review_ready',
          activeGeneration: 0,
          completion: { required: 'all', status: 'approved' },
          ready: false,
          substate: 'ci_failing',
          artifacts: [
            { id: 'conflict', title: 'Conflict', url: 'https://example.test/conflict', required: true, status: 'open', generation: 0, mergeState: 'dirty' },
            {
              id: 'checks',
              title: 'Checks',
              url: 'https://example.test/checks',
              required: true,
              status: 'open',
              generation: 0,
              checksState: 'failure',
              failedChecks: [{ name: 'lint' }, { name: 'unit' }],
            },
            { id: 'pending', title: 'Pending', url: 'https://example.test/pending', required: true, status: 'open', generation: 0, checksState: 'pending' },
            { id: 'passing', title: 'Passing', url: 'https://example.test/passing', required: true, status: 'open', generation: 0, checksState: 'success' },
          ],
          discardedArtifacts: [],
          edges: [],
        }}
        collapsed={false}
        advancedExpanded={false}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    expect(screen.getByText('Merge conflict')).toBeInTheDocument();
    expect(screen.getByText('lint, unit')).toBeInTheDocument();
    expect(screen.getByText('Checks pending')).toBeInTheDocument();
    expect(screen.getByText('Checks passing')).toBeInTheDocument();
  });


  it('renders a linear pull request stack with connectors', () => {
    render(
      <WorkflowInspector
        workflow={{ ...workflow, status: 'review_ready' }}
        task={null}
        reviewGate={{
          workflowId: 'wf-1',
          mergeTaskId: '__merge__wf-1',
          status: 'review_ready',
          activeGeneration: 0,
          completion: { required: 'all', status: 'approved' },
          ready: false,
          substate: null,
          artifacts: [
            { id: 'contracts', title: 'Contracts', url: 'https://example.test/contracts', required: true, status: 'approved', generation: 0 },
            { id: 'runtime', title: 'Runtime', url: 'https://example.test/runtime', required: true, status: 'open', generation: 0, dependsOn: ['contracts'] },
            { id: 'ui', title: 'UI', url: 'https://example.test/ui', required: true, status: 'open', generation: 0, dependsOn: ['runtime'] },
          ],
          discardedArtifacts: [],
          edges: [{ from: 'contracts', to: 'runtime' }, { from: 'runtime', to: 'ui' }],

        }}
        collapsed={false}
        advancedExpanded={false}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    expect(screen.getAllByTestId('review-gate-connector')).toHaveLength(3);
    expect(screen.queryByText(/depends on/i)).not.toBeInTheDocument();
    expect(screen.getAllByTestId('inspector-pr-link').map((link) => link.textContent)).toEqual([
      'Contracts',
      'Runtime',
      'UI',
    ]);
  });

  it('hides discarded artifacts from the main pull request stack', () => {
    render(
      <WorkflowInspector
        workflow={{ ...workflow, status: 'review_ready' }}
        task={null}
        reviewGate={{
          workflowId: 'wf-1',
          mergeTaskId: '__merge__wf-1',
          status: 'review_ready',
          activeGeneration: 1,
          completion: { required: 'all', status: 'approved' },
          ready: false,
          substate: null,
          artifacts: [
            { id: 'runtime', title: 'Runtime', url: 'https://example.test/runtime', required: true, status: 'open', generation: 1 },
          ],
          discardedArtifacts: [
            { id: 'contracts', title: 'Discarded contracts', required: true, status: 'discarded', generation: 0, discardedAt: '2024-01-01T00:00:00Z' },
          ],
          edges: [],
        }}
        collapsed={false}
        advancedExpanded={false}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    expect(screen.getByText('Runtime')).toBeInTheDocument();
    expect(screen.queryByText('Discarded contracts')).not.toBeInTheDocument();
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
        executionHarnesses={[
          { name: 'claude', supportedModels: [{ id: 'sonnet', label: 'Claude Sonnet' }] },
          { name: 'codex', supportedModels: [{ id: 'gpt-5-codex', label: 'GPT-5 Codex' }] },
        ]}
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

  it('renders the default model label and edits the selected model', () => {
    const onEditModel = vi.fn();
    render(
      <WorkflowInspector
        workflow={workflow}
        task={makeTask({
          status: 'pending',
          config: { workflowId: 'wf-1', prompt: 'Fix failing tests', executionAgent: 'omp' },
        })}
        executionHarnesses={[
          {
            name: 'omp',
            supportedModels: [
              { id: 'chatgpt-5.4', label: 'ChatGPT 5.4' },
              { id: 'openai/gpt-5-codex', label: 'OpenAI GPT-5 Codex' },
            ],
          },
        ]}
        executionDefaults={{ executionAgent: 'omp', executionModel: 'chatgpt-5.4' }}
        collapsed={false}
        advancedExpanded={false}
        onEditModel={onEditModel}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    expect(screen.getByRole('option', { name: 'Default (ChatGPT 5.4)' })).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('execution-model-select'), { target: { value: 'openai/gpt-5-codex' } });
    expect(onEditModel).toHaveBeenCalledWith('task-1', 'openai/gpt-5-codex');
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

  it('shows fix approval actions for an awaiting approval fix', () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const task = makeTask({
      status: 'awaiting_approval',
      execution: { pendingFixError: 'tests failed' },
    });

    render(
      <WorkflowInspector
        workflow={workflow}
        task={task}
        collapsed={false}
        advancedExpanded={false}
        onApprove={onApprove}
        onReject={onReject}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Approve Fix' }));
    expect(onApprove).toHaveBeenCalledWith(task);

    fireEvent.click(screen.getByRole('button', { name: 'Reject Fix' }));
    expect(onReject).toHaveBeenCalledWith(task);

    expect(screen.getByTestId('inspector-pending-fix-error')).toHaveTextContent('tests failed');
  });

  it('surfaces an executor-selection failure captured in pendingFixError so approve dispatch errors are visible', () => {
    const capabilityError =
      'Error: SSH target "remote_digital_ocean_3" cannot run codex: missing execution harness "codex"';
    const task = makeTask({
      status: 'awaiting_approval',
      execution: {
        pendingFixError: capabilityError,
      },
    });

    render(
      <WorkflowInspector
        workflow={workflow}
        task={task}
        collapsed={false}
        advancedExpanded={false}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    const panel = screen.getByTestId('inspector-pending-fix-error');
    expect(panel).toHaveTextContent(/cannot run codex/);
    expect(panel).toHaveTextContent(/missing execution harness "codex"/);
  });

  it('renders pendingFixError alongside execution.error when both are present', () => {
    const task = makeTask({
      status: 'awaiting_approval',
      execution: {
        error: 'exit 1',
        exitCode: 1,
        pendingFixError: 'Approval blocked: capability mismatch',
      },
    });

    render(
      <WorkflowInspector
        workflow={workflow}
        task={task}
        collapsed={false}
        advancedExpanded={false}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    expect(screen.getByText('exit 1')).toBeInTheDocument();
    expect(screen.getByTestId('inspector-pending-fix-error')).toHaveTextContent(
      'Approval blocked: capability mismatch',
    );
  });

  it('shows selected action graph node details', () => {
    render(
      <WorkflowInspector
        workflow={workflow}
        task={null}
        actionNode={{
          id: 'intent:77',
          type: 'mutation-intent',
          label: 'invoker:rebase-recreate',
          status: 'running',
          workflowId: 'wf-1',
          intentId: 77,
          durations: { runningMs: 12000 },
        }}
        collapsed={false}
        advancedExpanded={false}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    expect(screen.getByTestId('workflow-inspector-action-node')).toHaveTextContent('invoker:rebase-recreate');
    expect(screen.getByTestId('workflow-inspector-action-node-status')).toHaveTextContent('RUNNING');
    expect(screen.getByTestId('workflow-inspector-action-node')).toHaveTextContent('runningMs');
    expect(screen.getByTestId('workflow-inspector-action-node')).toHaveTextContent('12000');
  });

  it('shows task timeline events and matching worker decisions', async () => {
    (window as unknown as {
      invoker: {
        getEvents: (taskId: string, options: { limit: number }) => Promise<Array<{ id: number; eventType: string; payload?: string; createdAt?: string }>>;
        getWorkerDecisions: () => Promise<{
          actions: Array<Record<string, unknown>>;
          limit: number;
          offset: number;
          hasMore: boolean;
        }>;
      };
    }).invoker = {
      getEvents: vi.fn(async () => [
        {
          id: 3,
          eventType: 'task.failed',
          payload: JSON.stringify({ message: 'Merge gate failed' }),
          createdAt: '2025-01-01T00:00:03.000Z',
        },
        {
          id: 2,
          eventType: 'task.log',
          payload: JSON.stringify({ level: 'info', message: 'Preparing review workspace', branch: 'stack/test' }),
          createdAt: '2025-01-01T00:00:02.000Z',
        },
        {
          id: 1,
          eventType: 'debug.auto-fix',
          payload: JSON.stringify({ message: 'debug detail', attempt: 1, value: 'secret' }),
          createdAt: '2025-01-01T00:00:01.000Z',
        },
      ]),
      getWorkerDecisions: vi.fn(async () => ({
        actions: [
          {
            id: 'wd-1',
            workerKind: 'autofix',
            actionType: 'fix-task',
            workflowId: 'wf-1',
            taskId: 'task-1',
            subjectType: 'task',
            subjectId: 'task-1',
            externalKey: 'wf-1/task-1:g0:a1',
            status: 'queued',
            attemptCount: 1,
            summary: 'Queued auto-fix with agent',
            decision: 'act',
            createdAt: '2025-01-01T00:00:04.000Z',
            updatedAt: '2025-01-01T00:00:04.000Z',
          },
          {
            id: 'wd-2',
            workerKind: 'autofix',
            actionType: 'fix-task',
            workflowId: 'wf-1',
            taskId: 'task-2',
            subjectType: 'task',
            subjectId: 'task-2',
            externalKey: 'wf-1/task-2:g0:a1',
            status: 'skipped',
            attemptCount: 1,
            summary: 'Skipped auto-fix',
            reason: 'retry-budget-disabled',
            decision: 'skip',
            createdAt: '2025-01-01T00:00:05.000Z',
            updatedAt: '2025-01-01T00:00:05.000Z',
          },
        ],
        limit: 25,
        offset: 0,
        hasMore: false,
      })),
    };

    try {
      render(
        <WorkflowInspector
          workflow={workflow}
          task={makeTask({ status: 'running' })}
          collapsed={false}
          advancedExpanded={false}
          onToggleCollapsed={() => {}}
          onToggleAdvanced={() => {}}
        />,
      );

      await waitFor(() => expect(screen.getByText('Preparing review workspace')).toBeInTheDocument());
      expect(screen.getByText('Merge gate failed')).toBeInTheDocument();
      await waitFor(() => expect(screen.getByText('Queued auto-fix with agent')).toBeInTheDocument());
      expect(screen.queryByText('Skipped auto-fix')).not.toBeInTheDocument();
      expect(screen.queryByText('debug detail')).not.toBeInTheDocument();

      fireEvent.change(screen.getByTestId('task-log-level-select'), { target: { value: 'debug' } });

      expect(screen.getByText('debug detail')).toBeInTheDocument();
      expect(screen.getByText('{"attempt":1}')).toBeInTheDocument();
      expect(screen.queryByText(/secret/)).not.toBeInTheDocument();
    } finally {
      delete (window as unknown as { invoker?: unknown }).invoker;
    }
  });

  it('shows a visible notice when fix recreated the workflow because workspace was missing', async () => {
    (window as unknown as {
      invoker: { getEvents: (taskId: string, options: { limit: number }) => Promise<Array<{ id: number; eventType: string; payload?: string; createdAt?: string }>> };
    }).invoker = {
      getEvents: vi.fn(async () => [
        {
          id: 1,
          eventType: 'task.workflow_recreated',
          payload: JSON.stringify({
            level: 'warn',
            workflowId: 'wf-1',
            reason: 'missing-workspace-startup-merge-conflict',
            message: 'Workspace was missing, so Invoker recreated workflow wf-1 from a fresh base instead of fixing this task in-place.',
          }),
          createdAt: '2025-01-01T00:00:04.000Z',
        },
      ]),
    };

    try {
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

      const notice = await screen.findByTestId('workspace-recreate-notice');
      expect(notice).toHaveTextContent('Workspace recreated');
      expect(notice).toHaveTextContent('Workspace was missing, so Invoker recreated workflow wf-1 from a fresh base instead of fixing this task in-place.');
      expect(notice).toHaveTextContent('Workflow: wf-1');
    } finally {
      delete (window as unknown as { invoker?: unknown }).invoker;
    }
  });

  it('shows a retrying log error when task events fail to load', async () => {
    (window as unknown as {
      invoker: { getEvents: (taskId: string, options: { limit: number }) => Promise<Array<{ id: number; eventType: string; payload?: string; createdAt?: string }>> };
    }).invoker = {
      getEvents: vi.fn(async () => {
        throw new Error('offline');
      }),
    };

    try {
      render(
        <WorkflowInspector
          workflow={workflow}
          task={makeTask({ status: 'running' })}
          collapsed={false}
          advancedExpanded={false}
          onToggleCollapsed={() => {}}
          onToggleAdvanced={() => {}}
        />,
      );

      await waitFor(() => expect(screen.getByTestId('task-log-error')).toHaveTextContent('Could not load logs. Retrying…'));
    } finally {
      delete (window as unknown as { invoker?: unknown }).invoker;
    }
  });

  it('renders a persistent mutation failure detail panel for the selected task', () => {
    const mutationFailure: WorkflowMutationFailedEvent = {
      intentId: 42,
      workflowId: 'wf-1',
      channel: 'invoker:approve',
      taskId: 'task-1',
      message: 'Error: SSH target "remote_digital_ocean_3" cannot run codex: missing execution harness "codex"',
      failedAt: '2026-07-08T10:00:00.000Z',
    };

    render(
      <WorkflowInspector
        workflow={workflow}
        task={makeTask({ status: 'awaiting_approval' })}
        mutationFailure={mutationFailure}
        collapsed={false}
        advancedExpanded={false}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    const detail = screen.getByTestId('task-mutation-failure-detail');
    expect(detail).toBeInTheDocument();
    expect(detail).toHaveTextContent('Approve failed');
    expect(detail).toHaveTextContent('missing execution harness "codex"');
    expect(detail).toHaveTextContent('Channel: invoker:approve');
  });

  it('renders headless command metadata in the mutation failure detail panel', () => {
    const mutationFailure: WorkflowMutationFailedEvent = {
      intentId: 46,
      workflowId: 'wf-1',
      channel: 'headless.exec',
      headlessCommand: 'fix',
      taskId: 'task-1',
      message: 'SSH remote script failed (exit=1, phase=remote_agent_fix)',
      failedAt: '2026-07-08T10:00:00.000Z',
    };

    render(
      <WorkflowInspector
        workflow={workflow}
        task={makeTask({ status: 'awaiting_approval' })}
        mutationFailure={mutationFailure}
        collapsed={false}
        advancedExpanded={false}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    const detail = screen.getByTestId('task-mutation-failure-detail');
    expect(detail).toHaveTextContent('Fix failed');
    expect(detail).toHaveTextContent('Command: fix');
  });

  it('does not render the mutation failure detail panel when no failure is provided', () => {
    render(
      <WorkflowInspector
        workflow={workflow}
        task={makeTask({ status: 'awaiting_approval' })}
        collapsed={false}
        advancedExpanded={false}
        onToggleCollapsed={() => {}}
        onToggleAdvanced={() => {}}
      />,
    );

    expect(screen.queryByTestId('task-mutation-failure-detail')).not.toBeInTheDocument();
  });
});
