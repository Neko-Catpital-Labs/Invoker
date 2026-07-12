/**
 * Integration test: workflow-mutation-failed handling in <App />.
 *
 * Task-scoped and workflow-scoped mutation failures are surfaced through the
 * existing Needs Attention / workflow browser instead of a global top banner.
 * The selected task's inspector shows the failure details.
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

  it('does not show the banner for task-scoped approve failures and opens Needs Attention', async () => {
    render(<App />);
    await settleTasks();

    const message = 'Error: SSH target "remote_digital_ocean_3" cannot run codex: missing execution harness "codex"';
    act(() => {
      mock.fireWorkflowMutationFailed({
        intentId: 42,
        workflowId: 'wf-1',
        channel: 'invoker:approve',
        taskId: 'wf-1/verify-worker-summary-surface',
        message,
        failedAt: '2026-07-08T10:00:00.000Z',
      });
    });

    await waitFor(() => {
      expect(screen.queryByTestId('workflow-mutation-failed-banner')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Verify worker summary surface');
    });
    await waitFor(() => {
      const rail = screen.getByTestId('browser-rail');
      expect(rail).toHaveTextContent('Needs Attention');
    });
    await waitFor(() => {
      const panel = screen.getByTestId('inspector-mutation-failure');
      expect(panel).toHaveTextContent('Approve failed');
      expect(panel).toHaveTextContent(message);
    });
  });

  it('does not show the banner for headless fix failures and opens Needs Attention', async () => {
    render(<App />);
    await settleTasks();

    const message = 'SSH remote script failed (exit=1, phase=remote_agent_fix)\nSTDOUT:\n{"type":"thread.started"}\n{"type":"error","message":"model unsupported"}';
    act(() => {
      mock.fireWorkflowMutationFailed({
        intentId: 46,
        workflowId: 'wf-1',
        channel: 'headless.exec',
        headlessCommand: 'fix',
        taskId: 'wf-1/verify-worker-summary-surface',
        message,
        failedAt: '2026-07-08T10:00:00.000Z',
      });
    });

    await waitFor(() => {
      expect(screen.queryByTestId('workflow-mutation-failed-banner')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Verify worker summary surface');
    });
    await waitFor(() => {
      const rail = screen.getByTestId('browser-rail');
      expect(rail).toHaveTextContent('Needs Attention');
    });
    await waitFor(() => {
      const panel = screen.getByTestId('inspector-mutation-failure');
      expect(panel).toHaveTextContent('Fix failed');
      expect(panel).toHaveTextContent('SSH remote script failed (exit=1, phase=remote_agent_fix)');
      expect(panel).toHaveTextContent('"type":"error","message":"model unsupported"');
    });
  });

  it('does not show the banner for workflow-scoped failures and opens the workflow browser', async () => {
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
      const rail = screen.getByTestId('browser-rail');
      expect(rail).toHaveTextContent('Workflows');
      expect(rail).toHaveTextContent('Local test plan');
    });
  });
});
