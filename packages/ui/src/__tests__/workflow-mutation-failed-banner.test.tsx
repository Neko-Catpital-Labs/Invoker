/**
 * Integration test: workflow-mutation-failed handling in <App />.
 *
 * Task-scoped mutation failures must not open the top banner. They open Needs
 * Attention, select the task, and show the failure detail in the inspector.
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

const workflow: WorkflowMeta = {
  id: 'wf-1',
  name: 'Local test plan',
  status: 'running',
};

describe('Workflow mutation failed Needs Attention flow', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1600 });
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
    fireEvent.click(screen.getByTestId('workflow-node-wf-1'));
    await waitFor(() => {
      expect(screen.getByTestId('rf__node-wf-1/verify-worker-summary-surface')).toBeInTheDocument();
    });
  }

  it('routes task-scoped approve failures into Needs Attention and inspector detail', async () => {
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
      expect(within(screen.getByTestId('browser-rail')).getByRole('heading', { name: 'Needs Attention' })).toBeVisible();
    });
    await waitFor(() => {
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Verify worker summary surface');
    });
    await waitFor(() => {
      expect(screen.getByTestId('inspector-mutation-failure')).toHaveTextContent(
        /missing execution harness "codex"/,
      );
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

  it('keeps the top banner for unscoped failures', async () => {
    render(<App />);
    await settleTasks();

    act(() => {
      mock.fireWorkflowMutationFailed({
        intentId: 48,
        workflowId: '',
        channel: 'unknown',
        message: 'global mutation blew up',
        failedAt: '2026-07-08T10:00:00.000Z',
      });
    });

    const banner = await screen.findByTestId('workflow-mutation-failed-banner');
    expect(banner).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('workflow-mutation-failed-message')).toHaveTextContent('global mutation blew up');
  });
});
