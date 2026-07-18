import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

const workflow: WorkflowMeta = {
  id: 'wf-mini-dag',
  name: 'Mini DAG Workflow',
  status: 'running',
};

const tasks = [
  makeUITask({
    id: 'task-one',
    description: 'First mini DAG task',
    status: 'pending',
    workflowId: workflow.id,
    command: 'echo one',
  }),
  makeUITask({
    id: 'task-two',
    description: 'Second mini DAG task',
    status: 'pending',
    workflowId: workflow.id,
    dependencies: ['task-one'],
    command: 'echo two',
  }),
];

describe('Home workflow mini DAG background click dismissal regression', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  async function renderSelectedMiniDag() {
    render(<App />);
    act(() => mock.setTasks(tasks, [workflow]));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-mini-dag')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('rf__node-wf-mini-dag'));

    await waitFor(() => {
      expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Mini DAG Workflow');
    });
  }

  it('keeps the selected workflow mini DAG after a blank graph surface click', async () => {
    await renderSelectedMiniDag();

    fireEvent.click(screen.getByTestId('workflow-graph-surface'));

    expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Mini DAG Workflow');
    expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Mini DAG Workflow');
  });

  it('keeps the selected workflow mini DAG after a retargeted React Flow pane click', async () => {
    await renderSelectedMiniDag();

    const pane = document.createElement('div');
    pane.className = 'react-flow__pane';
    screen.getByTestId('workflow-graph-react-flow').appendChild(pane);

    try {
      fireEvent.click(pane);

      expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Mini DAG Workflow');
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Mini DAG Workflow');
    } finally {
      pane.remove();
    }
  });
});
