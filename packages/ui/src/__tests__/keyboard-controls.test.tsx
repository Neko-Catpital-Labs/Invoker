/**
 * Component test: side rail controls (Refresh, Clear).
 *
 * Demoted from packages/app/e2e/keyboard-controls.spec.ts.
 * Dropped: Ctrl+Backtick terminal toggle, terminal toggle bar (Electron shell features).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

const workflows: WorkflowMeta[] = [
  { id: 'wf-a', name: 'Alpha Workflow', status: 'running' },
  { id: 'wf-b', name: 'Beta Workflow', status: 'pending' },
];

const tasks = [
  makeUITask({
    id: 'wf-a/task-a',
    description: 'Alpha Task',
    workflowId: 'wf-a',
    command: 'echo alpha',
  }),
  makeUITask({
    id: 'wf-a/task-b',
    description: 'Second Task',
    workflowId: 'wf-a',
    command: 'echo second',
    dependencies: ['wf-a/task-a'],
  }),
  makeUITask({
    id: 'wf-b/task-c',
    description: 'Beta Task',
    workflowId: 'wf-b',
    command: 'echo beta',
  }),
];

async function renderKeyboardFixture(mock: MockInvoker) {
  mock.setTasks(tasks, workflows);
  render(<App />);
  await screen.findByTestId('workflow-node-wf-a');
  await screen.findByTestId('selected-workflow-mini-dag');
}

function key(keyName: string, init: Partial<KeyboardEvent> = {}) {
  fireEvent.keyDown(document, { key: keyName, ...init });
}

describe('Side rail controls (component)', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('Refresh button calls getTasks with forceRefresh=true', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('rail-refresh'));

    await waitFor(() => {
      expect(mock.api.getTasks).toHaveBeenCalled();
      expect(mock.api.getTasks).toHaveBeenLastCalledWith(true);
    });
  });

  it('Clear button calls clear', async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId('rail-clear'));

    await waitFor(() => {
      expect(mock.api.clear).toHaveBeenCalled();
    });
  });

  it('cycles major keyboard regions with Tab', async () => {
    await renderKeyboardFixture(mock);

    expect(screen.getByTestId('workflow-graph-surface')).toHaveAttribute('data-keyboard-active', 'true');
    key('Tab');
    expect(screen.getByTestId('selected-workflow-mini-dag').querySelector('[data-keyboard-region="taskGraph"]')).toHaveAttribute('data-keyboard-active', 'true');
    key('Tab');
    expect(document.querySelector('[data-keyboard-region="inspector"]')).toHaveAttribute('data-keyboard-active', 'true');
    key('Tab');
    expect(document.querySelector('[data-keyboard-region="bottomBar"]')).toHaveAttribute('data-keyboard-active', 'true');
  });

  it('navigates workflow nodes with arrows and opens workflow menu with Enter', async () => {
    await renderKeyboardFixture(mock);

    key('ArrowRight');
    await waitFor(() => {
      expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Beta Workflow task DAG');
    });

    key('Enter');
    expect(await screen.findByRole('menu')).toHaveTextContent('Open Workflow');
  });

  it('navigates task nodes with arrows and opens task menu with Enter', async () => {
    await renderKeyboardFixture(mock);

    key('Tab');
    key('ArrowRight');
    await waitFor(() => {
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Second Task');
    });

    key('Enter');
    expect(await screen.findByRole('menu')).toHaveTextContent('Open Terminal');
  });

  it('expands and collapses the inspector with region arrow keys', async () => {
    await renderKeyboardFixture(mock);

    key('Tab');
    key('Tab');
    key('ArrowRight');
    expect(await screen.findByLabelText('Maximize inspector')).toBeInTheDocument();

    key('ArrowLeft');
    expect(await screen.findByLabelText('Minimize inspector')).toBeInTheDocument();
  });

  it('expands and collapses the terminal drawer from the bottom region', async () => {
    await renderKeyboardFixture(mock);

    key('Tab');
    key('Tab');
    key('Tab');
    key('ArrowUp');
    expect(await screen.findByTestId('terminal-drawer-body')).toBeInTheDocument();

    key('ArrowDown');
    await waitFor(() => {
      expect(screen.queryByTestId('terminal-drawer-body')).not.toBeInTheDocument();
    });
  });

  it('opens search with double Shift and activates workflow and task results', async () => {
    await renderKeyboardFixture(mock);

    key('Shift');
    key('Shift');
    const input = await screen.findByTestId('keyboard-search-input');
    fireEvent.change(input, { target: { value: 'beta workflow' } });
    key('Enter');
    await waitFor(() => {
      expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Beta Workflow task DAG');
    });

    key('Shift');
    key('Shift');
    const taskInput = await screen.findByTestId('keyboard-search-input');
    fireEvent.change(taskInput, { target: { value: 'second task' } });
    key('Enter');
    await waitFor(() => {
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Second Task');
    });
  });

  it('does not let region shortcuts steal focus while typing in search', async () => {
    await renderKeyboardFixture(mock);

    key('Shift');
    key('Shift');
    const input = await screen.findByTestId('keyboard-search-input');
    fireEvent.change(input, { target: { value: 'alpha' } });
    fireEvent.keyDown(input, { key: 'Tab' });

    expect(screen.getByTestId('keyboard-search-overlay')).toBeInTheDocument();
    expect(screen.getByTestId('workflow-graph-surface')).toHaveAttribute('data-keyboard-active', 'true');
  });
});
