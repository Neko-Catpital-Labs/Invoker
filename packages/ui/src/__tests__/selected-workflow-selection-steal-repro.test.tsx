/**
 * Regression: an explicitly-selected workflow must keep the task graph focused
 * on itself. During transient graph churn (a snapshot resync or a task-teardown
 * storm from recreate/rebase) the selected workflow can briefly drop out of the
 * live graph. The UI used to react by reassigning the selection to whatever
 * workflow sorted first — yanking the task graph onto an unrelated workflow and
 * tearing down any open task context menu. It must instead hold the selection
 * through the transient gap, and only fall back once the workflow is really gone.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

// The App module and its grace constant must resolve after the mock installs.
const { App, SELECTED_WORKFLOW_VANISH_GRACE_MS } = await import('../App.js');

const workflowA: WorkflowMeta = { id: 'wf-a', name: 'Workflow A', status: 'running' };
const workflowB: WorkflowMeta = { id: 'wf-b', name: 'Workflow B', status: 'running' };

function buildTasks() {
  const alpha = makeUITask({ id: 'task-alpha', description: 'A first', status: 'pending', workflowId: 'wf-a', taskStateVersion: 1 });
  const beta = makeUITask({ id: 'task-beta', description: 'A second', status: 'pending', workflowId: 'wf-a', dependencies: ['task-alpha'], taskStateVersion: 1 });
  const gamma = makeUITask({ id: 'task-gamma', description: 'B first', status: 'running', workflowId: 'wf-b', taskStateVersion: 1 });
  return { alpha, beta, gamma };
}

function miniDagText(): string {
  return screen.queryByTestId('selected-workflow-mini-dag')?.textContent ?? '(gone)';
}

describe('selected workflow selection-steal regression', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mock.cleanup();
  });

  it('keeps focus on the selected workflow when it briefly drops out of the graph (home surface)', async () => {
    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-planning'));
    const { alpha, gamma } = buildTasks();
    act(() => mock.setTasks([alpha, gamma], [workflowA, workflowB]));
    await waitFor(() => expect(screen.getByTestId('workflow-node-wf-a')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('rf__node-wf-a'));
    await waitFor(() => expect(miniDagText()).toContain('Workflow A task DAG'));

    // Transient churn: Workflow A's only task is torn down and A is momentarily
    // omitted from the workflow list (as during a recreate/rebase resync).
    await act(async () => {
      mock.fireDelta({ type: 'removed', taskId: 'task-alpha', previousTaskStateVersion: 1 });
      mock.fireWorkflowsChanged([workflowB]);
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    // Focus must NOT jump to Workflow B.
    expect(miniDagText()).toContain('Workflow A task DAG');
    expect(miniDagText()).not.toContain('Workflow B task DAG');
  });

  it('keeps focus on the selected workflow during churn (workflows browser surface)', async () => {
    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-planning'));
    const { alpha, gamma } = buildTasks();
    act(() => mock.setTasks([alpha, gamma], [workflowA, workflowB]));
    await waitFor(() => expect(screen.getByTestId('workflow-node-wf-a')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('sidebar-workflows'));
    const rows = await screen.findAllByRole('button', { name: /Workflow A/ });
    fireEvent.click(rows[0]);
    await waitFor(() => expect(miniDagText()).toContain('Workflow A task DAG'));

    await act(async () => {
      mock.fireDelta({ type: 'removed', taskId: 'task-alpha', previousTaskStateVersion: 1 });
      mock.fireWorkflowsChanged([workflowB]);
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    expect(miniDagText()).toContain('Workflow A task DAG');
    expect(miniDagText()).not.toContain('Workflow B task DAG');
  });

  it('keeps an open task context menu usable through recreate churn', async () => {
    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-planning'));
    const { alpha, beta, gamma } = buildTasks();
    act(() => mock.setTasks([alpha, beta, gamma], [workflowA, workflowB]));
    await waitFor(() => expect(screen.getByTestId('workflow-node-wf-a')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('rf__node-wf-a'));
    await waitFor(() => expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument());

    fireEvent.contextMenu(screen.getByTestId('rf__node-task-alpha'));
    await screen.findByRole('menu');
    fireEvent.click(await screen.findByText('More'));
    expect(await screen.findByText('Recreate from Task')).toBeInTheDocument();

    // The right-clicked task is torn down and re-added while A is briefly omitted.
    await act(async () => {
      mock.fireDelta({ type: 'removed', taskId: 'task-alpha', previousTaskStateVersion: 1 });
      mock.fireWorkflowsChanged([workflowB]);
      await new Promise((resolve) => setTimeout(resolve, 120));
    });

    // The menu (and its Recreate action) must remain available, not blink shut.
    expect(screen.queryByRole('menu')).toBeInTheDocument();
    expect(screen.getByText('Recreate from Task')).toBeInTheDocument();
    expect(miniDagText()).toContain('Workflow A task DAG');
  });

  it('still moves off the selected workflow once it is genuinely gone (after the grace window)', async () => {
    render(<App />);
    fireEvent.click(await screen.findByTestId('sidebar-planning'));
    const { alpha, gamma } = buildTasks();
    act(() => mock.setTasks([alpha, gamma], [workflowA, workflowB]));
    await waitFor(() => expect(screen.getByTestId('workflow-node-wf-a')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('rf__node-wf-a'));
    await waitFor(() => expect(miniDagText()).toContain('Workflow A task DAG'));

    // Tear the task down first and let it settle so Workflow A is no longer
    // task-backed, then drop it from the workflow list. Now it is genuinely gone
    // (absent from the map with no tasks), not merely mid-churn.
    await act(async () => {
      mock.fireDelta({ type: 'removed', taskId: 'task-alpha', previousTaskStateVersion: 1 });
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    await act(async () => {
      mock.fireWorkflowsChanged([workflowB]);
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    // Workflow A is now absent from the map with no tasks. Once the grace window
    // elapses it is treated as gone and focus moves to the remaining workflow.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, SELECTED_WORKFLOW_VANISH_GRACE_MS + 400));
    });

    await waitFor(() => expect(miniDagText()).toContain('Workflow B task DAG'));
  });
});
