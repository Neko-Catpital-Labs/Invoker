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
 * Regression tests for keyboard navigation/activation while a context menu is
 * open. The pre-fix repro: right-clicking a workflow node opens the context
 * menu, but ArrowDown × 3 + Enter does NOT invoke the highlighted item — the
 * workflow menu has no keyboard handler, and the task menu only binds
 * onKeyDown to its (unfocused) menu div, so real user keystrokes (delivered to
 * document/body) never reach the handler. These tests dispatch keystrokes at
 * the document target the way a real keyboard event would arrive and assert
 * the resulting side effects on the mock API and clipboard.
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

  function pressKey(keyName: string) {
    // Real user keystrokes route to document.activeElement; with the context
    // menu open and nothing inside it focused, that target is document.body
    // and the event bubbles to document. Dispatch on document so any document-
    // level listener registered by the menu sees the event the same way it
    // would in a browser.
    fireEvent.keyDown(document, { key: keyName });
  }

  async function setupApp() {
    render(<App />);
    act(() => mock.setTasks([alpha, beta, merge], workflows));
    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-1')).toBeInTheDocument();
    });
  }

  async function openWorkflowMenu() {
    await setupApp();
    fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-1'));
    await screen.findByRole('menu');
    // Confirm the four expected actions exist so the index assumptions below
    // remain self-documenting if the menu ever reorders.
    expect(screen.getByText('Open Workflow')).toBeInTheDocument();
    expect(screen.getByText('Open PR')).toBeInTheDocument();
    expect(screen.getByText('Retry Workflow')).toBeInTheDocument();
    expect(screen.getByText('Copy Workflow ID')).toBeInTheDocument();
  }

  async function openTaskMenu() {
    await setupApp();
    fireEvent.click(screen.getByTestId('workflow-node-wf-1'));
    await waitFor(() => {
      expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
    });
    fireEvent.contextMenu(screen.getByTestId('rf__node-task-alpha'));
    await screen.findByRole('menu');
    expect(screen.getByText('Restart Task')).toBeInTheDocument();
    expect(screen.getByText('Open Terminal')).toBeInTheDocument();
  }

  it('workflow menu: ArrowDown×3 + Enter copies the workflow id', async () => {
    await openWorkflowMenu();

    // Initial focus is on the first menu item ("Open Workflow"). ArrowDown
    // must advance through Open PR → Retry Workflow → Copy Workflow ID, and
    // Enter on the highlighted item must dispatch the clipboard write.
    pressKey('ArrowDown');
    pressKey('ArrowDown');
    pressKey('ArrowDown');
    pressKey('Enter');

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('wf-1');
    });
  });

  it('workflow menu: ArrowUp wraps from the first item back to the last enabled action', async () => {
    await openWorkflowMenu();

    // From the initial selection (index 0 / Open Workflow) ArrowUp must wrap
    // backwards. The forward wrap is exercised symmetrically by following the
    // ArrowUp with an ArrowDown — net position must return to the first item.
    // Three more ArrowDowns then land on Copy Workflow ID regardless of
    // whether the implementation includes any trailing "More" affordance in
    // the navigation set, so the deterministic outcome is a clipboard write.
    pressKey('ArrowUp');
    pressKey('ArrowDown');
    pressKey('ArrowDown');
    pressKey('ArrowDown');
    pressKey('ArrowDown');
    pressKey('Enter');

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('wf-1');
    });
  });

  it('task menu: ArrowDown + Enter activates the next enabled task action', async () => {
    await openTaskMenu();

    // task-alpha is pending → renderedItems are [Restart Task, Open Terminal];
    // initial focus is Restart Task. ArrowDown advances to Open Terminal, and
    // Enter must call the openTerminal IPC for that task.
    pressKey('ArrowDown');
    pressKey('Enter');

    await waitFor(() => {
      expect(mock.api.openTerminal).toHaveBeenCalledWith('task-alpha');
    });
  });

  it('task menu: Space activates the highlighted item the same way Enter does', async () => {
    await openTaskMenu();

    pressKey('ArrowDown');
    pressKey(' ');

    await waitFor(() => {
      expect(mock.api.openTerminal).toHaveBeenCalledWith('task-alpha');
    });
  });
});
