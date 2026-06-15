import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { WorkflowGraph } from '../components/WorkflowGraph.js';
import { createGraphCameraCommandIssuer } from '../lib/graph-camera.js';
import type { TaskState, WorkflowMeta, WorkflowStatus } from '../types.js';
import * as ReactFlowModule from '@xyflow/react';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const fitViewMock = (ReactFlowModule as unknown as { __fitViewMock: Mock }).__fitViewMock;
const setCenterMock = (ReactFlowModule as unknown as { __setCenterMock: Mock }).__setCenterMock;
const getZoomMock = (ReactFlowModule as unknown as { __getZoomMock: Mock }).__getZoomMock;

function wf(id: string, status: WorkflowStatus, overrides: Partial<WorkflowMeta> = {}): WorkflowMeta {
  return { id, name: id, status, ...overrides };
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

/** Render a one-workflow graph and wait for the initial first-render fit to
 * settle, then clear the viewport spies so a test can assert on the calls that
 * happen *after* the initial mount. */
async function renderAndSettleInitialFit(props: Parameters<typeof WorkflowGraph>[0]) {
  const utils = render(<WorkflowGraph {...props} />);
  // onInit schedules the single first-render fit in a rAF; wait for it.
  await waitFor(() => expect(fitViewMock).toHaveBeenCalledTimes(1));
  fitViewMock.mockClear();
  setCenterMock.mockClear();
  return utils;
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

  it('renders dependency-change lineage edges separately from active dependency edges', () => {
    const workflows = new Map([
      ['wf-a', wf('wf-a', 'review_ready')],
      [
        'wf-b',
        wf('wf-b', 'running', {
          externalDependencyChanges: [
            {
              before: {
                workflowId: 'wf-a',
                taskId: '__merge__',
                requiredStatus: 'completed',
                gatePolicy: 'completed',
              },
              changedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        }),
      ],
    ]);

    render(
      <WorkflowGraph
        tasks={new Map()}
        workflows={workflows}
        selectedWorkflowId={null}
        statusFilters={new Set()}
        onSelectWorkflow={() => {}}
        onWorkflowContextMenu={() => {}}
      />,
    );

    const edge = screen.getByTestId('rf__edge-workflow:historical:wf-a->wf-b');
    expect(edge).toHaveAttribute('data-source', 'wf-a');
    expect(edge).toHaveAttribute('data-target', 'wf-b');
  });

  it('renders active dependency edges with the normal active relationship', () => {
    const workflows = new Map([
      ['wf-a', wf('wf-a', 'review_ready')],
      [
        'wf-b',
        wf('wf-b', 'running', {
          externalDependencies: [
            {
              workflowId: 'wf-a',
              taskId: '__merge__',
              requiredStatus: 'completed',
              gatePolicy: 'completed',
            },
          ],
        }),
      ],
    ]);

    render(
      <WorkflowGraph
        tasks={new Map()}
        workflows={workflows}
        selectedWorkflowId={null}
        statusFilters={new Set()}
        onSelectWorkflow={() => {}}
        onWorkflowContextMenu={() => {}}
      />,
    );

    const edge = screen.getByTestId('rf__edge-workflow:active:wf-a->wf-b');
    expect(edge).toHaveAttribute('data-kind', 'active');
    expect(edge).toHaveAttribute('aria-label', 'Active workflow dependency');
    expect(edge).toHaveStyle({ strokeWidth: '2' });
    expect((edge as HTMLElement).style.strokeDasharray).toBe('');
  });

  it('renders detached provenance as an explicit detached relationship', () => {
    const workflows = new Map([
      ['wf-a', wf('wf-a', 'review_ready')],
      [
        'wf-b',
        wf('wf-b', 'running', {
          detachedExternalDependencies: [
            {
              workflowId: 'wf-a',
              taskId: '__merge__',
              requiredStatus: 'completed',
              gatePolicy: 'completed',
              detachedAt: '2026-01-02T00:00:00.000Z',
            },
          ],
        }),
      ],
    ]);

    render(
      <WorkflowGraph
        tasks={new Map()}
        workflows={workflows}
        selectedWorkflowId={null}
        statusFilters={new Set()}
        onSelectWorkflow={() => {}}
        onWorkflowContextMenu={() => {}}
      />,
    );

    const edge = screen.getByTestId('rf__edge-workflow:detached:wf-a->wf-b');
    expect(edge).toHaveAttribute('data-source', 'wf-a');
    expect(edge).toHaveAttribute('data-target', 'wf-b');
    expect(edge).toHaveAttribute('data-kind', 'detached');
    expect(edge).toHaveAttribute('aria-label', 'Detached workflow lineage');
    expect(edge).toHaveStyle({ strokeDasharray: '5 6' });
    expect(screen.getByTestId('workflow-node-wf-b-detached-badge')).toHaveAccessibleName(
      'Detached upstream lineage',
    );
  });

  it('fits the viewport exactly once on the first non-empty render', async () => {
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

    // onInit fires once for the first non-empty render and never re-fits.
    await waitFor(() => expect(fitViewMock).toHaveBeenCalledTimes(1));
    expect(fitViewMock).toHaveBeenCalledWith({ padding: 0.2 });
    expect(setCenterMock).not.toHaveBeenCalled();
  });

  it('preserves the camera across a non-empty workflow snapshot replacement', async () => {
    const workflows = new Map([
      ['wf-a', wf('wf-a', 'running')],
    ]);
    const tasks = new Map([
      ['t1', task('t1', 'wf-a')],
    ]);

    const { rerender } = await renderAndSettleInitialFit({
      tasks,
      workflows,
      selectedWorkflowId: null,
      statusFilters: new Set(),
      onSelectWorkflow: () => {},
      onWorkflowContextMenu: () => {},
    });

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

    // The new workflow renders without remounting React Flow…
    expect(await screen.findByTestId('workflow-node-wf-b')).toBeInTheDocument();
    // …and the user-owned camera is preserved (no implicit re-fit or re-center).
    expect(fitViewMock).not.toHaveBeenCalled();
    expect(setCenterMock).not.toHaveBeenCalled();
  });

  it('does not move the camera on a status-only update', async () => {
    const tasks = new Map([['t1', task('t1', 'wf-a')]]);

    const { rerender } = await renderAndSettleInitialFit({
      tasks,
      workflows: new Map([['wf-a', wf('wf-a', 'running')]]),
      selectedWorkflowId: 'wf-a',
      statusFilters: new Set(),
      onSelectWorkflow: () => {},
      onWorkflowContextMenu: () => {},
    });

    // Same topology, only the workflow status changes.
    rerender(
      <WorkflowGraph
        tasks={tasks}
        workflows={new Map([['wf-a', wf('wf-a', 'completed')]])}
        selectedWorkflowId="wf-a"
        statusFilters={new Set()}
        onSelectWorkflow={() => {}}
        onWorkflowContextMenu={() => {}}
      />,
    );

    // Give any stray rAF a chance to flush before asserting nothing happened.
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(fitViewMock).not.toHaveBeenCalled();
    expect(setCenterMock).not.toHaveBeenCalled();
  });

  it('centers the selected workflow on a centerSelection command, preserving the current zoom', async () => {
    const issuer = createGraphCameraCommandIssuer();
    getZoomMock.mockReturnValue(1.75);

    const { rerender } = await renderAndSettleInitialFit({
      tasks: new Map([['t1', task('t1', 'wf-a')]]),
      workflows: new Map([['wf-a', wf('wf-a', 'running')]]),
      selectedWorkflowId: 'wf-a',
      statusFilters: new Set(),
      onSelectWorkflow: () => {},
      onWorkflowContextMenu: () => {},
    });

    rerender(
      <WorkflowGraph
        tasks={new Map([['t1', task('t1', 'wf-a')]])}
        workflows={new Map([['wf-a', wf('wf-a', 'running')]])}
        selectedWorkflowId="wf-a"
        cameraCommand={issuer.centerSelection('workflow', 'wf-a')}
        statusFilters={new Set()}
        onSelectWorkflow={() => {}}
        onWorkflowContextMenu={() => {}}
      />,
    );

    await waitFor(() => expect(setCenterMock).toHaveBeenCalledTimes(1));
    // Centering must preserve the live zoom (not reset to 1).
    const [, , options] = setCenterMock.mock.calls[0];
    expect(options).toMatchObject({ zoom: 1.75 });
    // A center command must never trigger a whole-graph fit.
    expect(fitViewMock).not.toHaveBeenCalled();
  });

  it('consumes a fitInitial command by fitting the graph', async () => {
    const issuer = createGraphCameraCommandIssuer();

    const { rerender } = await renderAndSettleInitialFit({
      tasks: new Map([['t1', task('t1', 'wf-a')]]),
      workflows: new Map([['wf-a', wf('wf-a', 'running')]]),
      selectedWorkflowId: 'wf-a',
      statusFilters: new Set(),
      onSelectWorkflow: () => {},
      onWorkflowContextMenu: () => {},
    });

    rerender(
      <WorkflowGraph
        tasks={new Map([['t1', task('t1', 'wf-a')]])}
        workflows={new Map([['wf-a', wf('wf-a', 'running')]])}
        selectedWorkflowId="wf-a"
        cameraCommand={issuer.fitInitial('workflow')}
        statusFilters={new Set()}
        onSelectWorkflow={() => {}}
        onWorkflowContextMenu={() => {}}
      />,
    );

    await waitFor(() => expect(fitViewMock).toHaveBeenCalledTimes(1));
    expect(setCenterMock).not.toHaveBeenCalled();
  });

  it('ignores a camera command scoped to another graph', async () => {
    const issuer = createGraphCameraCommandIssuer();

    const { rerender } = await renderAndSettleInitialFit({
      tasks: new Map([['t1', task('t1', 'wf-a')]]),
      workflows: new Map([['wf-a', wf('wf-a', 'running')]]),
      selectedWorkflowId: 'wf-a',
      statusFilters: new Set(),
      onSelectWorkflow: () => {},
      onWorkflowContextMenu: () => {},
    });

    rerender(
      <WorkflowGraph
        tasks={new Map([['t1', task('t1', 'wf-a')]])}
        workflows={new Map([['wf-a', wf('wf-a', 'running')]])}
        selectedWorkflowId="wf-a"
        cameraCommand={issuer.centerSelection('task', 't1')}
        statusFilters={new Set()}
        onSelectWorkflow={() => {}}
        onWorkflowContextMenu={() => {}}
      />,
    );

    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(setCenterMock).not.toHaveBeenCalled();
    expect(fitViewMock).not.toHaveBeenCalled();
  });

  it('consumes each command once by sequence, not on every re-render', async () => {
    const issuer = createGraphCameraCommandIssuer();
    const command = issuer.centerSelection('workflow', 'wf-a');

    const { rerender } = await renderAndSettleInitialFit({
      tasks: new Map([['t1', task('t1', 'wf-a')]]),
      workflows: new Map([['wf-a', wf('wf-a', 'running')]]),
      selectedWorkflowId: 'wf-a',
      statusFilters: new Set(),
      onSelectWorkflow: () => {},
      onWorkflowContextMenu: () => {},
    });

    const props = {
      tasks: new Map([['t1', task('t1', 'wf-a')]]),
      workflows: new Map([['wf-a', wf('wf-a', 'running')]]),
      selectedWorkflowId: 'wf-a' as const,
      cameraCommand: command,
      statusFilters: new Set<WorkflowStatus>(),
      onSelectWorkflow: () => {},
      onWorkflowContextMenu: () => {},
    };
    rerender(<WorkflowGraph {...props} />);
    await waitFor(() => expect(setCenterMock).toHaveBeenCalledTimes(1));

    // Re-rendering with the SAME command object must not re-fire the move —
    // this is what prevents data refreshes from fighting the user's camera.
    rerender(<WorkflowGraph {...props} />);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(setCenterMock).toHaveBeenCalledTimes(1);
  });

  it('reports manual viewport interaction on background pan and wheel without autofocusing', async () => {
    const onManualViewport = vi.fn();

    await renderAndSettleInitialFit({
      tasks: new Map([['t1', task('t1', 'wf-a')]]),
      workflows: new Map([['wf-a', wf('wf-a', 'running')]]),
      selectedWorkflowId: 'wf-a',
      statusFilters: new Set(),
      onSelectWorkflow: () => {},
      onWorkflowContextMenu: () => {},
      onManualViewport,
    });

    const pane = screen.getByTestId('rf__pane');
    fireEvent.pointerDown(pane);
    fireEvent.wheel(pane);

    expect(onManualViewport).toHaveBeenCalledTimes(2);
    // A manual move must never autofocus the graph.
    expect(setCenterMock).not.toHaveBeenCalled();
    expect(fitViewMock).not.toHaveBeenCalled();
  });
});
