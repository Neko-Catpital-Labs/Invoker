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

  // Keyboard navigation regression tests for open context menus.
  //
  // A local repro showed that opening the workflow context menu, pressing
  // ArrowDown three times, and pressing Enter did not invoke Copy Workflow ID
  // (navigator.clipboard.writeText was never called). The workflow menu had
  // no arrow/Enter/Space handler at all, so keystrokes after opening were
  // silently dropped. These tests render the real App + menu components and
  // dispatch keystrokes from the active keyboard target so the fix must wire
  // up either a focused menu element or a document-level listener — anything
  // shy of that leaves the regression in place.
  describe('keyboard navigation', () => {
    function activeKeyboardTarget(): Element {
      const active = document.activeElement;
      if (active && active !== document.body && active instanceof HTMLElement) {
        return active;
      }
      return document.body;
    }

    async function openWorkflowMenu() {
      await setup();
      fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
      await screen.findByRole('menu');
    }

    async function openTaskMenuInMiniDag() {
      await setup();
      fireEvent.click(screen.getByTestId('workflow-node-wf-1'));
      await waitFor(() => {
        expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
      });
      fireEvent.contextMenu(screen.getByTestId('rf__node-task-alpha'));
      await screen.findByRole('menu');
    }

    it('workflow menu: ArrowDown x3 + Enter activates Copy Workflow ID', async () => {
      await openWorkflowMenu();

      // Visible items with showMore=false:
      //   0: Open Workflow (initial focus)
      //   1: Open PR
      //   2: Retry Workflow
      //   3: Copy Workflow ID  <-- ArrowDown x3 lands here
      //   4: More
      const target = activeKeyboardTarget();
      fireEvent.keyDown(target, { key: 'ArrowDown' });
      fireEvent.keyDown(target, { key: 'ArrowDown' });
      fireEvent.keyDown(target, { key: 'ArrowDown' });
      fireEvent.keyDown(target, { key: 'Enter' });

      await waitFor(() =>
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith('wf-1'),
      );
      expect(mock.api.retryWorkflow).not.toHaveBeenCalled();
      expect(mock.api.recreateWorkflow).not.toHaveBeenCalled();
    });

    it('workflow menu: ArrowUp from the first item wraps to the last enabled menuitem', async () => {
      await openWorkflowMenu();

      // From the initially-focused first item, ArrowUp must wrap to the last
      // enabled menuitem ("More"). Pressing Enter then expands the menu and
      // reveals the danger actions. The assertion checks BOTH the danger
      // items appearing AND that no unintended action handler was invoked.
      const target = activeKeyboardTarget();
      fireEvent.keyDown(target, { key: 'ArrowUp' });
      fireEvent.keyDown(target, { key: 'Enter' });

      await screen.findByText('Rebase and Retry');
      expect(screen.getByText('Rebase and Recreate')).toBeInTheDocument();
      expect(screen.getByText('Recreate Workflow')).toBeInTheDocument();
      expect(screen.getByText('Cancel Workflow')).toBeInTheDocument();
      expect(screen.getByText('Delete Workflow')).toBeInTheDocument();
      expect(mock.api.retryWorkflow).not.toHaveBeenCalled();
      expect(mock.api.recreateWorkflow).not.toHaveBeenCalled();
      expect(mock.api.cancelWorkflow).not.toHaveBeenCalled();
      expect(mock.api.deleteWorkflow).not.toHaveBeenCalled();
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    });

    it('workflow menu: Space activates the highlighted menuitem just like Enter', async () => {
      await openWorkflowMenu();

      const target = activeKeyboardTarget();
      fireEvent.keyDown(target, { key: 'ArrowDown' });
      fireEvent.keyDown(target, { key: 'ArrowDown' });
      fireEvent.keyDown(target, { key: 'ArrowDown' });
      fireEvent.keyDown(target, { key: ' ', code: 'Space' });

      await waitFor(() =>
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith('wf-1'),
      );
    });

    it('task menu in mini DAG: ArrowDown + Enter activates the next enabled task action', async () => {
      await openTaskMenuInMiniDag();

      // task-alpha is pending. Visible items with showMore=false:
      //   0: Restart Task (primary, initial focus)
      //   1: Open Terminal  <-- ArrowDown lands here
      //   ("More" reveals the danger group; we don't navigate into it here.)
      const target = activeKeyboardTarget();
      fireEvent.keyDown(target, { key: 'ArrowDown' });
      fireEvent.keyDown(target, { key: 'Enter' });

      await waitFor(() =>
        expect(mock.api.openTerminal).toHaveBeenCalledWith('task-alpha'),
      );
      expect(mock.api.restartTask).not.toHaveBeenCalled();
    });
  });
});
