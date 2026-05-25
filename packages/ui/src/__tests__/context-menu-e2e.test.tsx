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
});

/**
 * Regression: an open context menu must be keyboard-navigable.
 *
 * A local repro proved that after opening the workflow context menu on
 * workflow-node-wf-1, pressing ArrowDown three times and then Enter does NOT
 * call navigator.clipboard.writeText('wf-1'). The same gap affects the task
 * context menu in the mini DAG. These tests render the real App + menu
 * components and dispatch real keyboard events so the fix has to actually
 * route keys to the open menu (auto-focus + key handling), not just keep the
 * existing click handlers working.
 *
 * These tests are expected to fail on the pre-fix behavior and pass once the
 * menus auto-focus on mount and handle ArrowDown/ArrowUp/Enter/Space.
 */
describe('Context menu (open menu keyboard activation regression)', () => {
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

  async function setupApp() {
    render(<App />);
    act(() => mock.setTasks([alpha, beta, merge], workflows));
    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-1')).toBeInTheDocument();
    });
  }

  async function openWorkflowMenu(): Promise<HTMLElement> {
    await setupApp();
    fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
    return screen.findByRole('menu');
  }

  async function openTaskMenu(): Promise<HTMLElement> {
    await setupApp();
    fireEvent.click(screen.getByTestId('workflow-node-wf-1'));
    await waitFor(() => {
      expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
    });
    fireEvent.contextMenu(screen.getByTestId('rf__node-task-alpha'));
    return screen.findByRole('menu');
  }

  // Dispatch a real keydown at the natural keyboard target: the focused
  // element if the menu auto-focused (post-fix), otherwise the document
  // (which only matters if the fix uses a document-level listener).
  function sendKey(key: string): void {
    const active = document.activeElement;
    const target: Document | Element =
      active && active !== document.body ? active : document;
    fireEvent.keyDown(target, { key });
  }

  it('workflow menu: ArrowDown x3 + Enter activates Copy Workflow ID', async () => {
    // Items in order: Open Workflow (0), Open PR (1), Retry Workflow (2),
    // Copy Workflow ID (3), More (4). Initial focus on 0; three ArrowDown
    // presses land on index 3.
    await openWorkflowMenu();

    sendKey('ArrowDown');
    sendKey('ArrowDown');
    sendKey('ArrowDown');
    sendKey('Enter');

    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('wf-1'),
    );
  });

  it('workflow menu: ArrowUp wraps deterministically to the last enabled item', async () => {
    // With wrap, two ArrowUp presses from initial focus 0 land on:
    //   0 -> 4 (More) -> 3 (Copy Workflow ID).
    // If wrap is missing or stops at 0, Enter would activate Open Workflow
    // (index 0) and clipboard.writeText would not be called with 'wf-1'.
    await openWorkflowMenu();

    sendKey('ArrowUp');
    sendKey('ArrowUp');
    sendKey('Enter');

    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('wf-1'),
    );
  });

  it('workflow menu: Space activates the highlighted item like Enter', async () => {
    await openWorkflowMenu();

    sendKey('ArrowDown');
    sendKey('ArrowDown');
    sendKey('ArrowDown');
    sendKey(' ');

    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('wf-1'),
    );
  });

  it('task menu in mini DAG: ArrowDown + Enter activates the next enabled action', async () => {
    // For a pending task, the visible (non-danger) items are
    //   Restart Task (0), Open Terminal (1).
    // Initial focus on 0; ArrowDown moves to 1; Enter activates Open
    // Terminal, which routes through window.invoker.openTerminal(taskId).
    await openTaskMenu();

    sendKey('ArrowDown');
    sendKey('Enter');

    await waitFor(() =>
      expect(mock.api.openTerminal).toHaveBeenCalledWith('task-alpha'),
    );
  });
});
