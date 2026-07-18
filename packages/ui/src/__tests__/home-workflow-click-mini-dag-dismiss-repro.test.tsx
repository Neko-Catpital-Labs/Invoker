import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

const workflows: WorkflowMeta[] = [
  { id: 'wf-repro', name: 'Repro Workflow', status: 'running' },
];

const alpha = makeUITask({
  id: 'task-alpha',
  description: 'Alpha repro task',
  status: 'pending',
  workflowId: 'wf-repro',
  command: 'echo alpha',
});

const beta = makeUITask({
  id: 'task-beta',
  description: 'Beta repro task',
  status: 'pending',
  workflowId: 'wf-repro',
  dependencies: ['task-alpha'],
  command: 'echo beta',
});

describe('Home workflow graph mini DAG click dismissal repro', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  async function renderSelectedWorkflow() {
    render(<App />);
    act(() => mock.setTasks([alpha, beta], workflows));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-node-wf-repro')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('workflow-node-wf-repro'));

    await waitFor(() => {
      expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Repro Workflow');
    });
  }

  it('keeps the selected mini DAG after a blank React Flow wrapper click', async () => {
    await renderSelectedWorkflow();

    fireEvent.click(screen.getByTestId('workflow-graph-react-flow'));

    expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Repro Workflow');
    expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Repro Workflow');
  });

  it('keeps the selected mini DAG when a blank pane click is retargeted to the graph surface', async () => {
    await renderSelectedWorkflow();

    fireEvent.click(screen.getByTestId('workflow-graph-surface'));

    expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Repro Workflow');
    expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Repro Workflow');
  });

  it('still closes workflow context menus from blank graph clicks', async () => {
    await renderSelectedWorkflow();

    fireEvent.contextMenu(screen.getByTestId('workflow-node-wf-repro'));
    await waitFor(() => {
      expect(screen.getByRole('menu')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('workflow-graph-react-flow'));

    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Repro Workflow');
  });
});
