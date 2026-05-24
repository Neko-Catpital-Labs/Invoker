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

  async function setup() {
    render(<App />);
    act(() => mock.setTasks([alpha, beta, merge], workflows));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-1')).toBeInTheDocument();
    });
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
    expect(screen.queryByText('Recreate Workflow')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('More'));
    expect(await screen.findByText('Rebase and Retry')).toBeInTheDocument();
    expect(screen.getByText('Rebase and Recreate')).toBeInTheDocument();
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
  });

  it('workflow context menu retries workflow', async () => {
    await setup();
    fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
    fireEvent.click(await screen.findByText('Retry Workflow'));
    await waitFor(() => expect(mock.api.retryWorkflow).toHaveBeenCalledWith('wf-1'));
  });

  it('workflow context menu recreates workflow', async () => {
    await setup();
    fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
    fireEvent.click(await screen.findByText('More'));
    fireEvent.click(await screen.findByText('Recreate Workflow'));
    await waitFor(() => expect(mock.api.recreateWorkflow).toHaveBeenCalledWith('wf-1'));
  });

  it('workflow context menu retries workflow with rebase', async () => {
    await setup();
    fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
    fireEvent.click(await screen.findByText('More'));
    fireEvent.click(await screen.findByText('Rebase and Retry'));
    await waitFor(() => expect(mock.api.rebaseRetry).toHaveBeenCalledWith('wf-1'));
  });

  it('workflow context menu recreates workflow with rebase', async () => {
    await setup();
    fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
    fireEvent.click(await screen.findByText('More'));
    fireEvent.click(await screen.findByText('Rebase and Recreate'));
    await waitFor(() => expect(mock.api.rebaseRecreate).toHaveBeenCalledWith('wf-1'));
  });

  it('workflow context menu cancels workflow', async () => {
    await setup();
    fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
    fireEvent.click(await screen.findByText('More'));
    fireEvent.click(await screen.findByText('Cancel Workflow'));
    await waitFor(() => expect(mock.api.cancelWorkflow).toHaveBeenCalledWith('wf-1'));
  });

  it('workflow context menu deletes workflow', async () => {
    await setup();
    fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
    fireEvent.click(await screen.findByText('More'));
    fireEvent.click(await screen.findByText('Delete Workflow'));
    await waitFor(() => expect(mock.api.deleteWorkflow).toHaveBeenCalledWith('wf-1'));
  });

  it('workflow context menu copies workflow id', async () => {
    await setup();
    fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
    fireEvent.click(await screen.findByText('Copy Workflow ID'));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('wf-1'));
  });

  // ── Keyboard navigation regressions ──────────────────────────
  //
  // The open menu must respond to ArrowDown/ArrowUp/Enter/Space dispatched at
  // the active/document keyboard target. The local repro proved that opening
  // the workflow menu, pressing ArrowDown three times, and pressing Enter did
  // not invoke `navigator.clipboard.writeText('wf-1')` — keys were swallowed by
  // the App's global graph-navigation handler instead of moving focus inside
  // the menu. These tests fold that repro into durable coverage for both the
  // workflow context menu and the task context menu in the mini DAG.
  //
  // Item layout assumed by the keyboard spec:
  //   Workflow menu (showMore=false): Open Workflow, Open PR, Retry Workflow,
  //     Copy Workflow ID. The "More" button toggles the danger section and is
  //     not part of the cyclic navigation, matching ContextMenu.tsx where the
  //     More affordance lives outside `renderedItems`.
  //   Task menu (pending task alpha): Restart Task, Open Terminal.

  async function openWorkflowContextMenu(workflowId: string) {
    fireEvent.contextMenu(screen.getByTestId(`workflow-node-${workflowId}`));
    await screen.findByRole('menu');
  }

  async function openTaskContextMenu(taskId: string) {
    fireEvent.click(screen.getByTestId('workflow-node-wf-1'));
    await waitFor(() => {
      expect(screen.getByTestId(`rf__node-${taskId}`)).toBeInTheDocument();
    });
    fireEvent.contextMenu(screen.getByTestId(`rf__node-${taskId}`));
    await screen.findByRole('menu');
  }

  it('open workflow menu: ArrowDown x 3 then Enter copies the workflow id', async () => {
    await setup();
    await openWorkflowContextMenu('wf-1');

    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'Enter' });

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('wf-1'));
  });

  it('open workflow menu: ArrowUp wraps to the last enabled item', async () => {
    await setup();
    await openWorkflowContextMenu('wf-1');

    // From the initial first-item focus, a single ArrowUp must wrap to the
    // last enabled navigable item (Copy Workflow ID). Enter on that wrapped
    // position triggers the copy action — same observable effect as a forward
    // walk, but reached via the wrap branch.
    fireEvent.keyDown(document, { key: 'ArrowUp' });
    fireEvent.keyDown(document, { key: 'Enter' });

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('wf-1'));
  });

  it('open workflow menu: ArrowUp x 2 lands on Retry Workflow after wrap', async () => {
    await setup();
    await openWorkflowContextMenu('wf-1');

    // ArrowUp once wraps from index 0 to the last enabled item (index 3).
    // A second ArrowUp must move to index 2 (Retry Workflow). This pins down
    // the wrap point and proves ArrowUp continues to step backwards from the
    // wrapped position rather than re-wrapping or sticking.
    fireEvent.keyDown(document, { key: 'ArrowUp' });
    fireEvent.keyDown(document, { key: 'ArrowUp' });
    fireEvent.keyDown(document, { key: 'Enter' });

    await waitFor(() => expect(mock.api.retryWorkflow).toHaveBeenCalledWith('wf-1'));
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('open workflow menu: Space activates the highlighted item like Enter', async () => {
    await setup();
    await openWorkflowContextMenu('wf-1');

    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: ' ' });

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('wf-1'));
  });

  it('open task menu in mini DAG: ArrowDown then Enter activates the next enabled task action', async () => {
    await setup();
    await openTaskContextMenu('task-alpha');

    // Pending task layout: [Restart Task, Open Terminal]. Initial focus is on
    // Restart Task; ArrowDown moves to Open Terminal; Enter activates it and
    // routes through window.invoker.openTerminal.
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'Enter' });

    await waitFor(() => expect(mock.api.openTerminal).toHaveBeenCalledWith('task-alpha'));
    expect(mock.api.restartTask).not.toHaveBeenCalled();
  });

  it('open task menu in mini DAG: Space activates the highlighted item like Enter', async () => {
    await setup();
    await openTaskContextMenu('task-alpha');

    // Without any ArrowDown, focus is on the first enabled item (Restart Task).
    // Space must behave like Enter and activate it.
    fireEvent.keyDown(document, { key: ' ' });

    await waitFor(() => expect(mock.api.restartTask).toHaveBeenCalledWith('task-alpha'));
    expect(mock.api.openTerminal).not.toHaveBeenCalled();
  });
});
