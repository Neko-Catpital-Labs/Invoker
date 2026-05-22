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

  // ── Keyboard navigation regression ────────────────────────────
  //
  // Regression coverage for the open-menu keyboard path.
  //
  // A local repro proved that opening a workflow context menu, pressing
  // ArrowDown three times, and pressing Enter did NOT call
  // navigator.clipboard.writeText('wf-1'): the open menu silently dropped
  // arrow / activation keys dispatched from the document, so users could
  // not drive the menu from the keyboard once it was open.
  //
  // These tests mount the real App and dispatch keyboard events on the
  // document (where real browser keystrokes land when the menu has no
  // focused interactive child), and assert the menu both moves its
  // highlight and invokes the matching handler on activation.
  describe('open-menu keyboard navigation', () => {
    function dispatchKey(key: string) {
      const target = document.activeElement ?? document.body;
      fireEvent.keyDown(target, { key, bubbles: true });
    }

    it('workflow menu: ArrowDown x3 + Enter copies the workflow id', async () => {
      await setup();
      fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
      await screen.findByRole('menu');

      // Items in declaration order:
      //   0: Open Workflow  (initial focus)
      //   1: Open PR
      //   2: Retry Workflow
      //   3: Copy Workflow ID  <-- target
      dispatchKey('ArrowDown');
      dispatchKey('ArrowDown');
      dispatchKey('ArrowDown');
      dispatchKey('Enter');

      await waitFor(() => {
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith('wf-1');
      });
    });

    it('workflow menu: Space activates the highlighted item like Enter', async () => {
      await setup();
      fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
      await screen.findByRole('menu');

      dispatchKey('ArrowDown');
      dispatchKey('ArrowDown');
      dispatchKey('ArrowDown');
      dispatchKey(' ');

      await waitFor(() => {
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith('wf-1');
      });
    });

    it('workflow menu: ArrowUp from the first item wraps to the last menu item', async () => {
      await setup();
      fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
      await screen.findByRole('menu');

      // With proper wrap semantics, ArrowUp at the first item lands on the
      // last visible menuitem — the "More" disclosure button — and Enter
      // expands it, revealing the danger actions. Without wrap (the
      // pre-fix behavior) ArrowUp is a no-op so Enter never reaches More.
      dispatchKey('ArrowUp');
      dispatchKey('Enter');

      await waitFor(() => {
        expect(screen.getByText('Delete Workflow')).toBeInTheDocument();
      });
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    });

    it('task menu in mini DAG: ArrowDown + Enter activates the next enabled action', async () => {
      await setup();
      fireEvent.click(screen.getByTestId('workflow-node-wf-1'));
      await waitFor(() => {
        expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
      });

      fireEvent.contextMenu(screen.getByTestId('rf__node-task-alpha'));
      await screen.findByRole('menu');

      // For pending task-alpha, the menu opens with Restart Task focused.
      // ArrowDown advances to the next enabled action (Open Terminal),
      // and Enter must dispatch openTerminal for the task — proving the
      // menu absorbs Enter rather than letting the App's region handler
      // reopen the workflow menu.
      dispatchKey('ArrowDown');
      dispatchKey('Enter');

      await waitFor(() => {
        expect(mock.api.openTerminal).toHaveBeenCalledWith('task-alpha');
      });
    });
  });
});
