import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import * as ReactFlowModule from '@xyflow/react';
import { TaskDAG } from '../components/TaskDAG.js';
import { makeUITask } from './helpers/mock-invoker.js';
import type { TaskState, WorkflowMeta } from '../types.js';

vi.mock('@xyflow/react', async () => {
  // Vitest hoists mock factories above static imports, so the helper cannot be
  // referenced as a top-level binding here; the dynamic import is the framework
  // module-loading boundary (see ts-no-dynamic-import exceptions).
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const fitViewMock = (ReactFlowModule as unknown as { __fitViewMock: Mock }).__fitViewMock;

function renderGraph() {
  const task = makeUITask({
    id: 'wf-1/task-a',
    workflowId: 'wf-1',
    status: 'pending',
    description: 'task a',
  });
  const tasks = new Map<string, TaskState>([[task.id, task]]);
  const workflows = new Map<string, WorkflowMeta>([
    ['wf-1', { id: 'wf-1', name: 'wf-1', status: 'running' }],
  ]);
  render(<TaskDAG tasks={tasks} workflows={workflows} />);
  return task;
}

describe('TaskDAG snap-to-graph button', () => {
  beforeEach(() => {
    fitViewMock.mockClear();
  });

  it('renders a snap-to-graph control', async () => {
    const task = renderGraph();
    await waitFor(() => {
      expect(screen.getByTestId(`rf__node-${task.id}`)).toBeInTheDocument();
    });
    expect(screen.getByTestId('snap-to-graph')).toBeInTheDocument();
  });

  it('fits the whole graph into view when clicked', async () => {
    renderGraph();
    const button = await screen.findByTestId('snap-to-graph');
    // Ignore any fitView from the initial onInit mount pass; assert the click.
    fitViewMock.mockClear();

    fireEvent.click(button);

    expect(fitViewMock).toHaveBeenCalledTimes(1);
    expect(fitViewMock).toHaveBeenCalledWith(expect.objectContaining({ padding: 0.2 }));
  });
});
