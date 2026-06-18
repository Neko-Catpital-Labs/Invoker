/**
 * Regression: the workflow graph and selected mini-DAG remain visible when
 * workflows-changed transiently omits workflow metadata while tasks remain.
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

const workflowA: WorkflowMeta = { id: 'wf-a', name: 'Workflow A', status: 'running' };
const workflowB: WorkflowMeta = { id: 'wf-b', name: 'Workflow B', status: 'pending' };

const taskAlpha = makeUITask({
  id: 'task-alpha',
  description: 'Workflow A first task',
  status: 'pending',
  workflowId: 'wf-a',
});
const taskBeta = makeUITask({
  id: 'task-beta',
  description: 'Workflow A second task',
  status: 'pending',
  workflowId: 'wf-a',
  dependencies: ['task-alpha'],
});

describe('selected workflow graph metadata-gap regression', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('keeps the selected mini-DAG visible when workflow metadata briefly omits the selected workflow', async () => {
    render(<App />);
    act(() => mock.setTasks([taskAlpha, taskBeta], [workflowA, workflowB]));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-a')).toBeInTheDocument();
      expect(screen.getByTestId('workflow-node-wf-b')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('rf__node-wf-a'));

    await waitFor(() => {
      expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Workflow A task DAG');
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Workflow A');
      expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
      expect(screen.getByTestId('rf__node-task-beta')).toBeInTheDocument();
    });

    act(() => mock.fireWorkflowsChanged([workflowB]));

    await waitFor(() => {
      expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Workflow A task DAG');
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Workflow A');
    });

    expect(screen.getByText('Total:')).toHaveTextContent('Total: 2');
    expect(screen.getByTestId('workflow-node-wf-a')).toBeInTheDocument();
    expect(screen.getByTestId('workflow-node-wf-b')).toBeInTheDocument();
    expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
    expect(screen.getByTestId('rf__node-task-beta')).toBeInTheDocument();
  });
});
