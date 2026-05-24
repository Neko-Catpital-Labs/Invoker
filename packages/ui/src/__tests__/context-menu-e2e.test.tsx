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

  // ── Keyboard navigation regression coverage ──────────────────────────────
  //
  // The open context menu must own ArrowUp/ArrowDown/Enter/Space while it is
  // visible. The pre-fix workflow menu has no keyboard handler at all, and the
  // task menu's handler is attached to an unfocused element, so document-level
  // key events never reach an item activation. These tests dispatch real
  // keyboard events at the active keyboard target after opening each menu so
  // they regress if focus delivery, roving index, or item activation breaks.

  function activeKeyboardTarget(): Element {
    const active = document.activeElement;
    return active && active !== document.body ? active : document.body;
  }

  it('workflow context menu: ArrowDown x3 + Enter copies workflow id via keyboard', async () => {
    await setup();
    fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
    await screen.findByRole('menu');

    // From the initial highlighted item ("Open Workflow"), three ArrowDowns
    // must land on "Copy Workflow ID" and Enter must execute that item.
    const target = activeKeyboardTarget();
    fireEvent.keyDown(target, { key: 'ArrowDown' });
    fireEvent.keyDown(target, { key: 'ArrowDown' });
    fireEvent.keyDown(target, { key: 'ArrowDown' });
    fireEvent.keyDown(target, { key: 'Enter' });

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('wf-1'));
  });

  it('workflow context menu: ArrowUp wraps deterministically to the last enabled item', async () => {
    await setup();
    fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
    await screen.findByRole('menu');

    // Danger items (e.g. "Cancel Workflow") are hidden until the "More" item
    // is activated. The initial highlight is on the first enabled item, so
    // ArrowUp must wrap to the last enabled item ("More"); pressing Enter then
    // must expand the danger group, revealing "Cancel Workflow".
    expect(screen.queryByText('Cancel Workflow')).not.toBeInTheDocument();
    const target = activeKeyboardTarget();
    fireEvent.keyDown(target, { key: 'ArrowUp' });
    fireEvent.keyDown(target, { key: 'Enter' });

    await waitFor(() => expect(screen.getByText('Cancel Workflow')).toBeInTheDocument());
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(mock.api.retryWorkflow).not.toHaveBeenCalled();
  });

  it('task context menu in mini DAG: ArrowDown + Enter activates the next enabled task action', async () => {
    await setup();
    fireEvent.click(screen.getByTestId('workflow-node-wf-1'));
    await waitFor(() => {
      expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
    });
    fireEvent.contextMenu(screen.getByTestId('rf__node-task-alpha'));
    await screen.findByText('Restart Task');

    // Initial highlight is on "Restart Task". ArrowDown must move to the next
    // enabled task action ("Open Terminal" for a pending task) and Enter must
    // execute that action via the mocked invoker API.
    const target = activeKeyboardTarget();
    fireEvent.keyDown(target, { key: 'ArrowDown' });
    fireEvent.keyDown(target, { key: 'Enter' });

    await waitFor(() => expect(mock.api.openTerminal).toHaveBeenCalledWith('task-alpha'));
    expect(mock.api.restartTask).not.toHaveBeenCalled();
  });

  it('task context menu: Space activates the highlighted item like Enter', async () => {
    await setup();
    fireEvent.click(screen.getByTestId('workflow-node-wf-1'));
    await waitFor(() => {
      expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
    });
    fireEvent.contextMenu(screen.getByTestId('rf__node-task-alpha'));
    await screen.findByText('Restart Task');

    // Initial highlight is on the first enabled action ("Restart Task" for a
    // pending task). Space must activate that highlighted item exactly like
    // Enter does, calling the mocked invoker API.
    const target = activeKeyboardTarget();
    fireEvent.keyDown(target, { key: ' ' });

    await waitFor(() => expect(mock.api.restartTask).toHaveBeenCalledWith('task-alpha'));
    expect(mock.api.openTerminal).not.toHaveBeenCalled();
  });
});
