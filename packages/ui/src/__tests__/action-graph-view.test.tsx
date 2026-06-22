import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ActionGraphResponse } from '@invoker/contracts';
import { ActionGraphView } from '../components/ActionGraphView.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const graph: ActionGraphResponse = {
  generatedAt: '2026-05-14T12:00:00.000Z',
  stallThresholdMs: 60_000,
  nodes: [
    {
      id: 'intent:1',
      type: 'mutation-intent',
      label: 'invoker:retry-workflow',
      status: 'queued',
      workflowId: 'wf-1',
      durations: { queuedMs: 14 * 60_000 },
      history: [{ id: 'h1', timestamp: '2026-05-14T11:46:00.000Z', source: 'test', message: 'queued' }],
    },
    {
      id: 'attempt:task-a-a1',
      type: 'task-attempt',
      label: 'Task A',
      status: 'running',
      taskId: 'task-a',
      workflowId: 'wf-1',
      durations: { heartbeatAgeMs: 8_000 },
    },
  ],
  edges: [{ id: 'intent:1->attempt:task-a-a1', source: 'intent:1', target: 'attempt:task-a-a1' }],
};

describe('ActionGraphView', () => {
  it('renders action graph nodes with duration badges', () => {
    render(<ActionGraphView graph={graph} error={null} selectedNodeId={null} onSelectNode={() => {}} />);

    expect(screen.getByTestId('action-graph-view')).toBeInTheDocument();
    expect(screen.getByText('invoker:retry-workflow')).toBeInTheDocument();
    expect(screen.getByText('queued 14m')).toBeInTheDocument();
    expect(screen.getByText('heartbeat 8s ago')).toBeInTheDocument();
    expect(screen.getByTestId('rf__edge-intent:1->attempt:task-a-a1')).toHaveAttribute('data-source', 'intent:1');
    expect(screen.getByTestId('rf__edge-intent:1->attempt:task-a-a1')).toHaveAttribute('data-target', 'attempt:task-a-a1');
  });

  it('selecting a node notifies the inspector owner', async () => {
    const onSelectNode = vi.fn();
    render(<ActionGraphView graph={graph} error={null} selectedNodeId={null} onSelectNode={onSelectNode} />);

    expect(screen.getByTestId('rf__node-intent:1')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('rf__node-intent:1'));

    expect(onSelectNode).toHaveBeenCalledWith(expect.objectContaining({ id: 'intent:1' }));
  });
});
