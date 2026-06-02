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
 * Regression: an OPEN context menu must respond to keyboard navigation.
 *
 * A local repro proved that opening a workflow context menu, pressing
 * ArrowDown three times, and pressing Enter did NOT invoke the highlighted
 * "Copy Workflow ID" action — keyboard events were swallowed by the graph's
 * global navigation handler instead of moving focus inside the open menu.
 *
 * These tests render the real App (workflow graph + mini DAG + menus) and
 * dispatch keyboard events from the active/document keyboard target, then
 * assert on the real side effects (clipboard / mock API). They are written to
 * FAIL on the pre-fix behavior (no in-menu keyboard navigation) and PASS once
 * an open menu consumes ArrowUp/ArrowDown/Enter/Space to highlight and
 * activate its items.
 */
describe('Context menu keyboard navigation (regression)', () => {
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

  /**
   * Dispatch a keydown from the live keyboard target. When the open menu has
   * taken focus we fire from the focused element (so the event bubbles through
   * the menu's own handler); otherwise we fire from `document`, where the App's
   * global keyboard handler listens. This keeps the test agnostic to whether
   * the fix routes keys via the menu element or the document listener.
   */
  function press(keyName: string) {
    const active = document.activeElement as HTMLElement | null;
    const menu = document.querySelector('[role="menu"]');
    const target =
      active && active !== document.body && menu && menu.contains(active)
        ? active
        : document;
    fireEvent.keyDown(target, { key: keyName });
  }

  async function renderApp() {
    render(<App />);
    act(() => mock.setTasks([alpha, beta, merge], workflows));
    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-1')).toBeInTheDocument();
    });
    await screen.findByTestId('selected-workflow-mini-dag');
  }

  async function openWorkflowMenu() {
    await renderApp();
    // Enter from the (default-selected) workflow graph opens wf-1's menu.
    press('Enter');
    const menu = await screen.findByRole('menu');
    await waitFor(() => expect(menu).toHaveTextContent('Copy Workflow ID'));
    return menu;
  }

  it('ArrowDown x3 + Enter on the open workflow menu copies the workflow id', async () => {
    await openWorkflowMenu();

    // Open Workflow (0) → Open PR (1) → Retry Workflow (2) → Copy Workflow ID (3).
    press('ArrowDown');
    press('ArrowDown');
    press('ArrowDown');
    press('Enter');

    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('wf-1'),
    );
  });

  it('Space activates the highlighted workflow menu item just like Enter', async () => {
    await openWorkflowMenu();

    press('ArrowDown');
    press('ArrowDown');
    press('ArrowDown');
    // Space on the highlighted "Copy Workflow ID" must behave like Enter.
    press(' ');

    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('wf-1'),
    );
  });

  it('ArrowUp wraps from the first item to the last action (Copy Workflow ID)', async () => {
    await openWorkflowMenu();

    // Focus starts on the first item (Open Workflow). ArrowUp must wrap
    // deterministically to the last navigable action, "Copy Workflow ID"
    // ("More" is not a navigable action, mirroring the task ContextMenu).
    press('ArrowUp');
    press('Enter');

    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('wf-1'),
    );
  });

  it('ArrowDown + Enter on an open task menu fires the next enabled task action', async () => {
    await renderApp();

    // Open the mini DAG and the task context menu for the (pending) alpha task.
    fireEvent.click(screen.getByTestId('workflow-node-wf-1'));
    const node = await screen.findByTestId('rf__node-task-alpha');
    fireEvent.contextMenu(node);
    const menu = await screen.findByRole('menu');
    await waitFor(() => expect(menu).toHaveTextContent('Open Terminal'));

    // Pending task ordering: Restart Task (0) → Open Terminal (1).
    // ArrowDown then Enter must activate the next enabled action (Open Terminal).
    press('ArrowDown');
    press('Enter');

    await waitFor(() =>
      expect(mock.api.openTerminal).toHaveBeenCalledWith('task-alpha'),
    );
  });
});
