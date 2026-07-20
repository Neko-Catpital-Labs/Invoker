import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

function workflow(id: string, name = id): WorkflowMeta {
  return {
    id,
    name,
    status: 'pending',
  };
}

describe('Invoker terminal submit context (component)', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker(
      [makeUITask({ id: 'task-a', workflowId: 'workflow-a', description: 'Initial task' })],
      [workflow('workflow-a', 'Initial Plan')],
    );
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
    vi.restoreAllMocks();
  });

  it('preserves a cleared graph selection when submit-style refresh adds a workflow', async () => {
    render(<App />);

    expect(await screen.findByTestId('workflow-node-workflow-a')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('selected-workflow-mini-dag')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('workflow-graph-surface'));

    await waitFor(() => {
      expect(screen.queryByTestId('selected-workflow-mini-dag')).not.toBeInTheDocument();
    });

    mock.api.getTasks = vi.fn(async () => ({
      tasks: [
        makeUITask({ id: 'task-a', workflowId: 'workflow-a', description: 'Initial task' }),
        makeUITask({ id: 'task-b', workflowId: 'workflow-b', description: 'Submitted planning task' }),
      ],
      workflows: [
        workflow('workflow-a', 'Initial Plan'),
        workflow('workflow-b', 'Submitted Plan'),
      ],
    }));

    fireEvent.click(screen.getByTestId('rail-refresh'));

    expect(await screen.findByTestId('workflow-node-workflow-b')).toBeInTheDocument();
    expect(screen.queryByTestId('selected-workflow-mini-dag')).not.toBeInTheDocument();
    expect(screen.getByTestId('workflow-node-workflow-a').className).not.toContain('ring-blue');
    expect(screen.getByTestId('workflow-node-workflow-b').className).not.toContain('ring-blue');
    expect(mock.api.start).not.toHaveBeenCalled();
  });

  it('keeps an existing workflow selection stable across submit-style refresh', async () => {
    render(<App />);

    expect(await screen.findByTestId('workflow-node-workflow-a')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('workflow-node-workflow-a'));

    await waitFor(() => {
      expect(screen.getByTestId('selected-workflow-mini-dag')).toBeInTheDocument();
    });

    mock.api.getTasks = vi.fn(async () => ({
      tasks: [
        makeUITask({ id: 'task-a', workflowId: 'workflow-a', description: 'Initial task' }),
        makeUITask({ id: 'task-b', workflowId: 'workflow-b', description: 'Submitted planning task' }),
      ],
      workflows: [
        workflow('workflow-a', 'Initial Plan'),
        workflow('workflow-b', 'Submitted Plan'),
      ],
    }));

    fireEvent.click(screen.getByTestId('rail-refresh'));

    expect(await screen.findByTestId('workflow-node-workflow-b')).toBeInTheDocument();
    expect(screen.getByTestId('selected-workflow-mini-dag')).toHaveTextContent('Initial Plan task DAG');
    expect(screen.getByTestId('workflow-node-workflow-a').className).toContain('ring-blue');
    expect(screen.getByTestId('workflow-node-workflow-b').className).not.toContain('ring-blue');
    expect(mock.api.start).not.toHaveBeenCalled();
  });
});
