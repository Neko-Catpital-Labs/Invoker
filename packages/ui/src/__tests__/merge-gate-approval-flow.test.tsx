/**
 * Integration test: Merge gate approval flow through full <App />.
 *
 * Verifies the complete chain: MergeGateNode inline buttons → TaskPanel →
 * ApprovalModal with context-specific labels based on workflow onFinish.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { vi } from 'vitest';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

// ── Scenario A: merge (onFinish='merge') ───────────────────

const taskA = makeUITask({
  id: 'task-a1',
  description: 'Regular task A',
  status: 'completed',
  workflowId: 'wf-merge',
  command: 'echo hello',
});

const gateA = makeUITask({
  id: 'gate-a',
  description: 'Merge gate for test plan',
  status: 'awaiting_approval',
  workflowId: 'wf-merge',
  isMergeNode: true,
  dependencies: ['task-a1'],
});

const wfA: WorkflowMeta = {
  id: 'wf-merge',
  name: 'Merge Workflow',
  status: 'running',
  baseBranch: 'main',
  onFinish: 'merge',
  mergeMode: 'manual',
};

// ── Scenario B: pull_request (onFinish='pull_request') ─────

const taskB = makeUITask({
  id: 'task-b1',
  description: 'Regular task B',
  status: 'completed',
  workflowId: 'wf-pr',
  command: 'echo hello',
});

const gateB = makeUITask({
  id: 'gate-b',
  description: 'Pull request gate for test plan',
  status: 'awaiting_approval',
  workflowId: 'wf-pr',
  isMergeNode: true,
  dependencies: ['task-b1'],
});

const wfB: WorkflowMeta = {
  id: 'wf-pr',
  name: 'PR Workflow',
  status: 'running',
  baseBranch: 'main',
  onFinish: 'pull_request',
  mergeMode: 'manual',
};

// ── Scenario C: workflow (no onFinish) ─────────────────────

const taskC = makeUITask({
  id: 'task-c1',
  description: 'Regular task C',
  status: 'completed',
  workflowId: 'wf-workflow',
  command: 'echo hello',
});

const gateC = makeUITask({
  id: 'gate-c',
  description: 'Workflow gate for test plan',
  status: 'awaiting_approval',
  workflowId: 'wf-workflow',
  isMergeNode: true,
  dependencies: ['task-c1'],
});

const wfC: WorkflowMeta = {
  id: 'wf-workflow',
  name: 'Workflow',
  status: 'running',
  baseBranch: 'main',
  mergeMode: 'manual',
};

describe('Merge gate approval flow (integration)', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  // ── Inline button labels ─────────────────────────────────

  it('gate node shows "Approve & Merge" for onFinish=merge', async () => {
    render(<App />);
    act(() => mock.setTasks([taskA, gateA], [wfA]));

    await waitFor(() => {
      expect(screen.getByText('Approve & Merge')).toBeInTheDocument();
    });
  });

  it('gate node shows "Approve & Create PR" for onFinish=pull_request', async () => {
    render(<App />);
    act(() => mock.setTasks([taskB, gateB], [wfB]));

    await waitFor(() => {
      expect(screen.getByText('Approve & Create PR')).toBeInTheDocument();
    });
  });

  it('gate node shows "Approve" for workflow gate (no onFinish)', async () => {
    render(<App />);
    act(() => mock.setTasks([taskC, gateC], [wfC]));

    await waitFor(() => {
      const btn = screen.getByTestId('approve-merge-button');
      expect(btn).toHaveTextContent('Approve');
    });
  });

  // ── Full App flow: TaskPanel → Modal ──────────────────────

  it('merge flow: click gate → TaskPanel "Approve Merge" → modal with "Confirm Merge"', async () => {
    render(<App />);
    act(() => mock.setTasks([taskA, gateA], [wfA]));

    await waitFor(() => {
      expect(screen.getByTestId('rf__node-gate-a')).toBeInTheDocument();
    });

    // Click gate node → selects task in TaskPanel
    fireEvent.click(screen.getByTestId('rf__node-gate-a'));

    // TaskPanel shows "Approve Merge" button for merge nodes
    await waitFor(() => {
      expect(screen.getByText('Approve Merge')).toBeInTheDocument();
    });

    // Click "Approve Merge" → opens ApprovalModal
    fireEvent.click(screen.getByText('Approve Merge'));

    // Modal heading should say "Confirm Merge"
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Confirm Merge' })).toBeInTheDocument();
    });
  });

  it('PR flow: click gate → TaskPanel "Approve Merge" → modal with "Confirm Pull Request" + "Confirm Create PR"', async () => {
    render(<App />);
    act(() => mock.setTasks([taskB, gateB], [wfB]));

    await waitFor(() => {
      expect(screen.getByTestId('rf__node-gate-b')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('rf__node-gate-b'));

    await waitFor(() => {
      expect(screen.getByText('Approve Merge')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Approve Merge'));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Confirm Pull Request' })).toBeInTheDocument();
      expect(screen.getByText('Confirm Create PR')).toBeInTheDocument();
    });
  });

  // ── API call verification ────────────────────────────────

  it('clicking modal approve calls invoker.approve(taskId)', async () => {
    // Use PR scenario where "Confirm Create PR" is unique to the modal
    render(<App />);
    act(() => mock.setTasks([taskB, gateB], [wfB]));

    await waitFor(() => {
      expect(screen.getByTestId('rf__node-gate-b')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('rf__node-gate-b'));

    await waitFor(() => {
      expect(screen.getByText('Approve Merge')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Approve Merge'));

    await waitFor(() => {
      expect(screen.getByText('Confirm Create PR')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Confirm Create PR'));

    await waitFor(() => {
      expect(mock.api.approve).toHaveBeenCalledWith('gate-b');
    });
  });

  it('clicking modal reject uses two-step flow and calls invoker.reject(taskId, reason)', async () => {
    render(<App />);
    act(() => mock.setTasks([taskB, gateB], [wfB]));

    await waitFor(() => {
      expect(screen.getByTestId('rf__node-gate-b')).toBeInTheDocument();
    });

    // Click gate node → select task in TaskPanel
    fireEvent.click(screen.getByTestId('rf__node-gate-b'));

    await waitFor(() => {
      expect(screen.getByText('Reject Merge')).toBeInTheDocument();
    });

    // Step 1: Click "Reject Merge" in TaskPanel → opens modal with reject input shown
    fireEvent.click(screen.getByText('Reject Merge'));

    // Modal opens with initialAction='reject', so reject input is shown immediately
    await waitFor(() => {
      expect(screen.getByText('Confirm Reject Merge')).toBeInTheDocument();
    });

    // Step 2: Click "Confirm Reject Merge" → submits rejection
    fireEvent.click(screen.getByText('Confirm Reject Merge'));

    await waitFor(() => {
      expect(mock.api.reject).toHaveBeenCalledWith('gate-b', undefined);
    });
  });

  it('clicking inline approve button on node calls invoker.approveMerge(workflowId)', async () => {
    render(<App />);
    act(() => mock.setTasks([taskA, gateA], [wfA]));

    await waitFor(() => {
      expect(screen.getByTestId('approve-merge-button')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('approve-merge-button'));

    await waitFor(() => {
      expect(mock.api.approveMerge).toHaveBeenCalledWith('wf-merge');
    });
  });
});
