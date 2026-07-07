/**
 * Repro: an already-open approval modal stays bound to the task object that
 * opened it, even after the task graph refreshes with a newer task snapshot.
 *
 * This is a bug-only proof for the pre-fix state. It deliberately asserts the
 * stale modal behavior so the shell repro exits 0 only while the issue is
 * observable.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, waitFor, fireEvent, within } from '@testing-library/react';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

const workflow: WorkflowMeta = {
  id: 'wf-stale-modal',
  name: 'Stale modal refresh proof',
  status: 'running',
  baseBranch: 'main',
};

describe('approval modal stale task refresh repro', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('keeps an open approval modal on the old task snapshot after a task graph refresh', async () => {
    const oldTask = makeUITask({
      id: 'stale-refresh-task',
      description: 'Fix task before refresh',
      status: 'awaiting_approval',
      workflowId: workflow.id,
      prompt: 'Fix the stale modal repro',
      taskStateVersion: 1,
      execution: {
        pendingFixError: 'old failing output',
        agentSessionId: 'old-session',
      },
    });
    const refreshedTask = makeUITask({
      id: oldTask.id,
      description: 'Fix task after refresh',
      status: 'awaiting_approval',
      workflowId: workflow.id,
      prompt: 'Fix the stale modal repro',
      taskStateVersion: 2,
      execution: {
        pendingFixError: 'new failing output',
        agentSessionId: 'new-session',
      },
    });

    render(<App />);
    act(() => mock.setTasks([oldTask], [workflow]));

    await waitFor(() => {
      expect(screen.getByTestId(`workflow-node-${workflow.id}`)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId(`workflow-node-${workflow.id}`));
    await waitFor(() => {
      expect(screen.getByTestId(`rf__node-${oldTask.id}`)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId(`rf__node-${oldTask.id}`));
    await waitFor(() => {
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Fix task before refresh');
    });

    fireEvent.click(screen.getByTestId('inspector-approve-button'));
    const approvalHeading = await screen.findByRole('heading', { name: 'Approve AI Fix' });
    const modal = approvalHeading.closest('.fixed') as HTMLElement;
    expect(modal).toBeTruthy();
    expect(within(modal).getByText('Fix task before refresh')).toBeInTheDocument();
    expect(within(modal).getByTestId('claude-session-context')).toHaveTextContent('old-session');

    act(() => {
      mock.fireGraphEvent({
        type: 'snapshot',
        tasks: [refreshedTask],
        workflows: [workflow],
        reason: 'stale-modal-refresh-repro',
        streamSequence: 1,
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Fix task after refresh');
    });

    expect(within(modal).getByText('Fix task before refresh')).toBeInTheDocument();
    expect(within(modal).queryByText('Fix task after refresh')).not.toBeInTheDocument();
    expect(within(modal).getByTestId('claude-session-context')).toHaveTextContent('old-session');
    expect(within(modal).getByTestId('claude-session-context')).not.toHaveTextContent('new-session');

    fireEvent.click(within(modal).getByRole('button', { name: 'Approve Fix' }));
    await waitFor(() => {
      expect(mock.api.approve).toHaveBeenCalledWith(oldTask.id);
    });
  });
});
