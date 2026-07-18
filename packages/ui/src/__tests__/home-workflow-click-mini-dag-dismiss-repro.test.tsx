/**
 * Regression test: Home workflow node clicks can be followed by a React Flow
 * pane-targeted click when the graph updates under the pointer. That blank
 * pane click must not immediately dismiss the selected workflow mini DAG.
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

const alpha = makeUITask({
  id: 'task-alpha',
  description: 'First retarget repro task',
  status: 'pending',
  workflowId: 'wf-retarget',
  command: 'echo retarget-alpha',
});

const beta = makeUITask({
  id: 'task-beta',
  description: 'Second retarget repro task',
  status: 'pending',
  workflowId: 'wf-retarget',
  dependencies: ['task-alpha'],
  command: 'echo retarget-beta',
});

const workflows: WorkflowMeta[] = [
  { id: 'wf-retarget', name: 'Retarget Workflow', status: 'running' },
];

describe('Home workflow click mini DAG dismissal regression', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('keeps the selected workflow mini DAG after a retargeted pane click', async () => {
    render(<App />);
    act(() => mock.setTasks([alpha, beta], workflows));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-retarget')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('workflow-node-wf-retarget'));
    await waitFor(() => {
      expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Retarget Workflow');
    });

    const reactFlow = screen.getByTestId('workflow-graph-react-flow');
    const pane = document.createElement('div');
    pane.className = 'react-flow__pane';
    reactFlow.appendChild(pane);

    try {
      fireEvent.click(pane);

      expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Retarget Workflow');
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Retarget Workflow');
    } finally {
      pane.remove();
    }
  });
});
