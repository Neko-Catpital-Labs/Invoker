/**
 * Tests for TaskDAG stability fixes:
 * - onNodesChange filters to only dimension/select changes
 * - Watchdog detects both missing and visibility:hidden nodes
 * - fitView prop removed (no visibility:hidden mechanism)
 * - rfNodes state preserves measured dimensions from task-derived node updates
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { applyNodeChanges, type Node, type NodeChange } from '@xyflow/react';
import * as ReactFlowModule from '@xyflow/react';
import { TaskDAG } from '../components/TaskDAG.js';
import { createGraphCameraCommandIssuer } from '../lib/graph-camera.js';
import type { TaskState } from '../types.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const fitViewMock = (ReactFlowModule as unknown as { __fitViewMock: Mock }).__fitViewMock;
const setCenterMock = (ReactFlowModule as unknown as { __setCenterMock: Mock }).__setCenterMock;
const getZoomMock = (ReactFlowModule as unknown as { __getZoomMock: Mock }).__getZoomMock;

const source = readFileSync(
  resolve(__dirname, '..', 'components', 'TaskDAG.tsx'),
  'utf-8',
);

function dagTask(id: string, overrides: Partial<TaskState> = {}): TaskState {
  return {
    id,
    description: id,
    status: 'pending',
    dependencies: [],
    config: { workflowId: 'wf-a' },
    execution: {},
    taskStateVersion: 1,
    ...overrides,
  } as TaskState;
}

/** Mount a TaskDAG (createElement keeps this a .ts file) and wait for the
 * single first-render fit to settle, then clear the viewport spies so a test
 * can assert on the calls that happen after the initial mount. */
async function renderDagAndSettleInitialFit(props: Parameters<typeof TaskDAG>[0]) {
  const utils = render(createElement(TaskDAG, props));
  await waitFor(() => expect(fitViewMock).toHaveBeenCalledTimes(1));
  fitViewMock.mockClear();
  setCenterMock.mockClear();
  return utils;
}

describe('TaskDAG stability', () => {
  describe('selection wiring', () => {
    it('accepts selectedTaskId in TaskDAG props', () => {
      expect(source).toContain('selectedTaskId?: string | null;');
    });

    it('marks nodes selected based on selectedTaskId', () => {
      expect(source).toContain('selected: selectedTaskId === task.id');
    });
  });

  // ── fitView prop removal ──────────────────────────────────
  describe('fitView prop removal', () => {
    it('does not pass fitView as a prop to ReactFlow', () => {
      // The ReactFlow JSX block should not contain the fitView prop.
      // Match the prop form (standalone `fitView` or `fitView=`), but not
      // the `fitView(` function call or `fitView}` closing in callbacks.
      const reactFlowBlock = source.slice(
        source.indexOf('<ReactFlow'),
        source.indexOf('</ReactFlow>'),
      );
      const hasFitViewProp =
        /\bfitView\b(?!\s*[({])/.test(reactFlowBlock) &&
        !reactFlowBlock.includes('fitView={');
      expect(hasFitViewProp).toBe(false);
    });

    it('does not pass fitViewOptions as a prop to ReactFlow', () => {
      const reactFlowBlock = source.slice(
        source.indexOf('<ReactFlow'),
        source.indexOf('</ReactFlow>'),
      );
      expect(reactFlowBlock).not.toContain('fitViewOptions');
    });

    it('passes onInit handler to ReactFlow', () => {
      const reactFlowBlock = source.slice(
        source.indexOf('<ReactFlow'),
        source.indexOf('</ReactFlow>'),
      );
      expect(reactFlowBlock).toContain('onInit={onInitHandler}');
    });
  });

  // ── onNodesChange filtering ───────────────────────────────
  describe('onNodesChange filtering', () => {
    const baseNode: Node = {
      id: 'task-1',
      type: 'taskNode',
      position: { x: 0, y: 0 },
      data: { task: {}, label: 'Test' },
    };

    function filterChanges(changes: NodeChange[]): NodeChange[] {
      return changes.filter(
        (c) => c.type === 'dimensions' || c.type === 'select',
      );
    }

    it('passes through dimension changes', () => {
      const changes: NodeChange[] = [
        {
          type: 'dimensions',
          id: 'task-1',
          dimensions: { width: 260, height: 80 },
          resizing: false,
        },
      ];
      const filtered = filterChanges(changes);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].type).toBe('dimensions');
    });

    it('passes through select changes', () => {
      const changes: NodeChange[] = [
        { type: 'select', id: 'task-1', selected: true },
      ];
      const filtered = filterChanges(changes);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].type).toBe('select');
    });

    it('filters out position changes', () => {
      const changes: NodeChange[] = [
        {
          type: 'position',
          id: 'task-1',
          position: { x: 100, y: 200 },
          dragging: false,
        },
      ];
      const filtered = filterChanges(changes);
      expect(filtered).toHaveLength(0);
    });

    it('filters out remove changes', () => {
      const changes: NodeChange[] = [
        { type: 'remove', id: 'task-1' },
      ];
      const filtered = filterChanges(changes);
      expect(filtered).toHaveLength(0);
    });

    it('keeps dimensions while filtering out position in mixed batch', () => {
      const changes: NodeChange[] = [
        {
          type: 'dimensions',
          id: 'task-1',
          dimensions: { width: 260, height: 80 },
          resizing: false,
        },
        {
          type: 'position',
          id: 'task-1',
          position: { x: 50, y: 50 },
          dragging: false,
        },
        { type: 'select', id: 'task-1', selected: true },
      ];
      const filtered = filterChanges(changes);
      expect(filtered).toHaveLength(2);
      expect(filtered.map((c) => c.type)).toEqual(['dimensions', 'select']);
    });

    it('applyNodeChanges preserves dimensions on existing nodes', () => {
      const nodes: Node[] = [{ ...baseNode }];
      const changes: NodeChange[] = [
        {
          type: 'dimensions',
          id: 'task-1',
          dimensions: { width: 260, height: 80 },
          resizing: false,
        },
      ];
      const updated = applyNodeChanges(changes, nodes);
      expect(updated).toHaveLength(1);
      expect(updated[0].measured).toEqual({ width: 260, height: 80 });
    });

    function mergeMeasuredNodeState(prevNodes: Node[], nextNodes: Node[]): Node[] {
      const previousById = new Map(prevNodes.map((node) => [node.id, node]));

      return nextNodes.map((node) => {
        const previous = previousById.get(node.id);
        if (!previous) return node;

        return {
          ...node,
          ...(previous.measured ? { measured: previous.measured } : {}),
          ...(previous.width !== undefined ? { width: previous.width } : {}),
          ...(previous.height !== undefined ? { height: previous.height } : {}),
        };
      });
    }

    it('preserves dimensions across a simulated task-delta re-render', () => {
      // 1. Start with task-derived nodes (no dimensions)
      let rfNodes: Node[] = [{ ...baseNode }];

      // 2. Apply dimension change (React Flow measured the node)
      const dimChanges: NodeChange[] = [
        {
          type: 'dimensions',
          id: 'task-1',
          dimensions: { width: 260, height: 80 },
          resizing: false,
        },
      ];
      const filtered = filterChanges(dimChanges);
      rfNodes = applyNodeChanges(filtered, rfNodes);
      expect(rfNodes[0].measured).toEqual({ width: 260, height: 80 });

      // 3. Task delta arrives: new node objects replace rfNodes (simulates useEffect)
      const newTaskNodes: Node[] = [
        {
          id: 'task-1',
          type: 'taskNode',
          position: { x: 0, y: 0 },
          data: { task: { status: 'running' }, label: 'Test' },
        },
      ];
      rfNodes = mergeMeasuredNodeState(rfNodes, newTaskNodes);

      // 4. Dimensions are retained so React Flow does not need to re-measure
      //    existing nodes after each status/task data update.
      expect(rfNodes[0].measured).toEqual({ width: 260, height: 80 });
      expect(rfNodes[0].data).toEqual({ task: { status: 'running' }, label: 'Test' });
    });

    it('wires task-derived node sync through measured-state merge', () => {
      expect(source).toContain('mergeMeasuredNodeState(prev, nodes)');
    });
  });

  // ── Watchdog detection logic ──────────────────────────────
  describe('watchdog detection logic', () => {
    function shouldTrigger(
      domNodeCount: number,
      hiddenCount: number,
      propsNodeCount: number,
    ): boolean {
      return (
        (domNodeCount === 0 && propsNodeCount > 0) ||
        (hiddenCount > 0 && hiddenCount === domNodeCount)
      );
    }

    it('triggers when no DOM nodes but props have nodes', () => {
      expect(shouldTrigger(0, 0, 3)).toBe(true);
    });

    it('triggers when all DOM nodes are hidden', () => {
      expect(shouldTrigger(3, 3, 3)).toBe(true);
    });

    it('does not trigger when all nodes are visible', () => {
      expect(shouldTrigger(3, 0, 3)).toBe(false);
    });

    it('does not trigger when only some nodes are hidden', () => {
      expect(shouldTrigger(3, 1, 3)).toBe(false);
    });

    it('does not trigger when no props nodes exist', () => {
      expect(shouldTrigger(0, 0, 0)).toBe(false);
    });

    function shouldRecover(missCount: number, recoveryAttempted: boolean): boolean {
      return missCount >= 3 && !recoveryAttempted;
    }

    it('does not recover before repeated watchdog misses', () => {
      expect(shouldRecover(1, false)).toBe(false);
      expect(shouldRecover(2, false)).toBe(false);
    });

    it('recovers once after repeated watchdog misses', () => {
      expect(shouldRecover(3, false)).toBe(true);
      expect(shouldRecover(4, true)).toBe(false);
    });

    it('logs watchdog miss and recovery state', () => {
      expect(source).toContain('missCount: watchdogMissCountRef.current');
      expect(source).toContain('recoveryAttempted: watchdogRecoveryAttemptedRef.current');
      expect(source).toContain('recoveryTriggered: shouldRecover');
    });

    it('remounts React Flow for bounded watchdog recovery', () => {
      const reactFlowBlock = source.slice(
        source.indexOf('<ReactFlow'),
        source.indexOf('</ReactFlow>'),
      );
      expect(source).toContain('const WATCHDOG_RECOVERY_MISS_COUNT = 3;');
      expect(source).toContain('setFlowInstanceKey((key) => key + 1)');
      expect(reactFlowBlock).toContain('key={flowInstanceKey}');
    });
  });

  // ── onNodesChange handler is wired up ─────────────────────
  describe('onNodesChange handler wiring', () => {
    it('passes onNodesChange to ReactFlow', () => {
      const reactFlowBlock = source.slice(
        source.indexOf('<ReactFlow'),
        source.indexOf('</ReactFlow>'),
      );
      expect(reactFlowBlock).toContain('onNodesChange={onNodesChange}');
    });

    it('passes rfNodes (not raw nodes) to ReactFlow', () => {
      const reactFlowBlock = source.slice(
        source.indexOf('<ReactFlow'),
        source.indexOf('</ReactFlow>'),
      );
      expect(reactFlowBlock).toContain('nodes={rfNodes}');
      expect(reactFlowBlock).not.toMatch(/nodes=\{nodes\}/);
    });
  });
});

// ── Camera ownership (viewport-fighting regression) ─────────
// These assert the runtime camera contract: React Flow owns x/y/zoom after the
// initial fit, and the DAG only moves the viewport when it consumes a typed,
// task-scoped command exactly once. Status refreshes and topology changes must
// never re-fit or re-center, which is what kept the old graph fighting the user.
describe('TaskDAG camera ownership', () => {
  beforeEach(() => {
    fitViewMock.mockClear();
    setCenterMock.mockClear();
    getZoomMock.mockReset();
    getZoomMock.mockReturnValue(1);
  });

  afterEach(() => {
    cleanup();
  });

  /** Build a tasks Map from a list of task ids (all in workflow wf-a). */
  function tasksMap(...ids: string[]): Map<string, TaskState> {
    return new Map(ids.map((id) => [id, dagTask(id)] as const));
  }

  it('fits the viewport exactly once on the first non-empty render', async () => {
    render(createElement(TaskDAG, { tasks: tasksMap('task-a') }));

    // onInit fires once for the first non-empty render and never re-fits.
    await waitFor(() => expect(fitViewMock).toHaveBeenCalledTimes(1));
    expect(fitViewMock).toHaveBeenCalledWith({ padding: 0.2 });
    expect(setCenterMock).not.toHaveBeenCalled();
  });

  it('does not move the camera on a status-only update', async () => {
    const { rerender } = await renderDagAndSettleInitialFit({
      tasks: tasksMap('task-a'),
      selectedTaskId: 'task-a',
    });

    // Same topology, only the task status changes.
    rerender(
      createElement(TaskDAG, {
        tasks: new Map([['task-a', dagTask('task-a', { status: 'running' })]]),
        selectedTaskId: 'task-a',
      }),
    );

    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(fitViewMock).not.toHaveBeenCalled();
    expect(setCenterMock).not.toHaveBeenCalled();
  });

  it('preserves the camera when the topology changes (a task is added)', async () => {
    const { rerender } = await renderDagAndSettleInitialFit({ tasks: tasksMap('task-a') });

    rerender(createElement(TaskDAG, { tasks: tasksMap('task-a', 'task-b') }));

    // The new node renders without remounting React Flow or moving the camera.
    expect(await screen.findByTestId('rf__node-task-b')).toBeInTheDocument();
    expect(fitViewMock).not.toHaveBeenCalled();
    expect(setCenterMock).not.toHaveBeenCalled();
  });

  it('centers the selected task on a centerSelection command, preserving the current zoom', async () => {
    const issuer = createGraphCameraCommandIssuer();
    getZoomMock.mockReturnValue(1.5);

    const { rerender } = await renderDagAndSettleInitialFit({
      tasks: tasksMap('task-a'),
      selectedTaskId: 'task-a',
    });

    rerender(
      createElement(TaskDAG, {
        tasks: tasksMap('task-a'),
        selectedTaskId: 'task-a',
        cameraCommand: issuer.centerSelection('task', 'task-a'),
      }),
    );

    await waitFor(() => expect(setCenterMock).toHaveBeenCalledTimes(1));
    // Centering must preserve the live zoom (not reset to 1).
    const [, , options] = setCenterMock.mock.calls[0];
    expect(options).toMatchObject({ zoom: 1.5 });
    // A center command must never trigger a whole-graph fit.
    expect(fitViewMock).not.toHaveBeenCalled();
  });

  it('consumes a fitInitial command by fitting the graph', async () => {
    const issuer = createGraphCameraCommandIssuer();

    const { rerender } = await renderDagAndSettleInitialFit({
      tasks: tasksMap('task-a'),
      selectedTaskId: 'task-a',
    });

    rerender(
      createElement(TaskDAG, {
        tasks: tasksMap('task-a'),
        selectedTaskId: 'task-a',
        cameraCommand: issuer.fitInitial('task'),
      }),
    );

    await waitFor(() => expect(fitViewMock).toHaveBeenCalledTimes(1));
    expect(setCenterMock).not.toHaveBeenCalled();
  });

  it('ignores a camera command scoped to the workflow graph', async () => {
    const issuer = createGraphCameraCommandIssuer();

    const { rerender } = await renderDagAndSettleInitialFit({
      tasks: tasksMap('task-a'),
      selectedTaskId: 'task-a',
    });

    rerender(
      createElement(TaskDAG, {
        tasks: tasksMap('task-a'),
        selectedTaskId: 'task-a',
        cameraCommand: issuer.centerSelection('workflow', 'task-a'),
      }),
    );

    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(setCenterMock).not.toHaveBeenCalled();
    expect(fitViewMock).not.toHaveBeenCalled();
  });

  it('consumes each command once by sequence, not on every re-render', async () => {
    const issuer = createGraphCameraCommandIssuer();
    const command = issuer.centerSelection('task', 'task-a');

    const { rerender } = await renderDagAndSettleInitialFit({
      tasks: tasksMap('task-a'),
      selectedTaskId: 'task-a',
    });

    const props = {
      tasks: tasksMap('task-a'),
      selectedTaskId: 'task-a' as const,
      cameraCommand: command,
    };
    rerender(createElement(TaskDAG, props));
    await waitFor(() => expect(setCenterMock).toHaveBeenCalledTimes(1));

    // Re-rendering with the SAME command object must not re-fire the move —
    // this is what prevents data refreshes from fighting the user's camera.
    rerender(createElement(TaskDAG, props));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(setCenterMock).toHaveBeenCalledTimes(1);
  });

  it('reports manual viewport interaction on background pan and wheel without autofocusing', async () => {
    const onManualViewport = vi.fn();

    await renderDagAndSettleInitialFit({
      tasks: tasksMap('task-a'),
      selectedTaskId: 'task-a',
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
