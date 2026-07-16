/**
 * Integration test: workflow-mutation-failed handling in <App />.
 *
 * Task-scoped mutation failures are stored for Needs Attention without moving
 * the operator out of their current surface. Workflow-scoped failures still
 * open the Workflows browser.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../types.js';

interface WorkflowMutationFailedEvent {
  intentId: number;
  workflowId: string;
  channel: string;
  taskId?: string;
  headlessCommand?: string;
  message: string;
  failedAt: string;
}

interface MockInvokerWithMutationFailure {
  onWorkflowMutationFailed: (cb: (event: WorkflowMutationFailedEvent) => void) => () => void;
}

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

describe('Workflow mutation failed handling', () => {
  let mock: MockInvoker;
  let workflowMutationFailedCallback: ((event: WorkflowMutationFailedEvent) => void) | undefined;

  beforeEach(() => {
    mock = createMockInvoker();
    (mock.api as typeof mock.api & MockInvokerWithMutationFailure).onWorkflowMutationFailed = vi.fn((cb) => {
      workflowMutationFailedCallback = cb;
      return () => {
        workflowMutationFailedCallback = undefined;
      };
    });
    mock.install();
  });

  afterEach(() => {
    workflowMutationFailedCallback = undefined;
    mock.cleanup();
  });

  function fireWorkflowMutationFailed(event: WorkflowMutationFailedEvent): void {
    workflowMutationFailedCallback?.(event);
  }

  async function settleTasks(): Promise<void> {
    act(() => mock.setTasks([targetTask], [workflow]));
    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-1')).toBeInTheDocument();
    });
  }

  it('keeps the current surface after a task-scoped failure until Needs Attention is opened manually', async () => {
    render(<App />);
    await settleTasks();

    fireEvent.click(screen.getByTestId('rail-queue'));
    await waitFor(() => {
      expect(screen.getByText(/Action Queue/)).toBeInTheDocument();
    });

    act(() => {
      fireWorkflowMutationFailed({
        intentId: 42,
        workflowId: 'wf-1',
        channel: 'invoker:approve',
        taskId: 'wf-1/verify-worker-summary-surface',
        message: 'Error: SSH target "remote_digital_ocean_3" cannot run codex: missing execution harness "codex"',
        failedAt: '2026-07-08T10:00:00.000Z',
      });
    });

    await waitFor(() => {
      expect(screen.getByText(/Action Queue/)).toBeInTheDocument();
    });
    expect(screen.queryByTestId('browser-rail')).not.toBeInTheDocument();
    expect(screen.queryByTestId('task-mutation-failure-detail')).not.toBeInTheDocument();
    expect(screen.getByTestId('workflow-inspector-title')).not.toHaveTextContent('Verify worker summary surface');

    fireEvent.click(screen.getByTestId('sidebar-attention'));

    await waitFor(() => {
      expect(screen.getByTestId('sidebar-attention')).toHaveAttribute('aria-current', 'page');
    });
    await waitFor(() => {
      expect(screen.getByTestId('browser-rail')).toHaveTextContent('Needs Attention');
    });
    await waitFor(() => {
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Verify worker summary surface');
    });
    await waitFor(() => {
      const detail = screen.getByTestId('task-mutation-failure-detail');
      expect(detail).toBeInTheDocument();
      expect(detail).toHaveTextContent('Approve failed');
      expect(detail).toHaveTextContent('missing execution harness "codex"');
      expect(detail).toHaveTextContent('Channel: invoker:approve');
    });
  });

  it('keeps mutation failure details visible when reselecting the task from Needs Attention', async () => {
    render(<App />);
    await settleTasks();

    act(() => {
      fireWorkflowMutationFailed({
        intentId: 46,
        workflowId: 'wf-1',
        channel: 'headless.exec',
        headlessCommand: 'fix',
        taskId: 'wf-1/verify-worker-summary-surface',
        message: 'SSH remote script failed (exit=1, phase=remote_agent_fix)',
        failedAt: '2026-07-08T10:00:00.000Z',
      });
    });

    expect(screen.queryByTestId('task-mutation-failure-detail')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('sidebar-attention'));
    await waitFor(() => {
      expect(screen.getByTestId('task-mutation-failure-detail')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('rail-home'));
    await waitFor(() => {
      expect(screen.getByTestId('sidebar-home')).toHaveAttribute('aria-current', 'page');
    });

    fireEvent.click(screen.getByTestId('sidebar-attention'));
    await waitFor(() => {
      const detail = screen.getByTestId('task-mutation-failure-detail');
      expect(detail).toBeInTheDocument();
      expect(detail).toHaveTextContent('Fix failed');
      expect(detail).toHaveTextContent('Command: fix');
    });
  });

  it('opens the Workflows browser for workflow-scoped failures', async () => {
    render(<App />);
    await settleTasks();

    act(() => {
      fireWorkflowMutationFailed({
        intentId: 47,
        workflowId: 'wf-1',
        channel: 'invoker:recreate',
        message: 'recreate failed',
        failedAt: '2026-07-08T10:00:00.000Z',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('sidebar-workflows')).toHaveAttribute('aria-current', 'page');
    });
    await waitFor(() => {
      expect(screen.getByTestId('browser-rail')).toHaveTextContent('Workflows');
    });
    expect(screen.queryByTestId('workflow-mutation-failed-banner')).not.toBeInTheDocument();
  });
});
