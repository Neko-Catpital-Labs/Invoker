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

  // ── Keyboard activation regressions ────────────────────────────
  //
  // These tests fire keyboard events at `document.activeElement`, which is
  // what a real user keystroke targets. They prove that the open context
  // menu must own its own focus/keydown handling: if focus stays on
  // <body>, the keydown never reaches the menu's React handler and the
  // highlighted action is never invoked.
  //
  // Pre-fix behaviour the tests pin:
  //   - WorkflowContextMenu has no keyboard handler at all.
  //   - ContextMenu has a handler bound to its menu div, but the menu is
  //     never focused, so document keystrokes never reach it.

  function pressKeyOnActiveTarget(key: string) {
    const target = (document.activeElement as HTMLElement | null) ?? document.body;
    fireEvent.keyDown(target, { key, bubbles: true });
  }

  async function openWorkflowMenu() {
    await setup();
    fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
    await screen.findByRole('menu');
  }

  async function openTaskMenu() {
    await setup();
    fireEvent.click(screen.getByTestId('workflow-node-wf-1'));
    await waitFor(() => {
      expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
    });
    fireEvent.contextMenu(screen.getByTestId('rf__node-task-alpha'));
    await screen.findByRole('menu');
  }

  it('workflow menu: ArrowDown x3 + Enter copies the workflow id', async () => {
    await openWorkflowMenu();

    // From the initial focused item (Open Workflow), ArrowDown three times
    // should land on "Copy Workflow ID"; Enter should invoke it.
    pressKeyOnActiveTarget('ArrowDown');
    pressKeyOnActiveTarget('ArrowDown');
    pressKeyOnActiveTarget('ArrowDown');
    pressKeyOnActiveTarget('Enter');

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('wf-1');
    });
  });

  it('workflow menu: ArrowUp from first item wraps deterministically to the last item', async () => {
    await openWorkflowMenu();

    // Before any navigation, the danger group must still be collapsed —
    // any premature reveal would mean we did not wrap from the first
    // enabled item.
    expect(screen.queryByText('Delete Workflow')).not.toBeInTheDocument();

    // ArrowUp from the first focused item must wrap to the last enabled
    // navigable entry. In the closed-state menu that is the "More"
    // affordance; activating it expands the danger group, which we can
    // observe via the presence of "Delete Workflow".
    pressKeyOnActiveTarget('ArrowUp');
    pressKeyOnActiveTarget('Enter');

    await waitFor(() => {
      expect(screen.getByText('Delete Workflow')).toBeInTheDocument();
    });
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(mock.api.retryWorkflow).not.toHaveBeenCalled();
  });

  it('task menu: ArrowDown + Enter activates the next enabled action', async () => {
    await openTaskMenu();

    // task-alpha is pending → safe items render as:
    //   [0] Restart Task   (initial focus)
    //   [1] Open Terminal  (next enabled action)
    // ArrowDown moves to "Open Terminal"; Enter invokes onOpenTerminal,
    // which the App wires to invoker.openTerminal.
    pressKeyOnActiveTarget('ArrowDown');
    pressKeyOnActiveTarget('Enter');

    await waitFor(() => {
      expect(mock.api.openTerminal).toHaveBeenCalledWith('task-alpha');
    });
    expect(mock.api.restartTask).not.toHaveBeenCalled();
  });

  it('task menu: Space activates the highlighted item just like Enter', async () => {
    await openTaskMenu();

    pressKeyOnActiveTarget('ArrowDown');
    pressKeyOnActiveTarget(' ');

    await waitFor(() => {
      expect(mock.api.openTerminal).toHaveBeenCalledWith('task-alpha');
    });
    expect(mock.api.restartTask).not.toHaveBeenCalled();
  });
});
