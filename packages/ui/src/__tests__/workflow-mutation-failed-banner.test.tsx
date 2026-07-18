import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

type WorkflowMutationFailedEvent = {
  workflowId?: string;
  failedTaskId?: string;
  message?: string;
  mutationKind?: string;
  intentId?: number;
};

function attachWorkflowMutationFailedEvent(mock: MockInvoker) {
  let callback: ((event: WorkflowMutationFailedEvent) => void) | undefined;
  const onWorkflowMutationFailed = vi.fn((cb: (event: WorkflowMutationFailedEvent) => void) => {
    callback = cb;
    return () => {
      callback = undefined;
    };
  });

  (mock.api as typeof mock.api & {
    onWorkflowMutationFailed: typeof onWorkflowMutationFailed;
  }).onWorkflowMutationFailed = onWorkflowMutationFailed;

  return {
    onWorkflowMutationFailed,
    fire(event: WorkflowMutationFailedEvent) {
      if (!callback) throw new Error('workflow mutation failure listener was not registered');
      act(() => {
        callback?.(event);
      });
    },
  };
}

const workflow: WorkflowMeta = {
  id: 'wf-a',
  name: 'Workflow A',
  status: 'running',
};

const task = makeUITask({
  id: 'task-failed',
  description: 'Regenerate docs',
  status: 'running',
  workflowId: 'wf-a',
  command: 'pnpm docs',
});

describe('workflow mutation failure UI activation', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('records task-scoped mutation failures without opening Needs Attention or selecting the task', async () => {
    const mutationFailures = attachWorkflowMutationFailedEvent(mock);
    render(<App />);
    act(() => mock.setTasks([task], [workflow]));

    await waitFor(() => expect(mutationFailures.onWorkflowMutationFailed).toHaveBeenCalled());

    await screen.findByTestId('workflow-node-wf-a');

    fireEvent.click(screen.getByTestId('workflow-graph-react-flow'));
    await waitFor(() => {
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('No node selected');
    });

    fireEvent.click(screen.getByTestId('rail-queue'));
    await screen.findByText(/Action Queue/);

    mutationFailures.fire({
      workflowId: 'wf-a',
      failedTaskId: 'task-failed',
      message: 'Queued mutation failed',
      mutationKind: 'recreate-task',
      intentId: 44,
    });

    await waitFor(() => {
      expect(screen.getByTestId('rail-attention-count')).toHaveTextContent('1');
    });
    expect(screen.queryByTestId('needs-attention-surface')).not.toBeInTheDocument();
    expect(screen.getByText(/Action Queue/)).toBeInTheDocument();
    expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('No node selected');

    fireEvent.click(screen.getByTestId('rail-attention'));

    await waitFor(() => {
      expect(screen.getByTestId('needs-attention-surface')).toBeInTheDocument();
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Regenerate docs');
      expect(screen.getByTestId('task-mutation-failure-detail')).toHaveTextContent('Queued mutation failed');
    });
    expect(screen.getByTestId('task-mutation-failure-detail')).toHaveTextContent('recreate-task');
    expect(screen.getByTestId('task-mutation-failure-detail')).toHaveTextContent('44');
  });

  it('keeps workflow-scoped mutation failures opening the workflow graph', async () => {
    const mutationFailures = attachWorkflowMutationFailedEvent(mock);
    render(<App />);
    act(() => mock.setTasks([task], [workflow]));

    await waitFor(() => expect(mutationFailures.onWorkflowMutationFailed).toHaveBeenCalled());

    await screen.findByTestId('workflow-node-wf-a');

    fireEvent.click(screen.getByTestId('rail-queue'));
    await screen.findByText(/Action Queue/);

    mutationFailures.fire({
      workflowId: 'wf-a',
      message: 'Workflow mutation failed',
    });

    await waitFor(() => {
      expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Workflow A');
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Workflow A');
    });
    expect(screen.queryByTestId('rail-attention')).not.toBeInTheDocument();
  });
});
