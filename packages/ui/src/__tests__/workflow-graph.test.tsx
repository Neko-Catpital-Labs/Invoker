import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WorkflowGraph } from '../components/WorkflowGraph.js';
import type { TaskState, WorkflowMeta, WorkflowStatus } from '../types.js';
import * as ReactFlowModule from '@xyflow/react';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const fitViewMock = (ReactFlowModule as unknown as { __fitViewMock: Mock }).__fitViewMock;
const setCenterMock = (ReactFlowModule as unknown as { __setCenterMock: Mock }).__setCenterMock;

const workflowGraphSource = readFileSync(
  resolve(__dirname, '..', 'components', 'WorkflowGraph.tsx'),
  'utf-8',
);

// Flush two animation frames so requestAnimationFrame-scheduled viewport
// effects have run before we assert on the mocks.
function flushFrames(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

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
  beforeEach(() => {
    fitViewMock.mockClear();
    setCenterMock.mockClear();
  });

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

  // ── First-render fit only ─────────────────────────────────
  it('fits on the first non-empty render', async () => {
    const workflows = new Map([['wf-a', wf('wf-a', 'running')]]);
    const tasks = new Map([['t1', task('t1', 'wf-a')]]);

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

    await vi.waitFor(() => {
      expect(fitViewMock).toHaveBeenCalledWith({ padding: 0.2 });
    });
  });

  it('does not re-fit after a topology change once the first fit has happened', async () => {
    const workflows = new Map([['wf-a', wf('wf-a', 'running')]]);
    const tasks = new Map([['t1', task('t1', 'wf-a')]]);

    const { rerender } = render(
      <WorkflowGraph
        tasks={tasks}
        workflows={workflows}
        selectedWorkflowId={null}
        statusFilters={new Set()}
        onSelectWorkflow={() => {}}
        onWorkflowContextMenu={() => {}}
      />,
    );

    await flushFrames();
    fitViewMock.mockClear();

    // Topology grows (wf-b added). Without key={graphSignature} the flow is not
    // remounted, and the one-shot fit has already fired, so no re-fit happens.
    const refreshedWorkflows = new Map([
      ['wf-a', wf('wf-a', 'running')],
      ['wf-b', wf('wf-b', 'pending')],
    ]);
    const refreshedTasks = new Map([
      ['t1', task('t1', 'wf-a')],
      ['t2', task('t2', 'wf-b')],
    ]);

    rerender(
      <WorkflowGraph
        tasks={refreshedTasks}
        workflows={refreshedWorkflows}
        selectedWorkflowId={null}
        statusFilters={new Set()}
        onSelectWorkflow={() => {}}
        onWorkflowContextMenu={() => {}}
      />,
    );

    await flushFrames();
    expect(fitViewMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('workflow-node-wf-b')).toBeInTheDocument();
  });

  // ── One-shot explicit centering ───────────────────────────
  it('centers once per request and ignores same-request re-renders', async () => {
    const workflows = new Map([
      ['wf-a', wf('wf-a', 'running')],
      ['wf-b', wf('wf-b', 'pending')],
    ]);
    const tasks = new Map([
      ['t1', task('t1', 'wf-a')],
      ['t2', task('t2', 'wf-b')],
    ]);

    const { rerender } = render(
      <WorkflowGraph
        tasks={tasks}
        workflows={workflows}
        selectedWorkflowId={null}
        centerWorkflowRequest={{ id: 'wf-b', requestId: 1 }}
        statusFilters={new Set()}
        onSelectWorkflow={() => {}}
        onWorkflowContextMenu={() => {}}
      />,
    );

    await vi.waitFor(() => {
      expect(setCenterMock).toHaveBeenCalledTimes(1);
    });

    // Live status update: brand-new task objects, same requestId. The one-shot
    // guard must not re-center even though `nodes` is recreated.
    const refreshedTasks = new Map([
      ['t1', task('t1', 'wf-a')],
      ['t2', task('t2', 'wf-b')],
    ]);
    rerender(
      <WorkflowGraph
        tasks={refreshedTasks}
        workflows={workflows}
        selectedWorkflowId={null}
        centerWorkflowRequest={{ id: 'wf-b', requestId: 1 }}
        statusFilters={new Set()}
        onSelectWorkflow={() => {}}
        onWorkflowContextMenu={() => {}}
      />,
    );
    await flushFrames();
    expect(setCenterMock).toHaveBeenCalledTimes(1);

    // A new requestId is an explicit navigation and must center again.
    rerender(
      <WorkflowGraph
        tasks={refreshedTasks}
        workflows={workflows}
        selectedWorkflowId={null}
        centerWorkflowRequest={{ id: 'wf-a', requestId: 2 }}
        statusFilters={new Set()}
        onSelectWorkflow={() => {}}
        onWorkflowContextMenu={() => {}}
      />,
    );
    await vi.waitFor(() => {
      expect(setCenterMock).toHaveBeenCalledTimes(2);
    });
  });

  it('never centers on status re-renders when no center request is supplied', async () => {
    const workflows = new Map([['wf-a', wf('wf-a', 'running')]]);
    const tasks = new Map([['t1', task('t1', 'wf-a')]]);

    const { rerender } = render(
      <WorkflowGraph
        tasks={tasks}
        workflows={workflows}
        selectedWorkflowId={null}
        centerWorkflowRequest={null}
        statusFilters={new Set()}
        onSelectWorkflow={() => {}}
        onWorkflowContextMenu={() => {}}
      />,
    );
    await flushFrames();

    const updatedTask = { ...task('t1', 'wf-a'), status: 'running' as const };
    rerender(
      <WorkflowGraph
        tasks={new Map([['t1', updatedTask]])}
        workflows={new Map([['wf-a', wf('wf-a', 'completed')]])}
        selectedWorkflowId={null}
        centerWorkflowRequest={null}
        statusFilters={new Set()}
        onSelectWorkflow={() => {}}
        onWorkflowContextMenu={() => {}}
      />,
    );
    await flushFrames();

    expect(setCenterMock).not.toHaveBeenCalled();
  });

  // ── Source guard ──────────────────────────────────────────
  it('does not remount ReactFlow via key={graphSignature}', () => {
    expect(workflowGraphSource).not.toContain('key={graphSignature}');
    expect(workflowGraphSource).not.toContain('graphSignature');
  });
});
