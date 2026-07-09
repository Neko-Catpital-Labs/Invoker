/**
 * Integration test: workflow-mutation-failed banner in <App />.
 *
 * Reproduces the "Approve Fix does nothing" symptom by firing the
 * onWorkflowMutationFailed event that the owner-side coordinator now emits when
 * an intent dispatch throws. The renderer must surface the failure so the user
 * knows the mutation did not actually run.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
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

  it('renders an alert with the coordinator message when onWorkflowMutationFailed fires', async () => {
    render(<App />);
    act(() => mock.setTasks([targetTask], [workflow]));

    await waitFor(() => {
      expect(screen.queryByTestId('workflow-mutation-failed-banner')).not.toBeInTheDocument();
    });

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

    const banner = await screen.findByTestId('workflow-mutation-failed-banner');
    expect(banner).toHaveAttribute('role', 'alert');
    expect(banner).toHaveTextContent('Approve failed');
    expect(screen.getByTestId('workflow-mutation-failed-message')).toHaveTextContent(
      /missing execution harness "codex"/,
    );
  });

  it('clears the banner when Dismiss is clicked', async () => {
    render(<App />);
    act(() => mock.setTasks([targetTask], [workflow]));

    act(() => {
      mock.fireWorkflowMutationFailed({
        intentId: 43,
        workflowId: 'wf-1',
        channel: 'invoker:approve',
        taskId: 'wf-1/verify-worker-summary-surface',
        message: 'dispatch blew up',
        failedAt: '2026-07-08T10:00:00.000Z',
      });
    });

    const banner = await screen.findByTestId('workflow-mutation-failed-banner');
    expect(banner).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('workflow-mutation-failed-dismiss'));

    await waitFor(() => {
      expect(screen.queryByTestId('workflow-mutation-failed-banner')).not.toBeInTheDocument();
    });
  });

  it('selects the failing task when the operator clicks Open task', async () => {
    render(<App />);
    act(() => mock.setTasks([targetTask], [workflow]));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-1')).toBeInTheDocument();
    });

    act(() => {
      mock.fireWorkflowMutationFailed({
        intentId: 44,
        workflowId: 'wf-1',
        channel: 'invoker:approve',
        taskId: 'wf-1/verify-worker-summary-surface',
        message: 'dispatch blew up',
        failedAt: '2026-07-08T10:00:00.000Z',
      });
    });

    const openTask = await screen.findByTestId('workflow-mutation-failed-open-task');
    fireEvent.click(openTask);

    await waitFor(() => {
      expect(screen.queryByTestId('workflow-mutation-failed-banner')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Verify worker summary surface');
    });
  });

  it('labels the banner "Mutation failed (invoker:reject)" when the channel is not approve', async () => {
    render(<App />);
    act(() => mock.setTasks([targetTask], [workflow]));

    act(() => {
      mock.fireWorkflowMutationFailed({
        intentId: 45,
        workflowId: 'wf-1',
        channel: 'invoker:edit-task-command',
        taskId: 'wf-1/verify-worker-summary-surface',
        message: 'edit failed',
        failedAt: '2026-07-08T10:00:00.000Z',
      });
    });

    const banner = await screen.findByTestId('workflow-mutation-failed-banner');
    expect(banner).toHaveTextContent('Mutation failed (invoker:edit-task-command)');
  });
});
