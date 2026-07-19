import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WorkflowGraph } from '../components/WorkflowGraph.js';
import { createGraphCameraCommandIssuer } from '../lib/graph-camera.js';
import type { WorkflowMeta, WorkflowStatus } from '../types.js';
import * as ReactFlowModule from '@xyflow/react';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const fitViewMock = (ReactFlowModule as unknown as { __fitViewMock: Mock }).__fitViewMock;
const setCenterMock = (ReactFlowModule as unknown as { __setCenterMock: Mock }).__setCenterMock;
const setViewportMock = (ReactFlowModule as unknown as { __setViewportMock: Mock }).__setViewportMock;
const getZoomMock = (ReactFlowModule as unknown as { __getZoomMock: Mock }).__getZoomMock;
const getViewportMock = (ReactFlowModule as unknown as { __getViewportMock: Mock }).__getViewportMock;

const source = readFileSync(
  resolve(__dirname, '..', 'components', 'WorkflowGraph.tsx'),
  'utf-8',
);

function wf(id: string, status: WorkflowStatus, overrides: Partial<WorkflowMeta> = {}): WorkflowMeta {
  return { id, name: id, status, ...overrides };
}
function rollup(
  status: NonNullable<WorkflowMeta['rollup']>['status'],
  running: number,
): NonNullable<WorkflowMeta['rollup']> {
  return {
    status,
    countsByStatus: {
      pending: 0,
      running,
      fixing_with_ai: 0,
      completed: 0,
      failed: 0,
      closed: 0,
      needs_input: 0,
      blocked: 0,
      review_ready: 0,
      awaiting_approval: 0,
      stale: 0,
    },
    failedTasks: [],
    fixingTasks: [],
    waitingTasks: [],
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
    vi.useRealTimers();
    fitViewMock.mockClear();
    setCenterMock.mockClear();
    setViewportMock.mockClear();
    getZoomMock.mockReset();
    getZoomMock.mockReturnValue(1);
    getViewportMock.mockReset();
    getViewportMock.mockReturnValue({ x: 0, y: 0, zoom: 1 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls selection and context menu handlers', () => {
    const onSelectWorkflow = vi.fn();
    const onWorkflowContextMenu = vi.fn();
    const workflows = new Map([
      ['wf-a', wf('wf-a', 'running')],
    ]);

    render(
      <WorkflowGraph
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

    render(
      <WorkflowGraph
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

  it('shows running task count under non-running workflow status', () => {
    const workflows = new Map([
      ['wf-a', wf('wf-a', 'failed', { rollup: rollup('failed', 1) })],
    ]);

    render(
      <WorkflowGraph
        workflows={workflows}
        selectedWorkflowId={null}
        statusFilters={new Set()}
        onSelectWorkflow={() => {}}
        onWorkflowContextMenu={() => {}}
      />,
    );

    expect(screen.getByTestId('workflow-node-wf-a')).toHaveTextContent('failed');
    expect(screen.getByTestId('workflow-node-wf-a-running-tasks')).toHaveTextContent('1 running task');
  });

  it('renders core activity without mutation command labels', () => {
    const workflows = new Map([
      ['wf-1', wf('wf-1', 'running')],
    ]);

    render(
      <WorkflowGraph
        workflows={workflows}
        selectedWorkflowId={null}
        statusFilters={new Set()}
        coreActivityByWorkflow={new Map([
          ['wf-1', {
            workflowId: 'wf-1',
            status: 'pending',
            label: 'Pending: queued for launch',
            nodeId: 'launch-dispatch:1',
            nodeType: 'launch-dispatch',
          }],
        ])}
        onSelectWorkflow={() => {}}
        onWorkflowContextMenu={() => {}}
      />,
    );

    const activity = screen.getByTestId('workflow-node-wf-1-core-activity');
    expect(activity).toHaveTextContent('Pending: queued for launch');
    expect(screen.getByTestId('workflow-node-wf-1')).not.toHaveTextContent(/rebase|invoker:rebase-recreate/i);
  });

  it('renders the React Flow wrapper for non-empty workflow graphs', () => {
    const workflows = new Map([
      ['wf-a', wf('wf-a', 'running')],
    ]);

    render(
      <WorkflowGraph
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

  it('renders active workflow dependency edges normally', () => {
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
        workflows={workflows}
        selectedWorkflowId={null}
        statusFilters={new Set()}
        onSelectWorkflow={() => {}}
        onWorkflowContextMenu={() => {}}
      />,
    );

    const edge = screen.getByTestId('rf__edge-workflow:active:wf-a->wf-b');
    expect(edge).toHaveAttribute('data-source', 'wf-a');
    expect(edge).toHaveAttribute('data-target', 'wf-b');
    expect(edge).toHaveAttribute('data-kind', 'active');
    expect(edge).toHaveAttribute('data-stroke-dasharray', '');
    expect(edge).toHaveAccessibleName('Active workflow dependency');
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

  it('renders detached provenance as detached lineage instead of an orphaned downstream workflow', () => {
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
        workflows={workflows}
        selectedWorkflowId={null}
        statusFilters={new Set()}
        onSelectWorkflow={() => {}}
        onWorkflowContextMenu={() => {}}
      />,
    );

    expect(screen.queryByTestId('rf__edge-workflow:active:wf-a->wf-b')).not.toBeInTheDocument();
    const edge = screen.getByTestId('rf__edge-workflow:detached:wf-a->wf-b');
    expect(edge).toHaveAttribute('data-source', 'wf-a');
    expect(edge).toHaveAttribute('data-target', 'wf-b');
    expect(edge).toHaveAttribute('data-kind', 'detached');
    expect(edge).toHaveAttribute('data-stroke-dasharray', '5 6');
    expect(edge).toHaveAccessibleName('Detached workflow lineage');

    const badge = screen.getByTestId('workflow-node-wf-b-detached-lineage');
    expect(badge).toHaveTextContent('Detached');
    expect(badge).toHaveAttribute('title', 'Detached from 1 upstream workflow');
  });

  it('fits the viewport exactly once on the first non-empty render', async () => {
    const workflows = new Map([['wf-a', wf('wf-a', 'running')]]);

    render(
      <WorkflowGraph
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

  it('restores a supplied viewport on remount without running the first-fit', async () => {
    const workflows = new Map([['wf-a', wf('wf-a', 'running')]]);
    const savedViewport = { x: -240, y: 96, zoom: 0.72 };

    render(
      <WorkflowGraph
        workflows={workflows}
        selectedWorkflowId={null}
        initialViewport={savedViewport}
        statusFilters={new Set()}
        onSelectWorkflow={() => {}}
        onWorkflowContextMenu={() => {}}
      />,
    );

    await waitFor(() => expect(setViewportMock).toHaveBeenCalledWith(savedViewport, { duration: 0 }));
    expect(fitViewMock).not.toHaveBeenCalled();
    expect(setCenterMock).not.toHaveBeenCalled();
  });

  it('preserves the camera across a non-empty workflow snapshot replacement', async () => {
    const workflows = new Map([
      ['wf-a', wf('wf-a', 'running')],
    ]);

    const { rerender } = await renderAndSettleInitialFit({
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

    rerender(
      <WorkflowGraph
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

  it('does not refit when graph data briefly empties after a manual viewport move', async () => {
    const onManualViewport = vi.fn();

    const { rerender } = await renderAndSettleInitialFit({
      workflows: new Map([
        ['wf-a', wf('wf-a', 'running')],
        ['wf-b', wf('wf-b', 'pending')],
      ]),
      selectedWorkflowId: null,
      statusFilters: new Set(),
      onSelectWorkflow: () => {},
      onWorkflowContextMenu: () => {},
      onManualViewport,
    });

    fireEvent.pointerDown(screen.getByTestId('rf__pane'));
    expect(onManualViewport).toHaveBeenCalledTimes(1);

    rerender(
      <WorkflowGraph
        workflows={new Map()}
        selectedWorkflowId={null}
        statusFilters={new Set()}
        onSelectWorkflow={() => {}}
        onWorkflowContextMenu={() => {}}
        onManualViewport={onManualViewport}
      />,
    );
    expect(screen.getByTestId('workflow-node-wf-a')).toBeInTheDocument();
    expect(screen.getByTestId('workflow-node-wf-b')).toBeInTheDocument();
    expect(screen.queryByText('Your plan will appear here.')).not.toBeInTheDocument();
    expect(fitViewMock).not.toHaveBeenCalled();
    expect(setCenterMock).not.toHaveBeenCalled();

    fireEvent.pointerUp(screen.getByTestId('rf__pane'));
    await waitFor(() => expect(screen.getByText('Your plan will appear here.')).toBeInTheDocument());

    rerender(
      <WorkflowGraph
        workflows={new Map([
          ['wf-a', wf('wf-a', 'running')],
          ['wf-c', wf('wf-c', 'pending')],
        ])}
        selectedWorkflowId={null}
        statusFilters={new Set()}
        onSelectWorkflow={() => {}}
        onWorkflowContextMenu={() => {}}
        onManualViewport={onManualViewport}
      />,
    );

    expect(await screen.findByTestId('workflow-node-wf-c')).toBeInTheDocument();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

    // No App-issued camera command is supplied, no selection fallback target is
    // selected, mock nodes are visible, and the watchdog timer is not advanced.
    // A failure here isolates the source to WorkflowGraph's React Flow remount.
    expect(fitViewMock).not.toHaveBeenCalled();
    expect(setCenterMock).not.toHaveBeenCalled();
  });

  it('does not let pre-recovery watchdog misses refit after a manual pan and graph data change', async () => {
    const onManualViewport = vi.fn();

    const { rerender } = await renderAndSettleInitialFit({
      workflows: new Map([
        ['wf-a', wf('wf-a', 'running')],
        ['wf-b', wf('wf-b', 'pending')],
      ]),
      selectedWorkflowId: 'wf-a',
      statusFilters: new Set(),
      onSelectWorkflow: () => {},
      onWorkflowContextMenu: () => {},
      onManualViewport,
    });

    const pane = screen.getByTestId('rf__pane');
    fireEvent.pointerDown(pane);
    fireEvent.pointerUp(pane);
    expect(onManualViewport).toHaveBeenCalled();
    fitViewMock.mockClear();
    setCenterMock.mockClear();
    setViewportMock.mockClear();

    vi.useFakeTimers();
    rerender(
      <WorkflowGraph
        workflows={new Map([
          ['wf-a', wf('wf-a', 'completed')],
          ['wf-b', wf('wf-b', 'pending')],
          ['wf-c', wf('wf-c', 'running')],
        ])}
        selectedWorkflowId="wf-a"
        statusFilters={new Set()}
        onSelectWorkflow={() => {}}
        onWorkflowContextMenu={() => {}}
        onManualViewport={onManualViewport}
      />,
    );

    expect(screen.getByTestId('workflow-node-wf-c')).toBeInTheDocument();
    for (const element of document.querySelectorAll<HTMLElement>('.react-flow__node')) {
      element.style.visibility = 'hidden';
    }

    // No App is mounted and no cameraCommand is supplied, so App command
    // reissue, WorkflowGraph command consumption, and selection fallback are
    // ruled out. Advancing the watchdog isolates the source to blank-render
    // recovery; only the bounded recovery threshold may move the camera.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fitViewMock).not.toHaveBeenCalled();
    expect(setCenterMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fitViewMock).not.toHaveBeenCalled();
    expect(setCenterMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fitViewMock).toHaveBeenCalledTimes(1);
    expect(setCenterMock).not.toHaveBeenCalled();
  });

  it('does not move the camera on a status-only update', async () => {

    const { rerender } = await renderAndSettleInitialFit({
      workflows: new Map([['wf-a', wf('wf-a', 'running')]]),
      selectedWorkflowId: 'wf-a',
      statusFilters: new Set(),
      onSelectWorkflow: () => {},
      onWorkflowContextMenu: () => {},
    });

    // Same topology, only the workflow status changes.
    rerender(
      <WorkflowGraph
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

  it('defers graph object updates while a manual viewport pan is active', async () => {
    const onManualViewport = vi.fn();

    const { rerender } = await renderAndSettleInitialFit({
      workflows: new Map([['wf-a', wf('wf-a', 'running')]]),
      selectedWorkflowId: 'wf-a',
      statusFilters: new Set(),
      onSelectWorkflow: () => {},
      onWorkflowContextMenu: () => {},
      onManualViewport,
    });

    const pane = screen.getByTestId('rf__pane');
    fireEvent.pointerDown(pane);
    expect(onManualViewport).toHaveBeenCalledTimes(1);

    rerender(
      <WorkflowGraph
        workflows={new Map([['wf-a', wf('wf-a', 'completed')]])}
        selectedWorkflowId="wf-a"
        statusFilters={new Set()}
        onSelectWorkflow={() => {}}
        onWorkflowContextMenu={() => {}}
        onManualViewport={onManualViewport}
      />,
    );

    expect(screen.getByTestId('workflow-node-wf-a')).toHaveTextContent('running');
    expect(screen.getByTestId('workflow-node-wf-a')).not.toHaveTextContent('completed');

    fireEvent.pointerUp(pane);
    await waitFor(() => expect(screen.getByTestId('workflow-node-wf-a')).toHaveTextContent('completed'));
  });

  it('pans the workflow viewport from native pane mouse drags', async () => {
    getViewportMock.mockReturnValue({ x: 10, y: 20, zoom: 0.75 });

    await renderAndSettleInitialFit({
      workflows: new Map([['wf-a', wf('wf-a', 'running')]]),
      selectedWorkflowId: 'wf-a',
      statusFilters: new Set(),
      onSelectWorkflow: () => {},
      onWorkflowContextMenu: () => {},
    });

    const pane = screen.getByTestId('rf__pane');
    fireEvent.mouseDown(pane, { clientX: 100, clientY: 100, button: 0 });
    fireEvent.mouseMove(window, { clientX: 130, clientY: 88, buttons: 1 });
    fireEvent.mouseUp(window, { clientX: 130, clientY: 88, button: 0 });

    expect(setViewportMock).toHaveBeenCalledWith({ x: 40, y: 8, zoom: 0.75 }, { duration: 0 });
  });

  it('starts pane drags from React Flow overlay layers inside the pane bounds', async () => {
    getViewportMock.mockReturnValue({ x: 10, y: 20, zoom: 0.75 });

    await renderAndSettleInitialFit({
      workflows: new Map([['wf-a', wf('wf-a', 'running')]]),
      selectedWorkflowId: 'wf-a',
      statusFilters: new Set(),
      onSelectWorkflow: () => {},
      onWorkflowContextMenu: () => {},
    });

    const root = screen.getByTestId('workflow-graph-react-flow');
    const pane = screen.getByTestId('rf__pane');
    vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 200,
      bottom: 200,
      width: 200,
      height: 200,
      toJSON: () => ({}),
    } as DOMRect);
    const overlay = document.createElement('div');
    overlay.className = 'react-flow__renderer';
    root.appendChild(overlay);

    fireEvent.mouseDown(overlay, { clientX: 100, clientY: 100, button: 0 });
    fireEvent.mouseMove(window, { clientX: 130, clientY: 88, buttons: 1 });
    fireEvent.mouseUp(window, { clientX: 130, clientY: 88, button: 0 });

    expect(setViewportMock).toHaveBeenCalledWith({ x: 40, y: 8, zoom: 0.75 }, { duration: 0 });
  });

  it('selects a workflow when clicking its node inside the pane', async () => {
    const onSelectWorkflow = vi.fn();

    await renderAndSettleInitialFit({
      workflows: new Map([['wf-a', wf('wf-a', 'running')]]),
      selectedWorkflowId: null,
      statusFilters: new Set(),
      onSelectWorkflow,
      onWorkflowContextMenu: () => {},
    });

    fireEvent.click(screen.getByTestId('workflow-node-wf-a'));

    expect(onSelectWorkflow).toHaveBeenCalledWith('wf-a');
  });

  it('keeps workflow node clicks selectable without starting a pane drag', async () => {
    const onSelectWorkflow = vi.fn();
    getViewportMock.mockReturnValue({ x: 10, y: 20, zoom: 0.75 });

    await renderAndSettleInitialFit({
      workflows: new Map([['wf-a', wf('wf-a', 'running')]]),
      selectedWorkflowId: 'wf-a',
      statusFilters: new Set(),
      onSelectWorkflow,
      onWorkflowContextMenu: () => {},
    });

    const pane = screen.getByTestId('rf__pane');
    vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 200,
      bottom: 200,
      width: 200,
      height: 200,
      toJSON: () => ({}),
    } as DOMRect);

    const node = screen.getByTestId('workflow-node-wf-a');
    fireEvent.mouseDown(node, { clientX: 100, clientY: 100, button: 0 });
    fireEvent.mouseUp(window, { clientX: 100, clientY: 100, button: 0 });
    fireEvent.click(node);

    expect(onSelectWorkflow).toHaveBeenCalledWith('wf-a');
    expect(setViewportMock).not.toHaveBeenCalled();
  });

  it('starts pane drags from workflow node surfaces after pointer movement', async () => {
    getViewportMock.mockReturnValue({ x: 10, y: 20, zoom: 0.75 });

    await renderAndSettleInitialFit({
      workflows: new Map([['wf-a', wf('wf-a', 'running')]]),
      selectedWorkflowId: 'wf-a',
      statusFilters: new Set(),
      onSelectWorkflow: () => {},
      onWorkflowContextMenu: () => {},
    });

    const pane = screen.getByTestId('rf__pane');
    vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 200,
      bottom: 200,
      width: 200,
      height: 200,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.mouseDown(screen.getByTestId('workflow-node-wf-a'), { clientX: 100, clientY: 100, button: 0 });
    fireEvent.mouseMove(window, { clientX: 102, clientY: 101, buttons: 1 });
    expect(setViewportMock).not.toHaveBeenCalled();
    fireEvent.mouseMove(window, { clientX: 130, clientY: 88, buttons: 1 });
    fireEvent.mouseUp(window, { clientX: 130, clientY: 88, button: 0 });

    expect(setViewportMock).toHaveBeenCalledWith({ x: 40, y: 8, zoom: 0.75 }, { duration: 0 });
  });

  it('clears pane-pan inline transforms after drag and restores fit from controls', async () => {
    getViewportMock.mockReturnValue({ x: 10, y: 20, zoom: 0.75 });

    await renderAndSettleInitialFit({
      workflows: new Map([['wf-a', wf('wf-a', 'running')]]),
      selectedWorkflowId: 'wf-a',
      statusFilters: new Set(),
      onSelectWorkflow: () => {},
      onWorkflowContextMenu: () => {},
    });

    const viewport = screen.getByTestId('workflow-graph-react-flow').querySelector('.react-flow__viewport');
    expect(viewport).not.toBeNull();

    const pane = screen.getByTestId('rf__pane');
    fireEvent.mouseDown(pane, { clientX: 100, clientY: 100, button: 0 });
    fireEvent.mouseMove(window, { clientX: 130, clientY: 88, buttons: 1 });
    await waitFor(() => expect((viewport as HTMLElement).style.transform).not.toBe(''));
    fireEvent.mouseUp(window, { clientX: 130, clientY: 88, button: 0 });
    await waitFor(() => expect((viewport as HTMLElement).style.transform).toBe(''));

    fitViewMock.mockClear();
    fireEvent.click(screen.getByTestId('rf__fit-view'));
    expect(fitViewMock).toHaveBeenCalledTimes(1);
    expect(fitViewMock).toHaveBeenCalledWith({ padding: 0.2 });
    expect((viewport as HTMLElement).style.transform).toBe('');
  });

  it('centers the selected workflow on a centerSelection command, preserving the current zoom', async () => {
    const issuer = createGraphCameraCommandIssuer();
    getZoomMock.mockReturnValue(1.75);

    const { rerender } = await renderAndSettleInitialFit({
      workflows: new Map([['wf-a', wf('wf-a', 'running')]]),
      selectedWorkflowId: 'wf-a',
      statusFilters: new Set(),
      onSelectWorkflow: () => {},
      onWorkflowContextMenu: () => {},
    });

    rerender(
      <WorkflowGraph
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
      workflows: new Map([['wf-a', wf('wf-a', 'running')]]),
      selectedWorkflowId: 'wf-a',
      statusFilters: new Set(),
      onSelectWorkflow: () => {},
      onWorkflowContextMenu: () => {},
    });

    rerender(
      <WorkflowGraph
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
      workflows: new Map([['wf-a', wf('wf-a', 'running')]]),
      selectedWorkflowId: 'wf-a',
      statusFilters: new Set(),
      onSelectWorkflow: () => {},
      onWorkflowContextMenu: () => {},
    });

    rerender(
      <WorkflowGraph
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
      workflows: new Map([['wf-a', wf('wf-a', 'running')]]),
      selectedWorkflowId: 'wf-a',
      statusFilters: new Set(),
      onSelectWorkflow: () => {},
      onWorkflowContextMenu: () => {},
    });

    const props = {
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

  it('uses a scoped bounded watchdog for React Flow recovery', () => {
    const reactFlowBlock = source.slice(
      source.indexOf('<ReactFlow'),
      source.indexOf('</ReactFlow>'),
    );
    expect(source).toContain('const WATCHDOG_RECOVERY_MISS_COUNT = 3;');
    expect(source).toContain('setFlowInstanceKey((key) => key + 1)');
    expect(reactFlowBlock).toContain('key={flowInstanceKey}');
    expect(source).toContain('graphRootRef');
    expect(source).toContain('graphRootRef.current');
    expect(source).toContain('root.querySelectorAll');
  });
});
