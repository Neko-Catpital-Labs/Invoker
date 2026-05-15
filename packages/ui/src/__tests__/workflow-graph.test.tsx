import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowGraph } from '../components/WorkflowGraph.js';
import type { TaskState, WorkflowMeta, WorkflowStatus } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

function wf(id: string, status: WorkflowStatus): WorkflowMeta {
  return { id, name: id, status };
}

function task(id: string, workflowId: string): TaskState {
  return {
    id,
    description: id,
    status: 'pending',
    dependencies: [],
    config: { workflowId },
    execution: {},
    taskStateVersion: 1,
  };
}

describe('WorkflowGraph', () => {
  it('calls selection and context menu handlers', () => {
    const onSelectWorkflow = vi.fn();
    const onWorkflowContextMenu = vi.fn();
    const workflows = new Map([
      ['wf-a', wf('wf-a', 'running')],
    ]);
    const tasks = new Map([
      ['t1', task('t1', 'wf-a')],
    ]);

    render(
      <WorkflowGraph
        tasks={tasks}
        workflows={workflows}
        selectedWorkflowId={null}
        statusFilters={new Set()}
        onSelectWorkflow={onSelectWorkflow}
        onWorkflowContextMenu={onWorkflowContextMenu}
      />,
    );

    const node = screen.getByTestId('workflow-node-wf-a');
    fireEvent.click(node);
    expect(onSelectWorkflow).toHaveBeenCalledWith('wf-a');

    fireEvent.contextMenu(node);
    expect(onWorkflowContextMenu).toHaveBeenCalledTimes(1);
    expect(onWorkflowContextMenu.mock.calls[0][1]).toBe('wf-a');
  });

  it('renders filtered workflows dimmed', () => {
    const workflows = new Map([
      ['wf-a', wf('wf-a', 'running')],
    ]);
    const tasks = new Map([
      ['t1', task('t1', 'wf-a')],
    ]);

    render(
      <WorkflowGraph
        tasks={tasks}
        workflows={workflows}
        selectedWorkflowId={null}
        statusFilters={new Set<WorkflowStatus>(['failed'])}
        onSelectWorkflow={() => {}}
        onWorkflowContextMenu={() => {}}
      />,
    );

    const node = screen.getByTestId('workflow-node-wf-a');
    expect(node).toBeInTheDocument();
    expect(node).toHaveClass('opacity-35');
  });

  it('renders the React Flow wrapper for non-empty workflow graphs', () => {
    const workflows = new Map([
      ['wf-a', wf('wf-a', 'running')],
    ]);
    const tasks = new Map([
      ['t1', task('t1', 'wf-a')],
    ]);

    render(
      <WorkflowGraph
        tasks={tasks}
        workflows={workflows}
        selectedWorkflowId={null}
        statusFilters={new Set()}
        onSelectWorkflow={() => {}}
        onWorkflowContextMenu={() => {}}
      />,
    );

    expect(screen.getByTestId('workflow-graph-react-flow')).toBeInTheDocument();
    expect(screen.getByTestId('mock-react-flow')).toBeInTheDocument();
  });
});
