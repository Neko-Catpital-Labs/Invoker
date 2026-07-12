/**
 * Integration test: workflow-mutation-failed handling in <App />.
 *
 * Task-scoped and workflow-scoped mutation failures are surfaced through the
 * Needs Attention workflow/task browser, not a global top banner. Task failures
 * select the task, open the attention surface, and persist the failure details
 * in the inspector so the operator can inspect message text in the sidebar.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent, within } from '@testing-library/react';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

const targetTask = makeUITask({
  id: 'wf-1/verify-worker-summary-surface',
  description: 'Verify worker summary surface',
  status: 'awaiting_approval',
  workflowId: 'wf-1',
});

const otherAttentionTask = makeUITask({
  id: 'wf-1/other-attention-task',
  description: 'Other attention task',
  status: 'blocked',
  workflowId: 'wf-1',
});

const workflow: WorkflowMeta = {
  id: 'wf-1',
  name: 'Local test plan',
  status: 'running',
};

describe('Workflow mutation failed banner', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  async function settleTasks(): Promise<void> {
    act(() => mock.setTasks([targetTask, otherAttentionTask], [workflow]));
    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-1')).toBeInTheDocument();
    });
    // Open the workflow so task nodes are mounted before mutation-failure selection.
    fireEvent.click(screen.getByTestId('workflow-node-wf-1'));
    await waitFor(() => {
      expect(screen.getByTestId('rf__node-wf-1/verify-worker-summary-surface')).toBeInTheDocument();
    });
  }

  it('does not show the banner for task-scoped approve failures and opens the task instead', async () => {
    render(<App />);
    await settleTasks();

    act(() => {
      mock.fireWorkflowMutationFailed({
        intentId: 42,
        workflowId: 'wf-1',
        channel: 'invoker:approve',
        taskId: 'wf-1/verify-worker-summary-surface',
        message: 'Error: SSH target "remote_digital_ocean_3" cannot run codex: missing execution harness "codex"',
        failedAt: '2026-07-08T10:00:00.000Z',
      });
    });

    await waitFor(() => {
      expect(screen.queryByTestId('workflow-mutation-failed-banner')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Verify worker summary surface');
    });
  });

  it('does not show the banner for headless fix failures', async () => {
    render(<App />);
    await settleTasks();

    act(() => {
      mock.fireWorkflowMutationFailed({
        intentId: 46,
        workflowId: 'wf-1',
        channel: 'headless.exec',
        headlessCommand: 'fix',
        taskId: 'wf-1/verify-worker-summary-surface',
        message: 'SSH remote script failed (exit=1, phase=remote_agent_fix)\nSTDOUT:\n{"type":"thread.started"}\n{"type":"error","message":"model unsupported"}',
        failedAt: '2026-07-08T10:00:00.000Z',
      });
    });

    await waitFor(() => {
      expect(screen.queryByTestId('workflow-mutation-failed-banner')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Verify worker summary surface');
    });
  });

  it('does not show the banner for workflow-scoped failures', async () => {
    render(<App />);
    await settleTasks();

    act(() => {
      mock.fireWorkflowMutationFailed({
        intentId: 47,
        workflowId: 'wf-1',
        channel: 'invoker:recreate',
        message: 'recreate failed',
        failedAt: '2026-07-08T10:00:00.000Z',
      });
    });

    await waitFor(() => {
      expect(screen.queryByTestId('workflow-mutation-failed-banner')).not.toBeInTheDocument();
    });
  });

  it('opens the Needs Attention surface and shows failure details in the inspector', async () => {
    render(<App />);
    await settleTasks();

    act(() => {
      mock.fireWorkflowMutationFailed({
        intentId: 42,
        workflowId: 'wf-1',
        channel: 'invoker:approve',
        taskId: 'wf-1/verify-worker-summary-surface',
        message: 'Error: SSH target "remote_digital_ocean_3" cannot run codex: missing execution harness "codex"',
        failedAt: '2026-07-08T10:00:00.000Z',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('browser-rail')).toHaveTextContent('Needs Attention');
    });
    await waitFor(() => {
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Verify worker summary surface');
    });
    await waitFor(() => {
      const detail = screen.getByTestId('inspector-mutation-failure');
      expect(detail).toHaveTextContent('Approve failed');
      expect(detail).toHaveTextContent('cannot run codex');
      expect(detail).toHaveTextContent('missing execution harness "codex"');
      expect(detail).toHaveTextContent('invoker:approve');
    });
  });

  it('keeps failure details visible when navigating back to the task from Needs Attention', async () => {
    render(<App />);
    await settleTasks();

    act(() => {
      mock.fireWorkflowMutationFailed({
        intentId: 42,
        workflowId: 'wf-1',
        channel: 'invoker:approve',
        taskId: 'wf-1/verify-worker-summary-surface',
        message: 'Error: SSH target "remote_digital_ocean_3" cannot run codex: missing execution harness "codex"',
        failedAt: '2026-07-08T10:00:00.000Z',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Verify worker summary surface');
    });

    // Select a different attention task; the mutation-failure detail should leave.
    const browserRail = screen.getByTestId('browser-rail');
    fireEvent.click(within(browserRail).getByText('Other attention task'));
    await waitFor(() => {
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Other attention task');
    });
    expect(screen.queryByTestId('inspector-mutation-failure')).not.toBeInTheDocument();

    // Navigate back to the failed task; the persisted detail should reappear.
    fireEvent.click(within(browserRail).getByText('Verify worker summary surface'));
    await waitFor(() => {
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Verify worker summary surface');
    });
    await waitFor(() => {
      const detail = screen.getByTestId('inspector-mutation-failure');
      expect(detail).toHaveTextContent('Approve failed');
      expect(detail).toHaveTextContent('missing execution harness "codex"');
    });
  });
});
