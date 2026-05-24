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

  // ── Keyboard navigation regression ──
  //
  // These tests prove that an OPEN context menu honors keyboard navigation and
  // activation. A repro confirmed that with the pre-fix implementation,
  // pressing ArrowDown three times and then Enter after right-clicking
  // workflow-node-wf-1 does NOT call navigator.clipboard.writeText('wf-1').
  // The expectations below describe the correct end-state behavior and must
  // fail on the pre-fix implementation. Keyboard events are dispatched at the
  // document/active keyboard target, matching how a real keypress is delivered
  // to the page when no specific element is focused.

  it('workflow context menu: ArrowDown×3 then Enter activates Copy Workflow ID', async () => {
    await setup();
    fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
    await waitFor(() => expect(screen.getByText('Copy Workflow ID')).toBeInTheDocument());

    // Items visible (in DOM order):
    //   0 Open Workflow  1 Open PR  2 Retry Workflow  3 Copy Workflow ID  4 More
    // Initial focus is the first item; ArrowDown three times must land on
    // "Copy Workflow ID"; Enter must activate it.
    fireEvent.keyDown(document.activeElement ?? document, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement ?? document, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement ?? document, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement ?? document, { key: 'Enter' });

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('wf-1'));
  });

  it('workflow context menu: Space activates the highlighted item like Enter', async () => {
    await setup();
    fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
    await waitFor(() => expect(screen.getByText('Copy Workflow ID')).toBeInTheDocument());

    // Same navigation as the Enter test, then Space ( ' ' ) must also activate.
    fireEvent.keyDown(document.activeElement ?? document, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement ?? document, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement ?? document, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement ?? document, { key: ' ' });

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('wf-1'));
  });

  it('workflow context menu: ArrowUp from the first item wraps to the last navigable item', async () => {
    await setup();
    fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
    await waitFor(() => expect(screen.getByText('Copy Workflow ID')).toBeInTheDocument());

    // "Cancel Workflow" is hidden until the trailing "More" item expands the
    // danger group. Deterministic ArrowUp wrap places focus on that trailing
    // "More" item; Enter then expands it and reveals Cancel Workflow.
    expect(screen.queryByText('Cancel Workflow')).not.toBeInTheDocument();

    fireEvent.keyDown(document.activeElement ?? document, { key: 'ArrowUp' });
    fireEvent.keyDown(document.activeElement ?? document, { key: 'Enter' });

    await waitFor(() => expect(screen.getByText('Cancel Workflow')).toBeInTheDocument());
  });

  it('task context menu in mini DAG: ArrowDown then Enter activates the next enabled action', async () => {
    await setup();
    fireEvent.click(screen.getByTestId('workflow-node-wf-1'));
    await waitFor(() => expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument());
    fireEvent.contextMenu(screen.getByTestId('rf__node-task-alpha'));
    await waitFor(() => {
      expect(screen.getByText('Restart Task')).toBeInTheDocument();
      expect(screen.getByText('Open Terminal')).toBeInTheDocument();
    });

    // Pending task menu items (visible group, in order):
    //   0 Restart Task (initially focused)   1 Open Terminal
    // ArrowDown moves focus to "Open Terminal"; Enter activates it and the
    // App routes the action through window.invoker.openTerminal('task-alpha').
    fireEvent.keyDown(document.activeElement ?? document, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement ?? document, { key: 'Enter' });

    await waitFor(() => expect(mock.api.openTerminal).toHaveBeenCalledWith('task-alpha'));
  });
});
