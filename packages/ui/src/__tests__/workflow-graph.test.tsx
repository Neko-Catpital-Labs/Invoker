import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { WorkflowGraph } from '../components/WorkflowGraph.js';
import type { TaskState, WorkflowMeta, WorkflowStatus } from '../types.js';
import type { GraphCameraCommand } from '../lib/graph-camera.js';
import * as ReactFlowModule from '@xyflow/react';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const fitViewMock = (ReactFlowModule as unknown as { __fitViewMock: Mock }).__fitViewMock;
const setCenterMock = (ReactFlowModule as unknown as { __setCenterMock: Mock }).__setCenterMock;
const getZoomMock = (ReactFlowModule as unknown as { __getZoomMock: Mock }).__getZoomMock;

/** Resolve after enough animation frames that any scheduled camera rAF flushed. */
async function flushFrames(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
}

function workflowCommand(overrides: Partial<GraphCameraCommand> & { sequence: number }): GraphCameraCommand {
  return {
    style: 'centerSelection',
    scope: 'workflow',
    target: null,
    reason: 'test',
    ...overrides,
  };
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
    getZoomMock.mockReset();
    getZoomMock.mockReturnValue(1);
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

  // ── Camera ownership: who is allowed to move the viewport, and when ──
  describe('camera and viewport ownership', () => {
    const baseWorkflows = () => new Map([['wf-a', wf('wf-a', 'running')]]);
    const baseTasks = () => new Map([['t1', task('t1', 'wf-a')]]);

    function renderGraph(
      props: Partial<{
        cameraCommand: GraphCameraCommand | null;
        onManualViewportChange: () => void;
        workflows: Map<string, WorkflowMeta>;
        tasks: Map<string, TaskState>;
      }> = {},
    ) {
      return render(
        <WorkflowGraph
          tasks={props.tasks ?? baseTasks()}
          workflows={props.workflows ?? baseWorkflows()}
          selectedWorkflowId="wf-a"
          cameraCommand={props.cameraCommand ?? null}
          onManualViewportChange={props.onManualViewportChange}
          statusFilters={new Set()}
          onSelectWorkflow={() => {}}
          onWorkflowContextMenu={() => {}}
        />,
      );
    }

    it('fits the view on the initial non-empty render', async () => {
      renderGraph();
      await vi.waitFor(() => {
        expect(fitViewMock).toHaveBeenCalledWith({ padding: 0.2 });
      });
    });

    it('does not call fitView or setCenter on a status-only update after the initial fit', async () => {
      const { rerender } = renderGraph();
      await vi.waitFor(() => expect(fitViewMock).toHaveBeenCalled());
      await flushFrames();
      fitViewMock.mockClear();
      setCenterMock.mockClear();

      // Same topology, changed workflow status — must not move the camera.
      rerender(
        <WorkflowGraph
          tasks={baseTasks()}
          workflows={new Map([['wf-a', wf('wf-a', 'completed')]])}
          selectedWorkflowId="wf-a"
          statusFilters={new Set()}
          onSelectWorkflow={() => {}}
          onWorkflowContextMenu={() => {}}
        />,
      );
      await flushFrames();
      expect(fitViewMock).not.toHaveBeenCalled();
      expect(setCenterMock).not.toHaveBeenCalled();
    });

    it('does not call fitView or setCenter when a topology change adds a node', async () => {
      const { rerender } = renderGraph();
      await vi.waitFor(() => expect(fitViewMock).toHaveBeenCalled());
      await flushFrames();
      fitViewMock.mockClear();
      setCenterMock.mockClear();

      const grownWorkflows = new Map([
        ['wf-a', wf('wf-a', 'running')],
        ['wf-b', wf('wf-b', 'pending')],
      ]);
      const grownTasks = new Map([
        ['t1', task('t1', 'wf-a')],
        ['t2', task('t2', 'wf-b')],
      ]);
      rerender(
        <WorkflowGraph
          tasks={grownTasks}
          workflows={grownWorkflows}
          selectedWorkflowId="wf-a"
          statusFilters={new Set()}
          onSelectWorkflow={() => {}}
          onWorkflowContextMenu={() => {}}
        />,
      );
      // The new node renders, but the camera stays exactly where the user left it.
      expect(screen.getByTestId('workflow-node-wf-b')).toBeInTheDocument();
      await flushFrames();
      expect(fitViewMock).not.toHaveBeenCalled();
      expect(setCenterMock).not.toHaveBeenCalled();
    });

    it('centers the selection on a centerSelection command, preserving the current zoom', async () => {
      getZoomMock.mockReturnValue(1.75);
      const { rerender } = renderGraph();
      await vi.waitFor(() => expect(fitViewMock).toHaveBeenCalled());
      await flushFrames();
      setCenterMock.mockClear();

      rerender(
        <WorkflowGraph
          tasks={baseTasks()}
          workflows={baseWorkflows()}
          selectedWorkflowId="wf-a"
          cameraCommand={workflowCommand({ target: 'wf-a', sequence: 1 })}
          statusFilters={new Set()}
          onSelectWorkflow={() => {}}
          onWorkflowContextMenu={() => {}}
        />,
      );

      await vi.waitFor(() => expect(setCenterMock).toHaveBeenCalled());
      // Zoom is read from the live viewport and passed through unchanged — never reset to 1.
      expect(setCenterMock).toHaveBeenCalledWith(
        expect.any(Number),
        expect.any(Number),
        { zoom: 1.75, duration: 180 },
      );
    });

    it('consumes a camera command exactly once, ignoring re-renders at the same sequence', async () => {
      const command = workflowCommand({ target: 'wf-a', sequence: 1 });
      const { rerender } = renderGraph({ cameraCommand: command });
      await vi.waitFor(() => expect(setCenterMock).toHaveBeenCalledTimes(1));

      // Same command object / sequence on a later render must not re-center.
      rerender(
        <WorkflowGraph
          tasks={baseTasks()}
          workflows={baseWorkflows()}
          selectedWorkflowId="wf-a"
          cameraCommand={command}
          statusFilters={new Set()}
          onSelectWorkflow={() => {}}
          onWorkflowContextMenu={() => {}}
        />,
      );
      await flushFrames();
      expect(setCenterMock).toHaveBeenCalledTimes(1);
    });

    it('re-fits the view on a fitInitial command issued after the initial render', async () => {
      const { rerender } = renderGraph();
      await vi.waitFor(() => expect(fitViewMock).toHaveBeenCalled());
      await flushFrames();
      fitViewMock.mockClear();

      rerender(
        <WorkflowGraph
          tasks={baseTasks()}
          workflows={baseWorkflows()}
          selectedWorkflowId="wf-a"
          cameraCommand={workflowCommand({ style: 'fitInitial', target: null, sequence: 2 })}
          statusFilters={new Set()}
          onSelectWorkflow={() => {}}
          onWorkflowContextMenu={() => {}}
        />,
      );
      await vi.waitFor(() => expect(fitViewMock).toHaveBeenCalledWith({ padding: 0.2 }));
    });

    it('defers a command whose target node is absent until that node mounts', async () => {
      const { rerender } = renderGraph({
        cameraCommand: workflowCommand({ target: 'wf-b', sequence: 1 }),
      });
      await vi.waitFor(() => expect(fitViewMock).toHaveBeenCalled());
      await flushFrames();
      // wf-b does not exist yet, so the centerSelection command is held, not dropped.
      expect(setCenterMock).not.toHaveBeenCalled();

      const grownWorkflows = new Map([
        ['wf-a', wf('wf-a', 'running')],
        ['wf-b', wf('wf-b', 'pending')],
      ]);
      const grownTasks = new Map([
        ['t1', task('t1', 'wf-a')],
        ['t2', task('t2', 'wf-b')],
      ]);
      rerender(
        <WorkflowGraph
          tasks={grownTasks}
          workflows={grownWorkflows}
          selectedWorkflowId="wf-b"
          cameraCommand={workflowCommand({ target: 'wf-b', sequence: 1 })}
          statusFilters={new Set()}
          onSelectWorkflow={() => {}}
          onWorkflowContextMenu={() => {}}
        />,
      );
      // Now the node exists; the previously-deferred command applies.
      await vi.waitFor(() => expect(setCenterMock).toHaveBeenCalled());
    });

    it('reports manual pan and wheel zoom without autofocusing the graph', async () => {
      const onManualViewportChange = vi.fn();
      renderGraph({ onManualViewportChange });
      await vi.waitFor(() => expect(fitViewMock).toHaveBeenCalled());
      await flushFrames();
      fitViewMock.mockClear();
      setCenterMock.mockClear();

      const pane = screen.getByTestId('mock-react-flow-pane');
      fireEvent.mouseDown(pane);
      expect(onManualViewportChange).toHaveBeenCalledTimes(1);

      fireEvent.wheel(pane);
      expect(onManualViewportChange).toHaveBeenCalledTimes(2);

      // The gesture hands the viewport to the user — it never re-frames or centers.
      await flushFrames();
      expect(fitViewMock).not.toHaveBeenCalled();
      expect(setCenterMock).not.toHaveBeenCalled();
    });
  });
});
