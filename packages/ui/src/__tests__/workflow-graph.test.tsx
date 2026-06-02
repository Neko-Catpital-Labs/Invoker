import { fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { WorkflowGraph } from '../components/WorkflowGraph.js';
import type { TaskState, ViewportCenterRequest, WorkflowMeta, WorkflowStatus } from '../types.js';
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

  it('fits once on first non-empty render and not again on snapshot replacement', async () => {
    const workflows = new Map([
      ['wf-a', wf('wf-a', 'running')],
    ]);
    const tasks = new Map([
      ['t1', task('t1', 'wf-a')],
    ]);

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

    // First non-empty render fits the viewport.
    await vi.waitFor(() => {
      expect(fitViewMock).toHaveBeenCalledWith({ padding: 0.2 });
    });
    fitViewMock.mockClear();

    // A topology/status refresh (new workflow added) must NOT re-fit — that
    // would snap the viewport back and fight a manual pan.
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

    expect(await screen.findByTestId('workflow-node-wf-b')).toBeInTheDocument();
    // Allow any queued animation frames to flush.
    await new Promise((r) => setTimeout(r, 0));
    expect(fitViewMock).not.toHaveBeenCalled();
  });

  describe('one-shot center requests', () => {
    const workflows = new Map([
      ['wf-a', wf('wf-a', 'running')],
      ['wf-b', wf('wf-b', 'pending')],
    ]);
    const tasks = new Map([
      ['t1', task('t1', 'wf-a')],
      ['t2', task('t2', 'wf-b')],
    ]);

    function renderWith(request: ViewportCenterRequest | null, taskMap: Map<string, TaskState>) {
      return (
        <WorkflowGraph
          tasks={taskMap}
          workflows={workflows}
          selectedWorkflowId="wf-a"
          centerWorkflowRequest={request}
          statusFilters={new Set()}
          onSelectWorkflow={() => {}}
          onWorkflowContextMenu={() => {}}
        />
      );
    }

    it('centers once for a request and not again on same-request re-renders', async () => {
      const { rerender } = render(renderWith({ id: 'wf-a', requestId: 1 }, tasks));

      await vi.waitFor(() => {
        expect(setCenterMock).toHaveBeenCalledTimes(1);
      });

      // Simulate live status updates: new tasks Map recreates node objects but
      // the centerWorkflowRequest keeps the same requestId.
      const refreshedTasks = new Map([
        ['t1', { ...task('t1', 'wf-a'), status: 'running' as const }],
        ['t2', task('t2', 'wf-b')],
      ]);
      rerender(renderWith({ id: 'wf-a', requestId: 1 }, refreshedTasks));
      rerender(renderWith({ id: 'wf-a', requestId: 1 }, refreshedTasks));

      await new Promise((r) => setTimeout(r, 0));
      expect(setCenterMock).toHaveBeenCalledTimes(1);
    });

    it('centers again when a new requestId arrives', async () => {
      const { rerender } = render(renderWith({ id: 'wf-a', requestId: 1 }, tasks));

      await vi.waitFor(() => {
        expect(setCenterMock).toHaveBeenCalledTimes(1);
      });

      rerender(renderWith({ id: 'wf-b', requestId: 2 }, tasks));

      await vi.waitFor(() => {
        expect(setCenterMock).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('source guarantees', () => {
    it('does not pass key={graphSignature} to ReactFlow', () => {
      const reactFlowBlock = workflowGraphSource.slice(
        workflowGraphSource.indexOf('<ReactFlow'),
        workflowGraphSource.indexOf('</ReactFlow>'),
      );
      expect(reactFlowBlock).not.toContain('key={graphSignature}');
      expect(workflowGraphSource).not.toContain('key={graphSignature}');
    });

    it('processes center requests through a one-shot handled-request ref', () => {
      expect(workflowGraphSource).toContain('handledCenterRequestRef');
      expect(workflowGraphSource).toContain(
        'handledCenterRequestRef.current === centerWorkflowRequest.requestId',
      );
    });
  });
});
