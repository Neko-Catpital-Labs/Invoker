/**
 * Repro: two coupled UI bugs with one root cause.
 *
 * When an explicitly-selected workflow briefly drops out of the live graph
 * during transient churn (a snapshot resync, or the task teardown a
 * recreate/rebase kicks off — the workflow goes absent from the map with zero
 * tasks), the renderer overreacts:
 *   - it reassigns the selection to whichever workflow sorts first, so the task
 *     graph "suddenly changes to something else" (bug 2), and
 *   - that reassignment (plus the right-clicked task momentarily leaving the
 *     task map) tears down any open task context menu, so the "More" ->
 *     Recreate/rebase actions become unreachable (bug 1).
 *
 * These assertions capture the CURRENT (buggy) behavior on master so the proof
 * lands green; the fix slice flips them to the corrected behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

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

describe('selected workflow selection-steal repro (current behavior)', () => {
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

  it('steals focus to another workflow when the selected one briefly drops out (home surface)', async () => {
    render(<App />);
    const { alpha, gamma } = buildTasks();
    act(() => mock.setTasks([alpha, gamma], [workflowA, workflowB]));
    await waitFor(() => expect(screen.getByTestId('workflow-node-wf-a')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('rf__node-wf-a'));
    await waitFor(() => expect(miniDagText()).toContain('Workflow A task DAG'));

    await act(async () => {
      mock.fireDelta({ type: 'removed', taskId: 'task-alpha', previousTaskStateVersion: 1 });
      mock.fireWorkflowsChanged([workflowB]);
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    // BUG: the graph jumps to the unrelated workflow.
    expect(miniDagText()).toContain('Workflow B task DAG');
  });

  it('steals focus during churn on the workflows browser surface', async () => {
    render(<App />);
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

    // BUG: the graph jumps to the unrelated workflow.
    expect(miniDagText()).toContain('Workflow B task DAG');
  });

  it('tears down the open task context menu during recreate churn', async () => {
    render(<App />);
    const { alpha, beta, gamma } = buildTasks();
    act(() => mock.setTasks([alpha, beta, gamma], [workflowA, workflowB]));
    await waitFor(() => expect(screen.getByTestId('workflow-node-wf-a')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('rf__node-wf-a'));
    await waitFor(() => expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument());

    fireEvent.contextMenu(screen.getByTestId('rf__node-task-alpha'));
    await screen.findByRole('menu');
    fireEvent.click(await screen.findByText('More'));
    expect(await screen.findByText('Recreate from Task')).toBeInTheDocument();

    await act(async () => {
      mock.fireDelta({ type: 'removed', taskId: 'task-alpha', previousTaskStateVersion: 1 });
      mock.fireWorkflowsChanged([workflowB]);
      await new Promise((resolve) => setTimeout(resolve, 120));
    });

    // BUG: the menu blinks shut, so Recreate/rebase becomes unreachable.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
