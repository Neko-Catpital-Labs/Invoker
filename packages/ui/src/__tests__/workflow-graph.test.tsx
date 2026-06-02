import { fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { WorkflowGraph } from '../components/WorkflowGraph.js';
import type { CenterRequest, TaskState, WorkflowMeta, WorkflowStatus } from '../types.js';
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

  it('re-fits after a non-empty workflow snapshot replacement', async () => {
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

    fitViewMock.mockClear();

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

    await vi.waitFor(() => {
      expect(fitViewMock).toHaveBeenCalledWith({ padding: 0.2 });
    });
    expect(screen.getByTestId('workflow-node-wf-b')).toBeInTheDocument();
  });

  describe('one-shot center requests', () => {
    const workflows = new Map([['wf-a', wf('wf-a', 'running')]]);
    const tasks = new Map([['t1', task('t1', 'wf-a')]]);

    function renderWithRequest(centerWorkflowRequest: CenterRequest | null) {
      return render(
        <WorkflowGraph
          tasks={tasks}
          workflows={workflows}
          selectedWorkflowId={null}
          centerWorkflowRequest={centerWorkflowRequest}
          statusFilters={new Set()}
          onSelectWorkflow={() => {}}
          onWorkflowContextMenu={() => {}}
        />,
      );
    }

    it('centers once for a center request', async () => {
      renderWithRequest({ id: 'wf-a', requestId: 1 });
      await vi.waitFor(() => {
        expect(setCenterMock).toHaveBeenCalledTimes(1);
      });
    });

    it('does not re-center when re-rendered with the same requestId', async () => {
      const { rerender } = renderWithRequest({ id: 'wf-a', requestId: 1 });
      await vi.waitFor(() => {
        expect(setCenterMock).toHaveBeenCalledTimes(1);
      });

      // A live task/status update arrives. The center request object identity
      // changes but its requestId does not, so the viewport must not snap back.
      rerender(
        <WorkflowGraph
          tasks={new Map([['t1', { ...task('t1', 'wf-a'), status: 'running' }]])}
          workflows={workflows}
          selectedWorkflowId={null}
          centerWorkflowRequest={{ id: 'wf-a', requestId: 1 }}
          statusFilters={new Set()}
          onSelectWorkflow={() => {}}
          onWorkflowContextMenu={() => {}}
        />,
      );

      // Give any pending animation frame a chance to (incorrectly) fire.
      await new Promise((r) => setTimeout(r, 30));
      expect(setCenterMock).toHaveBeenCalledTimes(1);
    });

    it('re-centers when a new requestId arrives', async () => {
      const { rerender } = renderWithRequest({ id: 'wf-a', requestId: 1 });
      await vi.waitFor(() => {
        expect(setCenterMock).toHaveBeenCalledTimes(1);
      });

      rerender(
        <WorkflowGraph
          tasks={tasks}
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
  });

  describe('viewport stability', () => {
    it('does not remount React Flow with a graphSignature key', () => {
      const reactFlowBlock = workflowGraphSource.slice(
        workflowGraphSource.indexOf('<ReactFlow'),
        workflowGraphSource.indexOf('</ReactFlow>'),
      );
      expect(reactFlowBlock).not.toContain('key={graphSignature}');
      // The graphSignature concept is removed entirely so status/topology
      // refreshes no longer reset the viewport.
      expect(workflowGraphSource).not.toContain('graphSignature');
    });

    it('handles each center request exactly once via a last-handled ref', () => {
      expect(workflowGraphSource).toContain('lastCenteredRequestRef');
      expect(workflowGraphSource).toContain('centerWorkflowRequest.requestId');
    });
  });
});
