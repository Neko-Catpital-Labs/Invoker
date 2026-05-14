import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowGraph } from '../components/WorkflowGraph.js';
import type { TaskState, WorkflowMeta, WorkflowStatus } from '../types.js';

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

    const node = screen.getByRole('button');
    fireEvent.click(node);
    expect(onSelectWorkflow).toHaveBeenCalledWith('wf-a');

    fireEvent.contextMenu(node);
    expect(onWorkflowContextMenu).toHaveBeenCalledTimes(1);
    expect(onWorkflowContextMenu.mock.calls[0][1]).toBe('wf-a');
  });

  it('renders workflow even when status filter does not match', () => {
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

    expect(screen.getAllByText('wf-a').length).toBeGreaterThan(0);
  });

  it('does not render the workflow id as secondary chip text', () => {
    const workflows = new Map([
      ['branch-like-id', { id: 'branch-like-id', name: 'Workflow A', status: 'running' } satisfies WorkflowMeta],
    ]);
    const tasks = new Map([
      ['t1', task('t1', 'branch-like-id')],
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

    expect(screen.getByText('Workflow A')).toBeInTheDocument();
    expect(screen.queryByText('branch-like-id')).not.toBeInTheDocument();
  });

  it('renders failed workflow status from query-provided workflow metadata', () => {
    const workflows = new Map([
      [
        'wf-1778431088547-35',
        {
          id: 'wf-1778431088547-35',
          name: 'Reduce Large Files Step 2: main.ts decomposition',
          status: 'failed',
        } satisfies WorkflowMeta,
      ],
    ]);
    const tasks = new Map([
      ['wf-1778431088547-35/extract-main-bootstrap-and-ipc', task('wf-1778431088547-35/extract-main-bootstrap-and-ipc', 'wf-1778431088547-35')],
      [
        'wf-1778431088547-35/extract-main-window-and-runner-wiring',
        {
          ...task('wf-1778431088547-35/extract-main-window-and-runner-wiring', 'wf-1778431088547-35'),
          status: 'failed' as const,
          dependencies: ['wf-1778431088547-35/extract-main-bootstrap-and-ipc'],
        },
      ],
      [
        'wf-1778431088547-35/verify-main-decomposition-lane',
        {
          ...task('wf-1778431088547-35/verify-main-decomposition-lane', 'wf-1778431088547-35'),
          dependencies: ['wf-1778431088547-35/extract-main-window-and-runner-wiring'],
        },
      ],
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

    expect(screen.getByText('Reduce Large Files Step 2: main.ts decomposition')).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
  });
});
