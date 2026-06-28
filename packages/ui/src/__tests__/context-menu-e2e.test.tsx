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

  describe('keyboard navigation', () => {
    async function getMenu() {
      const menu = await screen.findByRole('menu');
      return menu as HTMLElement;
    }

    function focusedLabel(menu: HTMLElement): string | null {
      const focused = menu.querySelector<HTMLElement>('button.bg-gray-700');
      return focused?.textContent?.trim() ?? null;
    }

    it('focuses the workflow menu on open so document listeners don\'t consume keys', async () => {
      await setup();
      fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
      const menu = await getMenu();
      expect(document.activeElement).toBe(menu);
      expect(focusedLabel(menu)).toBe('Open Workflow');
    });

    it('ArrowDown/ArrowUp cycle the highlight through workflow menu items', async () => {
      await setup();
      fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
      const menu = await getMenu();

      fireEvent.keyDown(menu, { key: 'ArrowDown' });
      expect(focusedLabel(menu)).toBe('Open PR');
      fireEvent.keyDown(menu, { key: 'ArrowDown' });
      expect(focusedLabel(menu)).toBe('Retry Workflow');
      fireEvent.keyDown(menu, { key: 'ArrowUp' });
      expect(focusedLabel(menu)).toBe('Open PR');
    });

    it('Enter activates the highlighted workflow menu item and closes the menu', async () => {
      await setup();
      fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
      const menu = await getMenu();

      fireEvent.keyDown(menu, { key: 'ArrowDown' });
      fireEvent.keyDown(menu, { key: 'ArrowDown' });
      expect(focusedLabel(menu)).toBe('Retry Workflow');
      fireEvent.keyDown(menu, { key: 'Enter' });

      await waitFor(() => expect(mock.api.retryWorkflow).toHaveBeenCalledWith('wf-1'));
      await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    });

    it('Space activates the highlighted workflow menu item', async () => {
      await setup();
      fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
      const menu = await getMenu();

      fireEvent.keyDown(menu, { key: 'ArrowDown' });
      fireEvent.keyDown(menu, { key: 'ArrowDown' });
      fireEvent.keyDown(menu, { key: 'ArrowDown' });
      expect(focusedLabel(menu)).toBe('Copy Workflow ID');
      fireEvent.keyDown(menu, { key: ' ' });

      await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('wf-1'));
    });

    it('More is reachable via ArrowDown and Enter expands it, focusing the first revealed item', async () => {
      await setup();
      fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
      const menu = await getMenu();

      // Open, Open PR, Retry, Copy, More
      for (let i = 0; i < 4; i++) fireEvent.keyDown(menu, { key: 'ArrowDown' });
      expect(focusedLabel(menu)).toBe('More');
      fireEvent.keyDown(menu, { key: 'Enter' });

      const expanded = await screen.findByText('Rebase and Retry');
      expect(expanded).toBeInTheDocument();
      // Focus should have moved to the first newly-revealed item.
      expect(focusedLabel(menu)).toBe('Rebase and Retry');
    });

    it('task context menu focuses on open and Enter activates the highlighted item', async () => {
      await setup();
      fireEvent.click(screen.getByTestId('workflow-node-wf-1'));
      await waitFor(() => expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument());
      fireEvent.contextMenu(screen.getByTestId('rf__node-task-alpha'));

      const menu = await getMenu();
      expect(document.activeElement).toBe(menu);
      // pending task -> first enabled item is "Restart Task".
      expect(focusedLabel(menu)).toBe('Restart Task');

      fireEvent.keyDown(menu, { key: 'Enter' });

      await waitFor(() => expect(mock.api.restartTask).toHaveBeenCalledWith('task-alpha'));
      await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    });

    it('ArrowDown skips disabled task menu items', async () => {
      const runningAlpha = makeUITask({
        id: 'task-alpha',
        description: 'First test task',
        status: 'running',
        command: 'echo hello-alpha',
        workflowId: 'wf-1',
      });

      render(<App />);
      act(() => mock.setTasks([runningAlpha, beta, merge], workflows));
      await waitFor(() => expect(screen.getByTestId('workflow-node-wf-1')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('workflow-node-wf-1'));
      await waitFor(() => expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument());
      fireEvent.contextMenu(screen.getByTestId('rf__node-task-alpha'));

      const menu = await getMenu();
      // running -> Open Terminal first, Restart Task (disabled) skipped on cycle.
      expect(focusedLabel(menu)).toBe('Open Terminal');
      fireEvent.keyDown(menu, { key: 'ArrowDown' });
      // Should skip the disabled "Restart Task" item and land on the next enabled one.
      expect(focusedLabel(menu)).not.toBe('Restart Task');
    });

    it('App-level graph shortcuts do not steal ArrowUp/ArrowDown while a menu is open', async () => {
      await setup();
      fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
      const menu = await getMenu();

      // Press ArrowDown on the document to make sure App-level keydown is also
      // exercised. With the menu open and focused, the menu's React handler
      // should run first and the App-level guard should bail.
      fireEvent.keyDown(menu, { key: 'ArrowDown' });
      expect(focusedLabel(menu)).toBe('Open PR');

      // Menu must still be the active element — App-level Arrow handling
      // would otherwise pull focus or change selection.
      expect(document.activeElement).toBe(menu);
    });
  });
});
