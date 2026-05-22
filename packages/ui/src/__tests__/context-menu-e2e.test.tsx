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

  // Keyboard navigation regression tests.
  //
  // A local repro (right-click workflow → ArrowDown × 3 → Enter) proved
  // that dispatching keyboard events on the document does not reach the
  // open context menu's item selection. The menu's React onKeyDown is
  // never triggered because document is above the React root, so events
  // fired there never reach React's delegated listener.
  //
  // These tests fire keys on `document` to match the user-facing flow and
  // assert the side effect that activation produces (clipboard write or
  // mock API call). They must fail until keyboard handling moves to a
  // document-level listener that wins against App's global arrow/Enter
  // handlers when a context menu is open.
  describe('keyboard navigation', () => {
    it('workflow menu: ArrowDown × 3 + Enter copies workflow id', async () => {
      await setup();
      fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
      await screen.findByText('Copy Workflow ID');

      // Items in initial state: Open Workflow (0), Open PR (1),
      // Retry Workflow (2), Copy Workflow ID (3), More (4). Initial focus
      // is on the first item, so ArrowDown × 3 lands on Copy Workflow ID.
      fireEvent.keyDown(document, { key: 'ArrowDown' });
      fireEvent.keyDown(document, { key: 'ArrowDown' });
      fireEvent.keyDown(document, { key: 'ArrowDown' });
      fireEvent.keyDown(document, { key: 'Enter' });

      await waitFor(() => {
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith('wf-1');
      });
    });

    it('workflow menu: ArrowUp from first item wraps to the last menu item', async () => {
      await setup();
      fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
      await screen.findByText('More');

      // Pre-condition: danger-section items are hidden until More is
      // activated. Wrapping with ArrowUp from idx 0 must land on the
      // last navigable menuitem (More); activating it expands the menu.
      expect(screen.queryByText('Recreate Workflow')).not.toBeInTheDocument();

      fireEvent.keyDown(document, { key: 'ArrowUp' });
      fireEvent.keyDown(document, { key: 'Enter' });

      await waitFor(() => {
        expect(screen.getByText('Recreate Workflow')).toBeInTheDocument();
      });
      // Wrapping must not have activated Open Workflow (idx 0): clipboard
      // and workflow APIs must not have been called.
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
      expect(mock.api.retryWorkflow).not.toHaveBeenCalled();
    });

    it('task menu: ArrowDown + Enter activates the next enabled action', async () => {
      await setup();
      fireEvent.click(screen.getByTestId('workflow-node-wf-1'));
      await waitFor(() => {
        expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
      });
      fireEvent.contextMenu(screen.getByTestId('rf__node-task-alpha'));
      await screen.findByText('Restart Task');

      // task-alpha is pending: navigable items are Restart Task (0) and
      // Open Terminal (1). Initial focus is on idx 0, so ArrowDown lands
      // on Open Terminal.
      fireEvent.keyDown(document, { key: 'ArrowDown' });
      fireEvent.keyDown(document, { key: 'Enter' });

      await waitFor(() => {
        expect(mock.api.openTerminal).toHaveBeenCalledWith('task-alpha');
      });
      expect(mock.api.restartTask).not.toHaveBeenCalled();
    });

    it('task menu: Space activates the highlighted item like Enter', async () => {
      await setup();
      fireEvent.click(screen.getByTestId('workflow-node-wf-1'));
      await waitFor(() => {
        expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
      });
      fireEvent.contextMenu(screen.getByTestId('rf__node-task-alpha'));
      await screen.findByText('Restart Task');

      // Initial focus is on Restart Task (idx 0). Space should activate
      // it the same as Enter would.
      fireEvent.keyDown(document, { key: ' ' });

      await waitFor(() => {
        expect(mock.api.restartTask).toHaveBeenCalledWith('task-alpha');
      });
      expect(mock.api.openTerminal).not.toHaveBeenCalled();
    });
  });
});
