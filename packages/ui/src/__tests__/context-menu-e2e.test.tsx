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

  describe('Keyboard navigation', () => {
    function highlightedLabel(): string | null {
      const buttons = document
        .querySelector('[role="menu"]')
        ?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]');
      if (!buttons) return null;
      for (const button of Array.from(buttons)) {
        const classList = button.className.split(/\s+/);
        if (classList.includes('bg-gray-700')) {
          return button.textContent;
        }
      }
      return null;
    }

    it('workflow menu auto-focuses the menu container on open', async () => {
      await setup();
      fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
      const menu = await screen.findByRole('menu');
      await waitFor(() => expect(document.activeElement).toBe(menu));
    });

    it('workflow menu highlights first item on open and Enter activates it', async () => {
      await setup();
      fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
      const menu = await screen.findByRole('menu');
      await waitFor(() => expect(document.activeElement).toBe(menu));
      expect(highlightedLabel()).toBe('Open Workflow');
      fireEvent.keyDown(menu, { key: 'Enter' });
      // Open Workflow is wired to handleWorkflowClick → no Invoker IPC, but it
      // closes the menu, which is the observable signal.
      await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    });

    it('workflow menu ArrowDown moves highlight; Enter retries workflow', async () => {
      await setup();
      fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
      const menu = await screen.findByRole('menu');
      fireEvent.keyDown(menu, { key: 'ArrowDown' }); // → Open PR
      fireEvent.keyDown(menu, { key: 'ArrowDown' }); // → Retry Workflow
      expect(highlightedLabel()).toBe('Retry Workflow');
      fireEvent.keyDown(menu, { key: 'Enter' });
      await waitFor(() => expect(mock.api.retryWorkflow).toHaveBeenCalledWith('wf-1'));
      await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    });

    it('workflow menu ArrowUp wraps from first item to More', async () => {
      await setup();
      fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
      const menu = await screen.findByRole('menu');
      fireEvent.keyDown(menu, { key: 'ArrowUp' });
      expect(highlightedLabel()).toBe('More');
    });

    it('workflow menu Space on More expands and refocuses first revealed item', async () => {
      await setup();
      fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
      const menu = await screen.findByRole('menu');
      fireEvent.keyDown(menu, { key: 'ArrowUp' }); // wraps to More
      expect(highlightedLabel()).toBe('More');
      fireEvent.keyDown(menu, { key: ' ' });
      expect(await screen.findByText('Rebase and Retry')).toBeInTheDocument();
      // Newly-expanded "Rebase and Retry" is the deterministic next highlight.
      expect(highlightedLabel()).toBe('Rebase and Retry');
      fireEvent.keyDown(menu, { key: 'Enter' });
      await waitFor(() => expect(mock.api.rebaseRetry).toHaveBeenCalledWith('wf-1'));
    });

    it('task menu auto-focuses and Enter activates the highlighted item', async () => {
      await setup();
      fireEvent.click(screen.getByTestId('workflow-node-wf-1'));
      await waitFor(() => expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument());
      fireEvent.contextMenu(screen.getByTestId('rf__node-task-alpha'));
      const menu = await screen.findByRole('menu');
      await waitFor(() => expect(document.activeElement).toBe(menu));
      // Pending task → "Restart Task" is primary, first enabled item.
      expect(highlightedLabel()).toBe('Restart Task');
      fireEvent.keyDown(menu, { key: 'Enter' });
      await waitFor(() => expect(mock.api.restartTask).toHaveBeenCalledWith('task-alpha'));
      await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    });

    it('task menu ArrowDown skips no enabled items and cycles', async () => {
      await setup();
      fireEvent.click(screen.getByTestId('workflow-node-wf-1'));
      await waitFor(() => expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument());
      fireEvent.contextMenu(screen.getByTestId('rf__node-task-alpha'));
      const menu = await screen.findByRole('menu');
      // Restart Task → Open Terminal → Terminate Task → Recreate from Task → More
      fireEvent.keyDown(menu, { key: 'ArrowDown' });
      expect(highlightedLabel()).toBe('Open Terminal');
    });

    it('task menu Space on More reveals danger items and highlights first one', async () => {
      await setup();
      fireEvent.click(screen.getByTestId('workflow-node-wf-1'));
      await waitFor(() => expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument());
      fireEvent.contextMenu(screen.getByTestId('rf__node-task-alpha'));
      const menu = await screen.findByRole('menu');
      // Walk down to "More". Restart Task → Open Terminal → More.
      fireEvent.keyDown(menu, { key: 'ArrowDown' });
      fireEvent.keyDown(menu, { key: 'ArrowDown' });
      expect(highlightedLabel()).toBe('More');
      fireEvent.keyDown(menu, { key: ' ' });
      expect(await screen.findByText('Terminate Task')).toBeInTheDocument();
      expect(highlightedLabel()).toBe('Terminate Task');
    });

    it('open menu owns ArrowDown so graph selection does not advance', async () => {
      await setup();
      fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
      const menu = await screen.findByRole('menu');
      // Mirror App's document-level keydown channel; the guard must skip it.
      fireEvent.keyDown(document, { key: 'ArrowDown' });
      // Menu is still open and unchanged.
      expect(screen.getByRole('menu')).toBe(menu);
    });
  });
});
