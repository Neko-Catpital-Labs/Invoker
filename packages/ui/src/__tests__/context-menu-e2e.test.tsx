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

describe('Context menu keyboard navigation', () => {
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

  async function setupWithRunningTask() {
    const runningTask = makeUITask({
      id: 'task-running',
      description: 'Currently running',
      status: 'running',
      command: 'sleep 100',
      workflowId: 'wf-1',
    });
    render(<App />);
    act(() => mock.setTasks([runningTask], workflows));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-1')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('workflow-node-wf-1'));
    await waitFor(() => {
      expect(screen.getByTestId('rf__node-task-running')).toBeInTheDocument();
    });
  }

  it('task menu focuses itself on open so keyboard owns it', async () => {
    await setupWithRunningTask();
    fireEvent.contextMenu(screen.getByTestId('rf__node-task-running'));
    const menu = await screen.findByRole('menu');
    expect(document.activeElement).toBe(menu);
  });

  it('task menu ArrowDown skips disabled items and Enter activates highlighted action', async () => {
    await setupWithRunningTask();
    // Override openTerminal so we can assert it was triggered via keyboard.
    const openTerminalSpy = vi.fn(async () => ({ opened: true, session: null }));
    (window as unknown as { __INVOKER_TEST_OPEN_TERMINAL__: typeof openTerminalSpy }).__INVOKER_TEST_OPEN_TERMINAL__ = openTerminalSpy;

    fireEvent.contextMenu(screen.getByTestId('rf__node-task-running'));
    const menu = await screen.findByRole('menu');

    // Highlight starts on the first enabled item ("Open Terminal" for a running task).
    const openTerminal = screen.getByRole('menuitem', { name: 'Open Terminal' });
    expect(openTerminal.className).toMatch(/bg-gray-700/);

    // Restart Task is disabled for running tasks. ArrowDown should skip it and land on Cancel Task (after More expansion isn't needed because the next enabled visible item is More).
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    // After skipping disabled Restart Task, focus jumps to the next enabled item — the "More" button.
    const moreBtn = screen.getByRole('menuitem', { name: 'More' });
    expect(moreBtn.className).toMatch(/bg-gray-700/);

    // ArrowUp wraps back to Open Terminal.
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(screen.getByRole('menuitem', { name: 'Open Terminal' }).className).toMatch(/bg-gray-700/);

    // Enter activates the highlighted Open Terminal action and the menu closes.
    fireEvent.keyDown(menu, { key: 'Enter' });
    await waitFor(() => expect(openTerminalSpy).toHaveBeenCalledWith('task-running'));
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());

    delete (window as unknown as { __INVOKER_TEST_OPEN_TERMINAL__?: typeof openTerminalSpy }).__INVOKER_TEST_OPEN_TERMINAL__;
  });

  it('task menu Space on More expands and highlights the first new item', async () => {
    await setupWithRunningTask();
    fireEvent.contextMenu(screen.getByTestId('rf__node-task-running'));
    const menu = await screen.findByRole('menu');

    // Move highlight to More, then activate with Space.
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'More' }).className).toMatch(/bg-gray-700/);

    fireEvent.keyDown(menu, { key: ' ' });

    // After expansion, the first newly revealed item ("Terminate Task") should be highlighted.
    const terminate = await screen.findByRole('menuitem', { name: 'Terminate Task' });
    expect(terminate.className).toMatch(/bg-gray-700/);
    expect(screen.queryByRole('menuitem', { name: 'More' })).not.toBeInTheDocument();
  });

  it('workflow menu focuses itself, ArrowDown highlights next item, Enter activates', async () => {
    render(<App />);
    act(() => mock.setTasks([alpha, beta, merge], workflows));
    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-1')).toBeInTheDocument();
    });

    fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
    const menu = await screen.findByRole('menu');
    expect(document.activeElement).toBe(menu);

    // Highlight starts on the first item ("Open Workflow").
    expect(screen.getByRole('menuitem', { name: 'Open Workflow' }).className).toMatch(/bg-gray-700/);

    // ArrowDown three times to land on "Copy Workflow ID".
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Copy Workflow ID' }).className).toMatch(/bg-gray-700/);

    fireEvent.keyDown(menu, { key: 'Enter' });
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('wf-1'));
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('workflow menu Enter on More expands and focuses the first new item', async () => {
    render(<App />);
    act(() => mock.setTasks([alpha, beta, merge], workflows));
    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-1')).toBeInTheDocument();
    });

    fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
    const menu = await screen.findByRole('menu');

    // Walk down to "More" (index 4) then activate it.
    for (let i = 0; i < 4; i += 1) {
      fireEvent.keyDown(menu, { key: 'ArrowDown' });
    }
    expect(screen.getByRole('menuitem', { name: 'More' }).className).toMatch(/bg-gray-700/);

    fireEvent.keyDown(menu, { key: 'Enter' });

    const rebaseRetry = await screen.findByRole('menuitem', { name: 'Rebase and Retry' });
    expect(rebaseRetry.className).toMatch(/bg-gray-700/);
    expect(screen.queryByRole('menuitem', { name: 'More' })).not.toBeInTheDocument();
  });

  it('open context menu owns ArrowUp/ArrowDown/Enter/Space at the document level', async () => {
    const secondWorkflow: WorkflowMeta = { id: 'wf-2', name: 'Second WF', status: 'pending', baseBranch: 'master' };
    const taskWf2 = makeUITask({
      id: 'task-wf2',
      description: 'wf-2 task',
      status: 'pending',
      command: 'echo wf2',
      workflowId: 'wf-2',
    });

    render(<App />);
    act(() => mock.setTasks([alpha, taskWf2], [...workflows, secondWorkflow]));
    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-1')).toBeInTheDocument();
      expect(screen.getByTestId('workflow-node-wf-2')).toBeInTheDocument();
    });

    fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
    expect(await screen.findByRole('menu')).toBeInTheDocument();

    // Document-level ArrowDown/ArrowUp/Enter/Space must not be consumed by the App graph handler while the menu is open.
    // (The menu's own handler is what should win when focus is on the menu.)
    // The menu must still be open after these document-level presses — selectRelativeNode/openSelectedContextMenu must NOT have run.
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'ArrowUp' });
    fireEvent.keyDown(document, { key: ' ' });
    expect(screen.getByRole('menu')).toBeInTheDocument();
    // Workflow selection should not have switched (would have closed the menu via selectWorkflowById).
    expect(screen.queryByTestId('selected-workflow-mini-dag')).toHaveTextContent('Test Workflow task DAG');
  });
});
