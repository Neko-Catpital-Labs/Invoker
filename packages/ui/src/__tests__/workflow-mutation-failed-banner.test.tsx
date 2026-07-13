/**
 * Integration test: workflow-mutation-failed handling in <App />.
 *
 * Task-scoped mutation failures are surfaced through the Needs Attention
 * workflow/task browser: the relevant task is selected, the attention surface is
 * opened/focused, and the inspector shows a persistent mutation-failure detail
 * panel. Workflow-scoped failures open the Workflows browser. Routine failures
 * no longer render a global top banner.
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

  async function settleTasks(): Promise<void> {
    act(() => mock.setTasks([targetTask], [workflow]));
    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-1')).toBeInTheDocument();
    });
    // Open the workflow so task nodes are mounted before mutation-failure selection.
    fireEvent.click(screen.getByTestId('workflow-node-wf-1'));
    await waitFor(() => {
      expect(screen.getByTestId('rf__node-wf-1/verify-worker-summary-surface')).toBeInTheDocument();
    });
  }

  it('does not show the top banner for task-scoped approve failures', async () => {
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
  });

  it('selects the task, opens Needs Attention, and surfaces failure details in the inspector', async () => {
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
      mock.fireWorkflowMutationFailed({
        intentId: 46,
        workflowId: 'wf-1',
        channel: 'headless.exec',
        headlessCommand: 'fix',
        taskId: 'wf-1/verify-worker-summary-surface',
        message: 'SSH remote script failed (exit=1, phase=remote_agent_fix)',
        failedAt: '2026-07-08T10:00:00.000Z',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('task-mutation-failure-detail')).toBeInTheDocument();
    });

    // Navigate home and then back to Needs Attention.
    fireEvent.click(screen.getByTestId('sidebar-home'));
    await waitFor(() => {
      expect(screen.getByTestId('sidebar-home')).toHaveAttribute('aria-current', 'page');
    });

    fireEvent.click(screen.getByTestId('sidebar-attention'));
    await waitFor(() => {
      expect(screen.getByTestId('sidebar-attention')).toHaveAttribute('aria-current', 'page');
    });

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
    await waitFor(() => {
      expect(screen.getByTestId('sidebar-workflows')).toHaveAttribute('aria-current', 'page');
    });
    await waitFor(() => {
      expect(screen.getByTestId('browser-rail')).toHaveTextContent('Workflows');
    });
  });
});
