import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { WorkflowMeta, WorkflowStatus } from '../types.js';
import type { GraphCameraCommand } from '../lib/graph-camera.js';
import type { WorkflowCoreActivity } from '../lib/workflow-core-activity.js';
import { deriveWorkflowGraph, layoutWorkflowGraph, type WorkflowGraphEdge } from '../lib/workflow-graph.js';
import { WorkflowNode } from './WorkflowNode.js';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  applyNodeChanges,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

interface WorkflowGraphProps {
  workflows: Map<string, WorkflowMeta>;
  selectedWorkflowId: string | null;
  /**
   * Latest typed camera command. The graph consumes each command once by
   * sequence; commands scoped to other graphs are ignored. React Flow keeps
   * owning x/y/zoom locally — this is intent, not a controlled viewport.
   */
  cameraCommand?: GraphCameraCommand | null;
  statusFilters: Set<WorkflowStatus>;
  coreActivityByWorkflow?: Map<string, WorkflowCoreActivity>;
  onSelectWorkflow: (workflowId: string) => void;
  onWorkflowContextMenu: (event: ReactMouseEvent, workflowId: string) => void;
  /** Fired when the user manually pans or zooms the viewport. */
  onManualViewport?: () => void;
}

interface WorkflowNodeData extends Record<string, unknown> {
  workflow: WorkflowMeta;
  selected: boolean;
  dimmed: boolean;
  coreActivity?: WorkflowCoreActivity;
  onSelect?: () => void;
}

interface GraphViewport {
  x: number;
  y: number;
  zoom: number;
}

const nodeTypes = {
  workflowNode: WorkflowFlowNode,
};
const WATCHDOG_RECOVERY_MISS_COUNT = 3;

interface PanePan {
  startClientX: number;
  startClientY: number;
  startViewport: GraphViewport;
  targetViewport: GraphViewport;
  visualViewport: GraphViewport;
  viewportElement: HTMLElement | null;
  animationFrame: number;
  active: boolean;
  hasMoved: boolean;
  warmupFrame: number;
}

interface PanePointerPan extends PanePan {
  pointerId: number;
}

const PANE_PAN_BLOCK_SELECTOR = [
  '.react-flow__controls',
  'a',
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
].join(',');

function shouldStartPanePan(
  root: HTMLElement | null,
  target: EventTarget | null,
  clientX: number,
  clientY: number,
): boolean {
  if (!root) return false;
  const pane = root.querySelector<HTMLElement>('.react-flow__pane');
  if (!pane) return false;

  const targetElement = target instanceof Element ? target : null;
  if (targetElement) {
    if (!root.contains(targetElement)) return false;
    if (targetElement.closest(PANE_PAN_BLOCK_SELECTOR)) return false;
    if (targetElement.closest('.react-flow__pane')) return true;
  }

  const rect = pane.getBoundingClientRect();
  return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
}

function createPanePan(
  startClientX: number,
  startClientY: number,
  startViewport: GraphViewport,
  viewportElement: HTMLElement | null,
): PanePan {
  return {
    startClientX,
    startClientY,
    startViewport,
    targetViewport: { ...startViewport },
    visualViewport: { ...startViewport },
    viewportElement,
    animationFrame: 0,
    active: true,
    hasMoved: false,
    warmupFrame: 0,
  };
}

function getPanePanViewport(pan: PanePan, clientX: number, clientY: number): GraphViewport {
  return {
    x: pan.startViewport.x + clientX - pan.startClientX,
    y: pan.startViewport.y + clientY - pan.startClientY,
    zoom: pan.startViewport.zoom,
  };
}

function applyViewportTransform(viewportElement: HTMLElement | null, viewport: GraphViewport): void {
  viewportElement?.style.setProperty(
    'transform',
    `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
  );
}

function clearViewportInlineTransform(viewportElement: HTMLElement | null): void {
  viewportElement?.style.removeProperty('transform');
}

function schedulePanePanAnimation(pan: PanePan): void {
  if (pan.animationFrame !== 0) return;

  const step = () => {
    pan.animationFrame = 0;
    const dx = pan.targetViewport.x - pan.visualViewport.x;
    const dy = pan.targetViewport.y - pan.visualViewport.y;
    const settled = Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5;

    if (settled && pan.active) {
      pan.warmupFrame += 1;
      const activePulse = ((pan.warmupFrame % 4) + 1) * 0.25;
      const warmupViewport = {
        ...pan.targetViewport,
        // Keep a compositor-visible transform changing while update IPC competes with mousemove delivery.
        x: pan.targetViewport.x + (pan.hasMoved ? activePulse : Math.min(pan.warmupFrame, 20) * 0.05),
      };
      applyViewportTransform(pan.viewportElement, warmupViewport);
      pan.animationFrame = requestAnimationFrame(step);
      return;
    }

    pan.visualViewport = settled
      ? { ...pan.targetViewport }
      : {
          x: pan.visualViewport.x + dx * 0.4,
          y: pan.visualViewport.y + dy * 0.4,
          zoom: pan.targetViewport.zoom,
        };
    applyViewportTransform(pan.viewportElement, pan.visualViewport);

    if (!settled) {
      pan.animationFrame = requestAnimationFrame(step);
    }
  };

  pan.animationFrame = requestAnimationFrame(step);
}

function mergeMeasuredNodeState(
  prevNodes: Node<WorkflowNodeData>[],
  nextNodes: Node<WorkflowNodeData>[],
): Node<WorkflowNodeData>[] {
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

function workflowEdgeVisual(kind: WorkflowGraphEdge['kind']): {
  stroke: string;
  strokeWidth: number;
  strokeDasharray?: string;
  ariaLabel: string;
} {
  if (kind === 'detached') {
    return {
      stroke: 'rgba(217,119,6,0.58)',
      strokeWidth: 1.5,
      strokeDasharray: '5 6',
      ariaLabel: 'Detached workflow lineage',
    };
  }
  if (kind === 'historical') {
    return {
      stroke: 'rgba(245,158,11,0.5)',
      strokeWidth: 1.5,
      strokeDasharray: '6 6',
      ariaLabel: 'Historical workflow dependency',
    };
  }
  return {
    stroke: 'rgba(148,163,184,0.55)',
    strokeWidth: 2,
    ariaLabel: 'Active workflow dependency',
  };
}

function WorkflowFlowNode({ data }: NodeProps<Node<WorkflowNodeData>>): JSX.Element {
  return (
    <div className="relative">
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2 !w-2 !border !border-slate-400 !bg-background"
        isConnectable={false}
      />
      <WorkflowNode
        workflow={data.workflow}
        selected={data.selected}
        dimmed={data.dimmed}
        coreActivity={data.coreActivity}
        onClick={() => data.onSelect?.()}
        onContextMenu={() => {}}
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !border !border-slate-400 !bg-background"
        isConnectable={false}
      />
    </div>
  );
}

function WorkflowGraphInner({
  workflows,
  selectedWorkflowId,
  cameraCommand,
  statusFilters,
  coreActivityByWorkflow,
  onSelectWorkflow,
  onWorkflowContextMenu,
  onManualViewport,
}: WorkflowGraphProps): JSX.Element {
  const { fitView, setCenter, getZoom, getViewport, setViewport } = useReactFlow();
  const graphRootRef = useRef<HTMLDivElement>(null);
  const reportedVisibleRef = useRef(false);
  const lastHandledCameraSeqRef = useRef(0);
  const initFitFrameRef = useRef(0);
  const initialFitCompletedRef = useRef(false);
  const watchdogMissCountRef = useRef(0);
  const watchdogRecoveryAttemptedRef = useRef(false);
  const emptyGraphClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewportGestureActiveRef = useRef(false);
  const pendingGestureNodesRef = useRef<Node<WorkflowNodeData>[] | null>(null);
  const pendingGestureEdgesRef = useRef<Edge[] | null>(null);
  const panePointerPanRef = useRef<PanePointerPan | null>(null);
  const paneMousePanRef = useRef<PanePan | null>(null);

  const getViewportElement = useCallback(
    () => graphRootRef.current?.querySelector<HTMLElement>('.react-flow__viewport') ?? null,
    [],
  );

  const cancelActivePanePans = useCallback(() => {
    for (const ref of [panePointerPanRef, paneMousePanRef] as const) {
      const pan = ref.current;
      if (!pan) continue;
      pan.active = false;
      if (pan.animationFrame !== 0) {
        cancelAnimationFrame(pan.animationFrame);
        pan.animationFrame = 0;
      }
      ref.current = null;
    }
  }, []);

  const performFitView = useCallback(() => {
    cancelActivePanePans();
    clearViewportInlineTransform(getViewportElement());
    fitView({ padding: 0.2 });
  }, [cancelActivePanePans, fitView, getViewportElement]);
  const [flowInstanceKey, setFlowInstanceKey] = useState(0);
  const graphMetricsRef = useRef({ deriveMs: 0, layoutMs: 0, objectsMs: 0 });
  const graph = useMemo(() => {
    const startedAt = performance.now();
    const nextGraph = deriveWorkflowGraph(workflows);
    graphMetricsRef.current.deriveMs = performance.now() - startedAt;
    return nextGraph;
  }, [workflows]);
  const positions = useMemo(() => {
    const startedAt = performance.now();
    const nextPositions = layoutWorkflowGraph(graph);
    graphMetricsRef.current.layoutMs = performance.now() - startedAt;
    return nextPositions;
  }, [graph]);

  const nodes = useMemo<Node<WorkflowNodeData>[]>(() => {
    const startedAt = performance.now();
    const nextNodes = graph.nodes.map((node) => {
      const position = positions.get(node.id) ?? { x: 80, y: 80 };
      const dimmed = statusFilters.size > 0 && !statusFilters.has(node.workflow.status);
      return {
        id: node.id,
        type: 'workflowNode',
        position,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        zIndex: 2,
        data: {
          workflow: node.workflow,
          selected: selectedWorkflowId === node.id,
          dimmed,
          coreActivity: coreActivityByWorkflow?.get(node.id),
          onSelect: () => onSelectWorkflow(node.id),
        },
      };
    });
    graphMetricsRef.current.objectsMs = performance.now() - startedAt;
    return nextNodes;
  }, [coreActivityByWorkflow, graph.nodes, onSelectWorkflow, positions, selectedWorkflowId, statusFilters]);
  const [rfNodes, setRfNodes] = useState<Node<WorkflowNodeData>[]>([]);

  useEffect(() => {
    if (nodes.length === 0) {
      if (viewportGestureActiveRef.current) {
        pendingGestureNodesRef.current = [];
        return;
      }
      if (emptyGraphClearTimerRef.current) {
        clearTimeout(emptyGraphClearTimerRef.current);
      }
      emptyGraphClearTimerRef.current = setTimeout(() => {
        emptyGraphClearTimerRef.current = null;
        if (viewportGestureActiveRef.current) return;
        pendingGestureNodesRef.current = null;
        pendingGestureEdgesRef.current = null;
        setRfNodes([]);
        setRfEdges([]);
      }, 1500);
      return;
    }
    if (emptyGraphClearTimerRef.current) {
      clearTimeout(emptyGraphClearTimerRef.current);
      emptyGraphClearTimerRef.current = null;
    }
    if (viewportGestureActiveRef.current) {
      pendingGestureNodesRef.current = nodes;
      return;
    }
    setRfNodes((prev) => mergeMeasuredNodeState(prev, nodes));
  }, [nodes]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const filtered = changes.filter((change) => change.type === 'dimensions' || change.type === 'select');
    if (filtered.length > 0) {
      setRfNodes((prev) => applyNodeChanges(filtered, prev) as Node<WorkflowNodeData>[]);
    }
  }, []);

  const edges = useMemo<Edge[]>(() => graph.edges.map((edge) => {
    const visual = workflowEdgeVisual(edge.kind);
    return {
      id: `workflow:${edge.kind}:${edge.source}->${edge.target}`,
      source: edge.source,
      target: edge.target,
      type: 'smoothstep',
      animated: false,
      style: {
        stroke: visual.stroke,
        strokeWidth: visual.strokeWidth,
        strokeDasharray: visual.strokeDasharray,
      },
      data: { kind: edge.kind },
      ariaLabel: visual.ariaLabel,
      zIndex: 0,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: visual.stroke,
        width: 16,
        height: 16,
      },
    };
  }), [graph.edges]);
  const [rfEdges, setRfEdges] = useState<Edge[]>([]);

  useEffect(() => {
    if (edges.length === 0 && viewportGestureActiveRef.current) {
      pendingGestureEdgesRef.current = [];
      return;
    }
    if (viewportGestureActiveRef.current) {
      pendingGestureEdgesRef.current = edges;
      return;
    }
    setRfEdges(edges);
  }, [edges]);

  // First non-empty render fits the whole graph once. React Flow can remount
  // after transient empty graph data; that remount is not a new camera intent.
  const onInitHandler = useCallback(() => {
    if (initialFitCompletedRef.current) return;
    cancelAnimationFrame(initFitFrameRef.current);
    initFitFrameRef.current = requestAnimationFrame(() => {
      if (initialFitCompletedRef.current) return;
      initialFitCompletedRef.current = true;
      performFitView();
    });
  }, [performFitView]);

  // Cancel a pending first-fit frame on unmount so it never fires against a
  // torn-down graph after the component has gone away.
  useEffect(() => () => cancelAnimationFrame(initFitFrameRef.current), []);
  useEffect(() => () => {
    if (emptyGraphClearTimerRef.current) {
      clearTimeout(emptyGraphClearTimerRef.current);
      emptyGraphClearTimerRef.current = null;
    }
  }, []);
  useEffect(() => {
    if (nodes.length > 0) {
      watchdogMissCountRef.current = 0;
      watchdogRecoveryAttemptedRef.current = false;
    }
  }, [nodes.length]);


  // Manual pan/zoom from the user. React Flow passes a non-null DOM event for
  // user-driven moves and null for programmatic setCenter/fitView, so this only
  // reports genuine manual interaction.
  const onMoveStart = useCallback(
    (event: unknown) => {
      if (event) {
        viewportGestureActiveRef.current = true;
        onManualViewport?.();
      }
    },
    [onManualViewport],
  );
  const endViewportGesture = useCallback(() => {
    if (!viewportGestureActiveRef.current) return;
    viewportGestureActiveRef.current = false;

    const pendingNodes = pendingGestureNodesRef.current;
    pendingGestureNodesRef.current = null;
    if (pendingNodes) {
      if (emptyGraphClearTimerRef.current) {
        clearTimeout(emptyGraphClearTimerRef.current);
        emptyGraphClearTimerRef.current = null;
      }
      setRfNodes((prev) => mergeMeasuredNodeState(prev, pendingNodes));
    }

    const pendingEdges = pendingGestureEdgesRef.current;
    pendingGestureEdgesRef.current = null;
    if (pendingEdges) {
      setRfEdges(pendingEdges);
    }
  }, []);
  const onMoveEnd = useCallback(() => {
    endViewportGesture();
  }, [endViewportGesture]);

  const onPanePointerDownCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse') return;
    if (event.button !== 0 || event.isPrimary === false) return;
    if (!shouldStartPanePan(event.currentTarget, event.target, event.clientX, event.clientY)) return;

    panePointerPanRef.current = {
      ...createPanePan(
        event.clientX,
        event.clientY,
        getViewport(),
        graphRootRef.current?.querySelector('.react-flow__viewport') ?? null,
      ),
      pointerId: event.pointerId,
    };
    schedulePanePanAnimation(panePointerPanRef.current);
    viewportGestureActiveRef.current = true;
    onManualViewport?.();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }, [getViewport, onManualViewport]);

  const updatePanePanViewport = useCallback((pan: PanePan, clientX: number, clientY: number) => {
    pan.hasMoved = true;
    pan.warmupFrame = 0;
    pan.targetViewport = getPanePanViewport(pan, clientX, clientY);
    pan.visualViewport = { ...pan.targetViewport };
    applyViewportTransform(pan.viewportElement, pan.visualViewport);
    schedulePanePanAnimation(pan);
  }, []);

  const finishPanePan = useCallback((pan: PanePan) => {
    pan.active = false;
    if (pan.animationFrame !== 0) {
      cancelAnimationFrame(pan.animationFrame);
      pan.animationFrame = 0;
    }
    pan.visualViewport = { ...pan.targetViewport };
    void setViewport(pan.targetViewport, { duration: 0 });
    clearViewportInlineTransform(pan.viewportElement);
  }, [setViewport]);

  const onPanePointerMoveCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panePointerPanRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;

    updatePanePanViewport(pan, event.clientX, event.clientY);
    event.preventDefault();
    event.stopPropagation();
  }, [updatePanePanViewport]);

  const onPanePointerEndCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panePointerPanRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;

    finishPanePan(pan);
    panePointerPanRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    endViewportGesture();
    event.preventDefault();
    event.stopPropagation();
  }, [endViewportGesture, finishPanePan]);

  const onPaneMouseDownCapture = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || panePointerPanRef.current) return;
    if (!shouldStartPanePan(event.currentTarget, event.target, event.clientX, event.clientY)) return;

    paneMousePanRef.current = createPanePan(
      event.clientX,
      event.clientY,
      getViewport(),
      graphRootRef.current?.querySelector('.react-flow__viewport') ?? null,
    );
    schedulePanePanAnimation(paneMousePanRef.current);
    viewportGestureActiveRef.current = true;
    onManualViewport?.();
    event.preventDefault();
    event.stopPropagation();
  }, [getViewport, onManualViewport]);

  const onPaneMouseMoveCapture = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const pan = paneMousePanRef.current;
    if (!pan) return;

    updatePanePanViewport(pan, event.clientX, event.clientY);
    event.preventDefault();
    event.stopPropagation();
  }, [updatePanePanViewport]);

  const onPaneMouseEndCapture = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const pan = paneMousePanRef.current;
    if (!pan) return;

    finishPanePan(pan);
    paneMousePanRef.current = null;
    endViewportGesture();
    event.preventDefault();
    event.stopPropagation();
  }, [endViewportGesture, finishPanePan]);

  useEffect(() => {
    const root = graphRootRef.current;
    if (!root) return;

    const beginPaneMousePan = (event: MouseEvent): void => {
      if (event.button !== 0 || panePointerPanRef.current) return;
      if (!shouldStartPanePan(root, event.target, event.clientX, event.clientY)) return;

      paneMousePanRef.current = createPanePan(
        event.clientX,
        event.clientY,
        getViewport(),
        root.querySelector('.react-flow__viewport'),
      );
      schedulePanePanAnimation(paneMousePanRef.current);
      viewportGestureActiveRef.current = true;
      onManualViewport?.();
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const updatePaneMousePan = (event: MouseEvent): void => {
      const pan = paneMousePanRef.current;
      if (!pan) return;

      updatePanePanViewport(pan, event.clientX, event.clientY);
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const endPaneMousePan = (event: MouseEvent): void => {
      const pan = paneMousePanRef.current;
      if (!pan) return;

      finishPanePan(pan);
      paneMousePanRef.current = null;
      endViewportGesture();
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    root.addEventListener('mousedown', beginPaneMousePan, true);
    window.addEventListener('mousemove', updatePaneMousePan, true);
    window.addEventListener('mouseup', endPaneMousePan, true);
    return () => {
      root.removeEventListener('mousedown', beginPaneMousePan, true);
      window.removeEventListener('mousemove', updatePaneMousePan, true);
      window.removeEventListener('mouseup', endPaneMousePan, true);
    };
  }, [endViewportGesture, finishPanePan, getViewport, onManualViewport, updatePanePanViewport]);

  const onNodeClick = useCallback((_event: ReactMouseEvent, node: Node) => {
    onSelectWorkflow(node.id);
  }, [onSelectWorkflow]);

  const onNodeContextMenu = useCallback((event: ReactMouseEvent, node: Node) => {
    event.preventDefault();
    onWorkflowContextMenu(event, node.id);
  }, [onWorkflowContextMenu]);

  useEffect(() => {
    if (reportedVisibleRef.current || graph.nodes.length === 0 || typeof window === 'undefined') {
      return;
    }
    const frame = requestAnimationFrame(() => {
      const visibleNode = document.querySelector('[data-testid^="workflow-node-"]');
      if (!visibleNode) return;
      reportedVisibleRef.current = true;
      void window.invoker?.reportUiPerf?.('startup_workflow_graph_visible', {
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
        deriveMs: graphMetricsRef.current.deriveMs,
        layoutMs: graphMetricsRef.current.layoutMs,
        objectsMs: graphMetricsRef.current.objectsMs,
        elapsedMs: Math.round(performance.now()),
        processElapsedMs: window.__INVOKER_BOOTSTRAP__?.appStartedAtEpochMs
          ? Date.now() - window.__INVOKER_BOOTSTRAP__.appStartedAtEpochMs
          : undefined,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [graph.edges.length, graph.nodes.length]);

  // Consume each workflow-scoped camera command exactly once, by sequence.
  // Centering preserves the current zoom so ordinary refreshes never zoom the
  // graph; only an explicit fitInitial command refits.
  useEffect(() => {
    const command = cameraCommand;
    if (!command || command.scope !== 'workflow') return;
    if (command.sequence <= lastHandledCameraSeqRef.current) return;
    lastHandledCameraSeqRef.current = command.sequence;
    if (nodes.length === 0) return;

    if (command.kind === 'fitInitial') {
      const frame = requestAnimationFrame(() => performFitView());
      return () => cancelAnimationFrame(frame);
    }

    const targetId = command.target;
    if (!targetId) return;
    const node = nodes.find((candidate) => candidate.id === targetId);
    if (!node) return;
    const frame = requestAnimationFrame(() => {
      if (typeof setCenter === 'function') {
        const zoom = typeof getZoom === 'function' ? getZoom() : 1;
        setCenter(node.position.x + 110, node.position.y + 45, { zoom, duration: 180 });
      } else {
        performFitView();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [cameraCommand, getZoom, nodes, performFitView, setCenter]);

  useEffect(() => {
    if (nodes.length === 0) return;
    const interval = setInterval(() => {
      const root = graphRootRef.current;
      if (!root) return;
      const renderedNodeElements = root.querySelectorAll('[data-testid^="workflow-node-"]');
      const missingRenderedNodes = root.querySelectorAll(
        '.react-flow__node[style*="visibility: hidden"] [data-testid^="workflow-node-"]',
      );
      if (
        (renderedNodeElements.length === 0 && nodes.length > 0) ||
        (missingRenderedNodes.length > 0 && missingRenderedNodes.length === renderedNodeElements.length)
      ) {
        watchdogMissCountRef.current += 1;
        const shouldRecover =
          watchdogMissCountRef.current >= WATCHDOG_RECOVERY_MISS_COUNT &&
          !watchdogRecoveryAttemptedRef.current;
        if (shouldRecover) {
          watchdogRecoveryAttemptedRef.current = true;
          performFitView();
          setFlowInstanceKey((key) => key + 1);
        }
      } else {
        watchdogMissCountRef.current = 0;
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [nodes.length, performFitView]);

  const flowNodes = rfNodes.length > 0 ? rfNodes : nodes;
  const flowEdges = rfEdges.length > 0 || edges.length === 0 ? rfEdges : edges;

  if (flowNodes.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
        Your plan will appear here.
      </div>
    );
  }

  return (
    <div
      data-testid="workflow-graph-scroll"
      className="h-full min-h-0 w-full overflow-hidden"
    >
      <div
        ref={graphRootRef}
        data-testid="workflow-graph-react-flow"
        className="h-full w-full"
        onPointerDownCapture={onPanePointerDownCapture}
        onPointerMoveCapture={onPanePointerMoveCapture}
        onPointerUpCapture={onPanePointerEndCapture}
        onPointerCancelCapture={onPanePointerEndCapture}
        onMouseDownCapture={onPaneMouseDownCapture}
        onMouseMoveCapture={onPaneMouseMoveCapture}
        onMouseUpCapture={onPaneMouseEndCapture}
      >
        <ReactFlow
          key={flowInstanceKey}
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onNodeClick={onNodeClick}
          onNodeContextMenu={onNodeContextMenu}
          onMoveStart={onMoveStart}
          onMoveEnd={onMoveEnd}
          onInit={onInitHandler}
          zoomOnDoubleClick={false}
          minZoom={0.3}
          maxZoom={2}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          proOptions={{ hideAttribution: true }}
        >
          <Background color="var(--graph-grid)" gap={20} />
          <Controls
            fitViewOptions={{ padding: 0.2 }}
            onFitView={performFitView}
            style={{
              background: 'var(--graph-controls)',
              borderRadius: '8px',
              border: '1px solid var(--graph-controls-border)',
            }}
          />
        </ReactFlow>
      </div>
    </div>
  );
}

export function WorkflowGraph(props: WorkflowGraphProps): JSX.Element {
  return (
    <ReactFlowProvider>
      <WorkflowGraphInner {...props} />
    </ReactFlowProvider>
  );
}
