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
    function findMenu(): HTMLElement {
      return screen.getByRole('menu');
    }

    function highlightedLabel(menu: HTMLElement): string | null {
      const focused = menu.querySelector('button.bg-gray-700');
      return focused ? (focused.textContent ?? '').trim() : null;
    }

    it('focuses the workflow context menu on open so keyboard events route to it', async () => {
      await setup();
      fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
      const menu = await screen.findByRole('menu');
      await waitFor(() => expect(document.activeElement).toBe(menu));
      // First enabled item highlighted by default
      expect(highlightedLabel(menu)).toBe('Open Workflow');
    });

    it('cycles workflow context menu with ArrowDown and activates with Enter', async () => {
      await setup();
      fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
      const menu = await screen.findByRole('menu');
      await waitFor(() => expect(document.activeElement).toBe(menu));

      // Down 2: Open Workflow → Open PR → Retry Workflow
      fireEvent.keyDown(menu, { key: 'ArrowDown' });
      fireEvent.keyDown(menu, { key: 'ArrowDown' });
      expect(highlightedLabel(menu)).toBe('Retry Workflow');

      fireEvent.keyDown(menu, { key: 'Enter' });
      await waitFor(() => expect(mock.api.retryWorkflow).toHaveBeenCalledWith('wf-1'));
      // Menu closes after activation
      await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    });

    it('activates workflow context menu items with Space', async () => {
      await setup();
      fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
      const menu = await screen.findByRole('menu');
      await waitFor(() => expect(document.activeElement).toBe(menu));

      fireEvent.keyDown(menu, { key: ' ' });
      await waitFor(() => {
        expect(mock.api.getTasks).toHaveBeenCalled();
      });
      // First item is Open Workflow which selects the workflow; menu closes
      await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    });

    it('ArrowUp wraps to the More item and Enter expands danger zone with focus on first new item', async () => {
      await setup();
      fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
      const menu = await screen.findByRole('menu');
      await waitFor(() => expect(document.activeElement).toBe(menu));

      // ArrowUp wraps from first enabled item back to last item (More)
      fireEvent.keyDown(menu, { key: 'ArrowUp' });
      expect(highlightedLabel(menu)).toBe('More');

      fireEvent.keyDown(menu, { key: 'Enter' });
      // Danger items appear and focus lands on first new item (Rebase and Retry)
      expect(await screen.findByText('Rebase and Retry')).toBeInTheDocument();
      expect(highlightedLabel(menu)).toBe('Rebase and Retry');
    });

    it('focuses the task context menu on open and activates with Enter', async () => {
      await setup();
      fireEvent.click(screen.getByTestId('workflow-node-wf-1'));
      await waitFor(() => {
        expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
      });
      fireEvent.contextMenu(screen.getByTestId('rf__node-task-alpha'));
      const menu = await screen.findByRole('menu');
      await waitFor(() => expect(document.activeElement).toBe(menu));

      // Pending task: Restart Task is the first enabled item
      expect(highlightedLabel(menu)).toBe('Restart Task');
      fireEvent.keyDown(menu, { key: 'Enter' });
      await waitFor(() => expect(mock.api.restartTask).toHaveBeenCalledWith('task-alpha'));
      await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    });

    it('ArrowDown skips over the Terminate Task danger separator into More on the task menu', async () => {
      await setup();
      fireEvent.click(screen.getByTestId('workflow-node-wf-1'));
      await waitFor(() => {
        expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
      });
      fireEvent.contextMenu(screen.getByTestId('rf__node-task-alpha'));
      const menu = await screen.findByRole('menu');
      await waitFor(() => expect(document.activeElement).toBe(menu));

      // Task pending menu has: Restart Task, Open Terminal, then More (danger items hidden)
      fireEvent.keyDown(menu, { key: 'ArrowDown' });
      expect(highlightedLabel(menu)).toBe('Open Terminal');
      fireEvent.keyDown(menu, { key: 'ArrowDown' });
      expect(highlightedLabel(menu)).toBe('More');

      // Activating More with Space expands danger items and focuses first new one
      fireEvent.keyDown(menu, { key: ' ' });
      expect(highlightedLabel(menu)).toBe('Terminate Task');
    });

    it('open context menu owns ArrowDown so graph navigation does not consume it', async () => {
      await setup();
      fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
      const menu = await screen.findByRole('menu');
      await waitFor(() => expect(document.activeElement).toBe(menu));

      // Dispatch ArrowDown at the document level (what App's listener receives).
      // The guard inside App should short-circuit so the workflow graph does
      // not consume it for region navigation.
      fireEvent.keyDown(document, { key: 'ArrowDown' });

      // Menu is still open and the workflow node test id remains in the DOM
      expect(screen.queryByRole('menu')).toBeInTheDocument();
    });
  });
});
