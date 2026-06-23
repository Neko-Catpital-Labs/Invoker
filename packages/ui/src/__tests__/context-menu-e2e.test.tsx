/**
 * Component test: Context menu on task nodes.
 *
 * Demoted from packages/app/e2e/context-menu.spec.ts.
 * Tests right-click, Escape close, click-outside close, and menu items.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

const alpha = makeUITask({
  id: 'task-alpha',
  description: 'First test task',
  status: 'pending',
  command: 'echo hello-alpha',
  workflowId: 'wf-1',
});

const beta = makeUITask({
  id: 'task-beta',
  description: 'Second test task',
  status: 'pending',
  dependencies: ['task-alpha'],
  command: 'echo hello-beta',
  workflowId: 'wf-1',
});

const merge = makeUITask({
  id: '__merge__wf-1',
  description: 'Review gate',
  status: 'review_ready',
  workflowId: 'wf-1',
  isMergeNode: true,
});

const workflows: WorkflowMeta[] = [
  { id: 'wf-1', name: 'Test Workflow', status: 'running', baseBranch: 'master' },
];

describe('Context menu (component)', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mock.cleanup();
  });

  async function setup(
    tasks = [alpha, beta, merge],
    workflowList = workflows,
  ) {
    render(<App />);
    act(() => mock.setTasks(tasks, workflowList));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-1')).toBeInTheDocument();
    });
  }

  async function openWorkflowContextMenu() {
    fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
    const menu = await screen.findByRole('menu');
    await waitFor(() => expect(menu).toHaveFocus());
    return menu;
  }

  async function openTaskContextMenu(taskId = 'task-alpha') {
    fireEvent.click(screen.getByTestId('workflow-node-wf-1'));
    await waitFor(() => {
      expect(screen.getByTestId(`rf__node-${taskId}`)).toBeInTheDocument();
    });
    fireEvent.contextMenu(screen.getByTestId(`rf__node-${taskId}`));
    const menu = await screen.findByRole('menu');
    await waitFor(() => expect(menu).toHaveFocus());
    return menu;
  }

  function pressMenuKey(key: string) {
    const target =
      document.activeElement instanceof HTMLElement && document.activeElement.getAttribute('role') === 'menu'
        ? document.activeElement
        : document;
    fireEvent.keyDown(target, { key });
  }

  async function expectHighlightedMenuItem(name: RegExp | string) {
    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name })).toHaveClass('bg-gray-700');
    });
  }

  function expectOnlyWorkflowApiCalled(
    called:
      | 'retryWorkflow'
      | 'recreateWorkflow'
      | 'rebaseRetry'
      | 'rebaseRecreate'
      | 'cancelWorkflow',
  ) {
    const actions = {
      retryWorkflow: mock.api.retryWorkflow,
      recreateWorkflow: mock.api.recreateWorkflow,
      rebaseRetry: mock.api.rebaseRetry,
      rebaseRecreate: mock.api.rebaseRecreate,
      cancelWorkflow: mock.api.cancelWorkflow,
    };
    for (const [name, action] of Object.entries(actions)) {
      if (name === called) {
        expect(action).toHaveBeenCalledWith('wf-1');
      } else {
        expect(action).not.toHaveBeenCalled();
      }
    }
  }

  it('right-clicking a workflow shows workflow actions', async () => {
    await setup();
    fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));

    await waitFor(() => {
      expect(screen.getByText('Open Workflow')).toBeInTheDocument();
      expect(screen.getByText('Retry Workflow')).toBeInTheDocument();
      expect(screen.getByText('Copy Workflow ID')).toBeInTheDocument();
      expect(screen.getByText('More')).toBeInTheDocument();
    });
    expect(screen.queryByText('Recreate Downstream')).not.toBeInTheDocument();
    expect(screen.queryByText('Recreate Workflow')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('More'));
    expect(await screen.findByText('Rebase and Retry')).toBeInTheDocument();
    expect(screen.getByText('Rebase and Recreate')).toBeInTheDocument();
    expect(screen.queryByText('Recreate Downstream')).not.toBeInTheDocument();
  });

  it('task context menu still works in mini DAG', async () => {
    await setup();
    fireEvent.click(screen.getByTestId('workflow-node-wf-1'));
    await waitFor(() => {
      expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
    });
    fireEvent.contextMenu(screen.getByTestId('rf__node-task-alpha'));
    await waitFor(() => {
      expect(screen.getByText('Open Terminal')).toBeInTheDocument();
      expect(screen.getByText('Restart Task')).toBeInTheDocument();
    });
    expect(screen.queryByText('Retry Workflow')).not.toBeInTheDocument();
    expect(screen.queryByText('Cancel Workflow')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete Workflow')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('More'));
    expect(await screen.findByText('Recreate from Task')).toBeInTheDocument();
    expect(screen.getByText('Recreate Downstream')).toBeInTheDocument();
    expect(screen.getByText('Terminate Task')).toBeInTheDocument();
  });

  it('task context menu calls recreateDownstream for workflow-owned tasks', async () => {
    await setup();
    fireEvent.click(screen.getByTestId('workflow-node-wf-1'));
    await waitFor(() => {
      expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
    });

    fireEvent.contextMenu(screen.getByTestId('rf__node-task-alpha'));
    fireEvent.click(await screen.findByText('More'));
    fireEvent.click(await screen.findByText('Recreate Downstream'));

    await waitFor(() => expect(mock.api.recreateDownstream).toHaveBeenCalledWith('task-alpha'));
    expect(mock.api.recreateTask).not.toHaveBeenCalled();
    expect(mock.api.recreateWorkflow).not.toHaveBeenCalled();
  });

  it('task context menu disables Recreate Downstream while the task is running', async () => {
    const runningTask = makeUITask({
      id: 'task-running',
      description: 'Running workflow task',
      status: 'running',
      command: 'sleep 30',
      workflowId: 'wf-1',
    });

    await setup([runningTask]);
    fireEvent.click(screen.getByTestId('workflow-node-wf-1'));
    await waitFor(() => {
      expect(screen.getByTestId('rf__node-task-running')).toBeInTheDocument();
    });

    fireEvent.contextMenu(screen.getByTestId('rf__node-task-running'));
    fireEvent.click(await screen.findByText('More'));
    const recreateDownstream = await screen.findByRole('menuitem', { name: 'Recreate Downstream' });

    expect(recreateDownstream).toBeDisabled();
    fireEvent.click(recreateDownstream);
    expect(mock.api.recreateDownstream).not.toHaveBeenCalled();
  });

  it('task context menu keeps Recreate from Task routed to recreateTask', async () => {
    await setup();
    fireEvent.click(screen.getByTestId('workflow-node-wf-1'));
    await waitFor(() => {
      expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
    });

    fireEvent.contextMenu(screen.getByTestId('rf__node-task-alpha'));
    fireEvent.click(await screen.findByText('More'));
    fireEvent.click(await screen.findByText('Recreate from Task'));

    await waitFor(() => expect(mock.api.recreateTask).toHaveBeenCalledWith('task-alpha'));
    expect(mock.api.recreateDownstream).not.toHaveBeenCalled();
    expect(mock.api.recreateWorkflow).not.toHaveBeenCalled();
  });

  it('workflow context menu retries workflow', async () => {
    await setup();
    fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
    fireEvent.click(await screen.findByText('Retry Workflow'));
    await waitFor(() => expect(mock.api.retryWorkflow).toHaveBeenCalledWith('wf-1'));
    expectOnlyWorkflowApiCalled('retryWorkflow');
  });

  it('workflow context menu recreates workflow', async () => {
    await setup();
    fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
    fireEvent.click(await screen.findByText('More'));
    fireEvent.click(await screen.findByText('Recreate Workflow'));
    await waitFor(() => expect(mock.api.recreateWorkflow).toHaveBeenCalledWith('wf-1'));
    expectOnlyWorkflowApiCalled('recreateWorkflow');
  });

  it('workflow context menu retries workflow with rebase', async () => {
    await setup();
    fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
    fireEvent.click(await screen.findByText('More'));
    fireEvent.click(await screen.findByText('Rebase and Retry'));
    await waitFor(() => expect(mock.api.rebaseRetry).toHaveBeenCalledWith('wf-1'));
    expectOnlyWorkflowApiCalled('rebaseRetry');
  });

  it('workflow context menu recreates workflow with rebase', async () => {
    await setup();
    fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
    fireEvent.click(await screen.findByText('More'));
    fireEvent.click(await screen.findByText('Rebase and Recreate'));
    await waitFor(() => expect(mock.api.rebaseRecreate).toHaveBeenCalledWith('wf-1'));
    expectOnlyWorkflowApiCalled('rebaseRecreate');
  });

  it('workflow context menu cancels workflow', async () => {
    await setup();
    fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
    fireEvent.click(await screen.findByText('More'));
    fireEvent.click(await screen.findByText('Cancel Workflow'));
    await waitFor(() => expect(mock.api.cancelWorkflow).toHaveBeenCalledWith('wf-1'));
    expectOnlyWorkflowApiCalled('cancelWorkflow');
  });

  it('workflow context menu deletes workflow', async () => {
    await setup();
    fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
    fireEvent.click(await screen.findByText('More'));
    fireEvent.click(await screen.findByText('Delete Workflow'));
    await waitFor(() => expect(mock.api.deleteWorkflow).toHaveBeenCalledWith('wf-1'));
  });

  describe('workflow detach', () => {
    const upTask = makeUITask({
      id: 'task-up',
      description: 'Upstream task',
      status: 'completed',
      command: 'echo up',
      workflowId: 'wf-up',
    });
    const downTask = makeUITask({
      id: 'task-down',
      description: 'Downstream task',
      status: 'pending',
      command: 'echo down',
      workflowId: 'wf-down',
    });
    const stackWorkflows: WorkflowMeta[] = [
      { id: 'wf-up', name: 'Upstream Workflow', status: 'running', baseBranch: 'master' },
      {
        id: 'wf-down',
        name: 'Downstream Workflow',
        status: 'running',
        baseBranch: 'master',
        externalDependencies: [{ workflowId: 'wf-up', requiredStatus: 'completed' }],
      },
    ];

    async function setupStack() {
      render(<App />);
      act(() => mock.setTasks([upTask, downTask], stackWorkflows));
      await waitFor(() => {
        expect(screen.getByTestId('workflow-node-wf-down')).toBeInTheDocument();
      });
    }

    it('offers detach for a workflow with a single upstream dependency', async () => {
      await setupStack();

      fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-down'));
      fireEvent.click(await screen.findByText('More'));
      expect(await screen.findByText('Detach Upstream Workflow')).toBeInTheDocument();
    });

    it('hides detach for a workflow with no upstream dependency', async () => {
      await setupStack();

      fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-up'));
      fireEvent.click(await screen.findByText('More'));
      expect(screen.queryByText('Detach Upstream Workflow')).not.toBeInTheDocument();
    });

    it('confirms naming both workflows, then detaches once and shows feedback', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      await setupStack();

      fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-down'));
      fireEvent.click(await screen.findByText('More'));
      fireEvent.click(await screen.findByText('Detach Upstream Workflow'));

      await waitFor(() =>
        expect(mock.api.detachWorkflow).toHaveBeenCalledWith('wf-down', 'wf-up'),
      );
      expect(mock.api.detachWorkflow).toHaveBeenCalledTimes(1);

      const confirmMessage = confirmSpy.mock.calls.at(-1)?.[0] as string;
      expect(confirmMessage).toContain('Downstream Workflow');
      expect(confirmMessage).toContain('Upstream Workflow');

      const feedback = await screen.findByTestId('detach-feedback');
      expect(feedback).toHaveTextContent('Downstream Workflow');
      expect(feedback).toHaveTextContent('Upstream Workflow');
    });

    it('does not detach when the confirmation is cancelled', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      await setupStack();

      fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-down'));
      fireEvent.click(await screen.findByText('More'));
      fireEvent.click(await screen.findByText('Detach Upstream Workflow'));

      await waitFor(() => expect(window.confirm).toHaveBeenCalled());
      expect(mock.api.detachWorkflow).not.toHaveBeenCalled();
      expect(screen.queryByTestId('detach-feedback')).not.toBeInTheDocument();
    });
  });

  it('workflow context menu copies workflow id', async () => {
    await setup();
    fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
    fireEvent.click(await screen.findByText('Copy Workflow ID'));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('wf-1'));
  });

  it('workflow context menu copies workflow id with ArrowDown navigation and Enter', async () => {
    await setup();
    await openWorkflowContextMenu();

    pressMenuKey('ArrowDown');
    pressMenuKey('ArrowDown');
    pressMenuKey('ArrowDown');
    await expectHighlightedMenuItem('Copy Workflow ID');
    pressMenuKey('Enter');

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('wf-1'));
  });

  it('workflow context menu ArrowUp wraps to More deterministically', async () => {
    await setup();
    await openWorkflowContextMenu();

    pressMenuKey('ArrowUp');
    await expectHighlightedMenuItem('More');
    pressMenuKey('Enter');

    expect(await screen.findByRole('menuitem', { name: 'Rebase and Retry' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete Workflow' })).toBeInTheDocument();
  });

  it('task context menu activates the next enabled task action with ArrowDown and Enter', async () => {
    await setup();
    await openTaskContextMenu();

    await expectHighlightedMenuItem('Restart Task');
    pressMenuKey('ArrowDown');
    await expectHighlightedMenuItem('Open Terminal');
    pressMenuKey('Enter');

    await waitFor(() => expect(mock.api.openTerminal).toHaveBeenCalledWith('task-alpha'));
  });

  it('task context menu activates the highlighted item with Space', async () => {
    await setup();
    await openTaskContextMenu();

    pressMenuKey('ArrowDown');
    await expectHighlightedMenuItem('Open Terminal');
    pressMenuKey(' ');

    await waitFor(() => expect(mock.api.openTerminal).toHaveBeenCalledWith('task-alpha'));
  });

  it('task context menu skips disabled actions during keyboard navigation', async () => {
    const failedPivot = makeUITask({
      id: 'task-disabled-terminal',
      description: 'Failed pivot task',
      status: 'failed',
      workflowId: 'wf-1',
      config: {
        workflowId: 'wf-1',
        pivot: true,
        experimentVariants: [{ id: 'exp-a', description: 'Experiment A' }],
      },
    });
    await setup([failedPivot]);
    await openTaskContextMenu('task-disabled-terminal');

    await expectHighlightedMenuItem('Fix with Claude');
    pressMenuKey('ArrowDown');
    await expectHighlightedMenuItem('Fix with Codex');
    pressMenuKey('ArrowDown');
    await expectHighlightedMenuItem('Restart Task');
    pressMenuKey('Enter');

    await waitFor(() => expect(mock.api.restartTask).toHaveBeenCalledWith('task-disabled-terminal'));
    expect(mock.api.openTerminal).not.toHaveBeenCalled();
  });
});
