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

    expect(screen.getByTestId('workflow-node-wf-a')).toBeInTheDocument();
    expect(screen.getByTestId('workflow-node-wf-b')).toBeInTheDocument();
    expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
    expect(screen.getByTestId('rf__node-task-beta')).toBeInTheDocument();
  });

  it('keeps the selected mini-DAG visible during a merge-node remove/create/update storm', async () => {
    const alpha = makeUITask({
      id: 'task-alpha',
      description: 'Workflow A first task',
      status: 'pending',
      workflowId: 'wf-a',
      taskStateVersion: 1,
    });
    const beta = makeUITask({
      id: 'task-beta',
      description: 'Workflow A second task',
      status: 'pending',
      workflowId: 'wf-a',
      dependencies: ['task-alpha'],
      taskStateVersion: 1,
    });
    const merge = makeUITask({
      id: '__merge__wf-a',
      description: 'Workflow A merge',
      status: 'pending',
      workflowId: 'wf-a',
      isMergeNode: true,
      dependencies: ['task-beta'],
      taskStateVersion: 1,
    });
    const gamma = makeUITask({
      id: 'task-gamma',
      description: 'Workflow B task',
      status: 'running',
      workflowId: 'wf-b',
      taskStateVersion: 1,
    });

    render(<App />);
    act(() => mock.setTasks([alpha, beta, merge, gamma], [workflowA, workflowB]));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-a')).toBeInTheDocument();
      expect(screen.getByTestId('workflow-node-wf-b')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('rf__node-wf-a'));

    await waitFor(() => {
      expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Workflow A task DAG');
      expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
      expect(screen.getByTestId('rf__node-task-beta')).toBeInTheDocument();
      expect(screen.getByTestId('rf__node-__merge__wf-a')).toBeInTheDocument();
    });

    await act(async () => {
      mock.fireDelta({ type: 'removed', taskId: 'task-alpha', previousTaskStateVersion: 1 });
      mock.fireDelta({ type: 'removed', taskId: 'task-beta', previousTaskStateVersion: 1 });
      mock.fireDelta({ type: 'removed', taskId: '__merge__wf-a', previousTaskStateVersion: 1 });
      await new Promise((resolve) => setTimeout(resolve, 130));
    });

    expect(screen.getByTestId('selected-workflow-mini-dag')).toBeInTheDocument();
    expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
    expect(screen.getByTestId('rf__node-task-beta')).toBeInTheDocument();
    expect(screen.getByTestId('rf__node-__merge__wf-a')).toBeInTheDocument();
    expect(screen.getByTestId('selected-workflow-mini-dag-refreshing')).toBeInTheDocument();
    expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Workflow A');

    await act(async () => {
      mock.fireDelta({ type: 'created', task: alpha });
      mock.fireDelta({ type: 'created', task: beta });
      mock.fireDelta({ type: 'created', task: merge });
      await new Promise((resolve) => setTimeout(resolve, 130));
    });

    await waitFor(() => {
      expect(screen.queryByTestId('selected-workflow-mini-dag-refreshing')).not.toBeInTheDocument();
      expect(screen.getByTestId('rf__node-task-alpha')).toBeInTheDocument();
      expect(screen.getByTestId('rf__node-task-beta')).toBeInTheDocument();
      expect(screen.getByTestId('rf__node-__merge__wf-a')).toBeInTheDocument();
    });
  });
});
