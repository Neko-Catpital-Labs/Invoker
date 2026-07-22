/**
 * Regression: a browser surface (Needs Attention / Workflows) must not
 * re-center or re-fit the task graph on every live update.
 *
 * The browser-surface camera effect in App used to depend on
 * `displayedSelectedWorkflowGraph`, which is a brand-new object on every streamed
 * task delta. Each tick therefore re-issued fitInitial + centerSelection and
 * yanked the viewport back to the selection while the user was panning the graph.
 * The effect now keys off stable surface-entry signals, so live updates and
 * selection changes while already on the surface issue no camera command.
 *
 * The effect is shared by every non-home browser surface (its guard only excludes
 * `home`), so this drives the Workflows surface — the jsdom harness cannot render
 * the Needs Attention surface (a separate, pre-existing empty-surface effect loop
 * unrelated to this fix), and the mechanism under test is identical either way.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createMockInvoker, makeUITask, type MockInvoker } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../types.js';
import type { GraphCameraCommand } from '../lib/graph-camera.js';
import * as ReactFlowModule from '@xyflow/react';

// vitest hoists vi.mock above imports and its factory cannot close over
// top-level bindings, so the mock module is loaded dynamically here — a test
// module-loading boundary, the sanctioned exception to static-import-only.
const workflowGraphSpy = vi.hoisted(() => ({
  commands: [] as Array<GraphCameraCommand | null | undefined>,
  reset() {
    this.commands.length = 0;
  },
}));

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

vi.mock('../components/WorkflowGraph.js', async () => {
  const actual = await vi.importActual<typeof import('../components/WorkflowGraph.js')>('../components/WorkflowGraph.js');
  return {
    ...actual,
    WorkflowGraph(props: Parameters<typeof actual.WorkflowGraph>[0]) {
      workflowGraphSpy.commands.push(props.cameraCommand);
      return actual.WorkflowGraph(props);
    },
  };
});

const fitViewMock = (ReactFlowModule as unknown as { __fitViewMock: Mock }).__fitViewMock;
const setCenterMock = (ReactFlowModule as unknown as { __setCenterMock: Mock }).__setCenterMock;
const setViewportMock = (ReactFlowModule as unknown as { __setViewportMock: Mock }).__setViewportMock;
const getZoomMock = (ReactFlowModule as unknown as { __getZoomMock: Mock }).__getZoomMock;
const getViewportMock = (ReactFlowModule as unknown as { __getViewportMock: Mock }).__getViewportMock;

// App must be imported AFTER vi.mock registers so it binds the mocked react-flow.
const { App } = await import('../App.js');

const workflows: WorkflowMeta[] = [
  { id: 'wf-a', name: 'Alpha Workflow', status: 'running' },
];

const tasks = [
  makeUITask({ id: 'wf-a/one', description: 'Task One', workflowId: 'wf-a', status: 'running', command: 'echo a' }),
  makeUITask({ id: 'wf-a/two', description: 'Task Two', workflowId: 'wf-a', status: 'pending', command: 'echo b', dependencies: ['wf-a/one'] }),
];

/** Yield past `count` animation frames so scheduled camera moves can run. */
async function flushFrames(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const { promise, resolve } = Promise.withResolvers<void>();
    requestAnimationFrame(() => resolve());
    await promise;
  }
}

/**
 * Drain the nested requestAnimationFrame chains the initial framing schedules
 * (fitInitial + centerSelection re-issue commands, each consumed a frame later),
 * returning once the camera-move count holds steady across several frames. This
 * is what makes the post-update assertion deterministic: no late initial move
 * can leak past the point where we start measuring.
 */
async function settleCamera(): Promise<void> {
  let stable = 0;
  let prev = setCenterMock.mock.calls.length + fitViewMock.mock.calls.length;
  for (let i = 0; i < 40 && stable < 4; i += 1) {
    await flushFrames(1);
    const total = setCenterMock.mock.calls.length + fitViewMock.mock.calls.length;
    if (total === prev) {
      stable += 1;
    } else {
      stable = 0;
      prev = total;
    }
  }
}

describe('Browser-surface camera (component)', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
    fitViewMock.mockClear();
    setCenterMock.mockClear();
    setViewportMock.mockClear();
    getZoomMock.mockReset();
    getZoomMock.mockReturnValue(1);
    getViewportMock.mockReset();
    getViewportMock.mockReturnValue({ x: 0, y: 0, zoom: 1 });
    workflowGraphSpy.reset();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('does not re-center or re-fit on a live task update that leaves selection and topology unchanged', async () => {
    mock.setTasks(tasks, workflows);
    render(<App />);

    // Open the Workflows browser surface and select a task node. The initial
    // framing is intentionally drained below instead of asserted as a setup
    // requirement; jsdom can coalesce that camera move differently under the
    // full parallel Vitest run.
    fireEvent.click(await screen.findByTestId('sidebar-workflows'));
    await screen.findByTestId('selected-workflow-mini-dag');
    fireEvent.click(await screen.findByTestId('rf__node-wf-a/one'));

    // Wait for every initial framing frame to drain, then measure from a clean
    // baseline so only update-triggered camera moves count.
    await settleCamera();
    fitViewMock.mockClear();
    setCenterMock.mockClear();

    // A routine streamed status tick: an existing task's fields change (no new or
    // removed node, and the selection is untouched). The tasks map identity churns
    // but nothing about navigation changed.
    mock.fireDelta({
      type: 'updated',
      taskId: 'wf-a/two',
      changes: { description: 'Task Two live' },
      taskStateVersion: 2,
      previousTaskStateVersion: 1,
    });

    // Wait until the update propagated and re-rendered (the node label updates),
    // then drain the frames any (buggy) re-issued camera command would use.
    await waitFor(() => expect(screen.getAllByText('Task Two live').length).toBeGreaterThan(0));
    await flushFrames(6);

    // The camera must not move on a live update that changed no selection.
    expect(setCenterMock).not.toHaveBeenCalled();
    expect(fitViewMock).not.toHaveBeenCalled();
  });

  it('does not re-center or re-fit when the selected task changes while already on a browser surface', async () => {
    mock.setTasks(tasks, workflows);
    render(<App />);

    fireEvent.click(await screen.findByTestId('sidebar-workflows'));
    await screen.findByTestId('selected-workflow-mini-dag');
    fireEvent.click(await screen.findByTestId('rf__node-wf-a/one'));
    await settleCamera();
    fitViewMock.mockClear();
    setCenterMock.mockClear();

    fireEvent.click(screen.getByTestId('rf__node-wf-a/two'));

    await waitFor(() => {
      expect(screen.getByTestId('workflow-inspector-title')).toHaveTextContent('Task Two');
    });
    await flushFrames(6);

    expect(setCenterMock).not.toHaveBeenCalled();
    expect(fitViewMock).not.toHaveBeenCalled();
  });

  it('clicking the left-nav home icon returns to the workflow graph and issues the Home fit command', async () => {
    mock.setTasks(tasks, workflows);
    render(<App />);

    fireEvent.click(await screen.findByTestId('sidebar-workflows'));
    await screen.findByTestId('selected-workflow-mini-dag');
    await settleCamera();
    fitViewMock.mockClear();
    setCenterMock.mockClear();
    workflowGraphSpy.reset();

    fireEvent.click(screen.getByTestId('sidebar-planning'));

    await waitFor(() => expect(screen.getByTestId('workflow-node-wf-a')).toBeInTheDocument());
    await waitFor(() => {
      const matchingCommands = workflowGraphSpy.commands.filter((command): command is GraphCameraCommand => (
        command?.kind === 'fitInitial'
        && command.scope === 'workflow'
        && command.reason === 'sidebar-planning'
      ));
      expect(matchingCommands.length).toBeGreaterThan(0);
    });
    await flushFrames(4);

    expect(fitViewMock).toHaveBeenCalled();
  });

  it('returns to the workflow graph from the planning-home chat rail by restoring the saved viewport instead of fitting', async () => {
    const savedViewport = { x: -360, y: 144, zoom: 0.68 };
    mock.setTasks([], workflows);
    render(<App />);

    // The workflow graph lives on the `planning` surface; App boots on `home`
    // (the planning chat rail), so open the graph and let the first-fit settle.
    fireEvent.click(await screen.findByTestId('sidebar-planning'));
    await screen.findByTestId('workflow-node-wf-a');
    await settleCamera();

    // Simulate the user having panned/zoomed the graph before leaving it.
    getViewportMock.mockReturnValue(savedViewport);

    fireEvent.click(screen.getByTestId('sidebar-home'));
    await screen.findByTestId('planning-session-rail');

    fitViewMock.mockClear();
    setCenterMock.mockClear();
    setViewportMock.mockClear();
    workflowGraphSpy.reset();

    fireEvent.click(screen.getByTestId('sidebar-planning'));

    await waitFor(() => expect(screen.getByTestId('workflow-node-wf-a')).toBeInTheDocument());
    await waitFor(() => expect(setViewportMock).toHaveBeenCalledWith(savedViewport, { duration: 0 }));
    await flushFrames(4);

    expect(fitViewMock).not.toHaveBeenCalled();
    expect(setCenterMock).not.toHaveBeenCalled();
    expect(workflowGraphSpy.commands.some((command) => (
      command?.kind === 'fitInitial'
      && command.scope === 'workflow'
      && command.reason === 'sidebar-planning'
    ))).toBe(false);
  });
});
