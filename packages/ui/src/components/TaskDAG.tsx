/**
 * TaskDAG — DAG visualization using @xyflow/react.
 *
 * Converts the task map into nodes and edges.
 * Layout: horizontal left-to-right flow based on dependency levels.
 * Click a node to select the task (shows details in TaskPanel).
 */

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  applyNodeChanges,
  type Node,
  type Edge,
  type NodeChange,
  Background,
  Controls,
  Panel,
  MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import type { TaskState, WorkflowMeta } from '../types.js';
import type { GraphCameraCommand } from '../lib/graph-camera.js';
import { layoutNodes, layoutTaskGraph, type LayoutEdge, type TaskGraphLayout } from '../lib/layout.js';
import { getEdgeStyle, getEffectiveVisualStatus, matchesStatusFilter } from '../lib/colors.js';
import { TaskNode } from './TaskNode.js';
import { BundledEdge, type BundledEdgeData } from './BundledEdge.js';
import { MergeGateNode } from './MergeGateNode.js';
import {
  isMergeGateId,
  groupTasksByWorkflow,
  sortedWorkflowGroups,
  resolveMergeGateKind,
  mergeGatePlanTitle,
  computeMergeGateStatus,
} from '../lib/merge-gate.js';

interface TaskDAGProps {
  tasks: Map<string, TaskState>;
  workflows?: Map<string, WorkflowMeta>;
  selectedTaskId?: string | null;
  /**
   * Latest typed camera command. The DAG consumes each command once by
   * sequence; commands scoped to other graphs are ignored. React Flow keeps
   * owning x/y/zoom locally — this is intent, not a controlled viewport.
   */
  cameraCommand?: GraphCameraCommand | null;
  onTaskClick?: (task: TaskState) => void;
  onTaskDoubleClick?: (task: TaskState) => void;
  onTaskContextMenu?: (task: TaskState, event: React.MouseEvent) => void;
  /** Fired when the user manually pans or zooms the viewport. */
  onManualViewport?: () => void;
  statusFilters?: Set<string>;
  runningTaskIds?: ReadonlySet<string>;
  surfaceMode?: 'default' | 'browser' | 'overlay';
}

const nodeTypes = { taskNode: TaskNode, mergeGateNode: MergeGateNode };
const edgeTypes = { bundled: BundledEdge };
const WORKFLOW_GAP = 100;
const WATCHDOG_RECOVERY_MISS_COUNT = 3;

type RawTaskEdge = LayoutEdge & {
  kind: 'local' | 'external';
};

type LayoutState = {
  key: string;
  result: TaskGraphLayout;
};

/** Short label for edge hover tooltip showing the dependency relationship. */
function buildEdgeLabel(source: TaskState, target: TaskState): string {
  const srcId = source.id.length > 12 ? source.id.slice(0, 12) + '..' : source.id;
  const tgtId = target.id.length > 12 ? target.id.slice(0, 12) + '..' : target.id;
  return `${srcId} → ${tgtId}`;
}

function resolveExternalDependencyTaskId(
  dep: { workflowId: string; taskId?: string },
  tasks: Map<string, TaskState>,
): string | undefined {
  const taskId = dep.taskId?.trim() || '__merge__';
  if (taskId === '__merge__') {
    const mergeGateId = `__merge__${dep.workflowId}`;
    return tasks.has(mergeGateId) ? mergeGateId : undefined;
  }
  if (taskId.includes('/')) {
    return tasks.has(taskId) ? taskId : undefined;
  }
  const scoped = `${dep.workflowId}/${taskId}`;
  if (tasks.has(scoped)) return scoped;
  if (tasks.has(taskId)) return taskId;
  return undefined;
}

function makeFallbackLayout(tasks: TaskState[]): TaskGraphLayout {
  const workflowGroups = groupTasksByWorkflow(tasks);
  const positions = new Map<string, { x: number; y: number }>();
  let yOffset = 0;

  for (const [, wfTasksRaw] of sortedWorkflowGroups(workflowGroups)) {
    const wfTasks = [...wfTasksRaw].sort((a, b) => a.id.localeCompare(b.id));
    const groupPositions = layoutNodes(wfTasks);

    let minY = Infinity;
    let maxY = -Infinity;
    for (const pos of groupPositions.values()) {
      minY = Math.min(minY, pos.y);
      maxY = Math.max(maxY, pos.y);
    }

    for (const task of wfTasks) {
      const pos = groupPositions.get(task.id) ?? { x: 0, y: 0 };
      positions.set(task.id, { x: pos.x, y: pos.y + yOffset });
    }

    const groupHeight = maxY === -Infinity ? 0 : maxY - minY + 80;
    yOffset += groupHeight + WORKFLOW_GAP;
  }

  return { positions, edgePoints: new Map(), usedFallback: true };
}

function layoutHasAllTasks(layout: TaskGraphLayout, tasks: TaskState[]): boolean {
  return tasks.every((task) => layout.positions.has(task.id));
}

function layoutKeyFor(tasks: TaskState[], edges: RawTaskEdge[]): string {
  return JSON.stringify({
    nodes: tasks.map((task) => task.id).sort(),
    edges: edges
      .map((edge) => `${edge.id ?? `${edge.source}->${edge.target}`}:${edge.kind}:${edge.source}->${edge.target}`)
      .sort(),
  });
}

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

function TaskDAGInner({ tasks, workflows, selectedTaskId, cameraCommand, onTaskClick, onTaskDoubleClick, onTaskContextMenu, onManualViewport, statusFilters, runningTaskIds, surfaceMode = 'default' }: TaskDAGProps) {
  const { fitView, setCenter, getZoom } = useReactFlow();
  const graphRootRef = useRef<HTMLDivElement>(null);
  const prevNodeCount = useRef(0);
  const reportedGraphVisibleRef = useRef(false);
  const watchdogMissCountRef = useRef(0);
  const watchdogRecoveryAttemptedRef = useRef(false);
  const lastHandledCameraSeqRef = useRef(0);
  const browserRemountDoneRef = useRef(false);
  const initFitFrameRef = useRef(0);
  const nodesRef = useRef<typeof nodes>([]);
  const [layoutState, setLayoutState] = useState<LayoutState | null>(null);
  const lastLayoutRef = useRef<TaskGraphLayout | null>(null);
  const [flowInstanceKey, setFlowInstanceKey] = useState(0);
  const onInitHandler = useCallback(() => {
    initFitFrameRef.current = requestAnimationFrame(() => fitView({ padding: 0.2 }));
  }, [fitView]);

  // Manual "snap to graph" recovery. The auto-fit watchdog only runs in the
  // browser surface, so on desktop a graph that has been panned/zoomed off
  // screen (a blank/black canvas) has no way back. This button re-fits every
  // node into view on demand, independent of the camera-lock preference.
  const handleSnapToGraph = useCallback(() => {
    fitView({ padding: 0.2, duration: 300 });
  }, [fitView]);

  // Cancel a pending first-fit frame on unmount so it never fires against a
  // torn-down graph after the component has gone away.
  useEffect(() => () => cancelAnimationFrame(initFitFrameRef.current), []);


  const rawGraph = useMemo(() => {
    const taskArray = [...tasks.values()];
    if (taskArray.length === 0) {
      return {
        taskArray,
        rawEdges: [] as RawTaskEdge[],
        gateStatuses: new Map<string, ReturnType<typeof computeMergeGateStatus>>(),
        dimmedNodeIds: new Set<string>(),
        fallbackLayout: makeFallbackLayout([]),
        layoutKey: 'empty',
      };
    }

    const workflowGroups = groupTasksByWorkflow(taskArray);
    const allRawEdges: RawTaskEdge[] = [];
    const gateStatuses = new Map<string, ReturnType<typeof computeMergeGateStatus>>();

    for (const [wfGroupId, wfTasksRaw] of sortedWorkflowGroups(workflowGroups)) {
      const wfTasks = [...wfTasksRaw].sort((a, b) => a.id.localeCompare(b.id));
      for (const task of wfTasks) {
        if (task.config.isMergeNode) gateStatuses.set(task.id, task.status);
      }

      for (const task of wfTasks) {
        for (const depId of task.dependencies) {
          if (tasks.has(depId)) {
            allRawEdges.push({
              id: `local:${depId}->${task.id}`,
              source: depId,
              target: task.id,
              kind: 'local',
            });
          }
        }
        for (const dep of task.config.externalDependencies ?? []) {
          const sourceId = resolveExternalDependencyTaskId(dep, tasks);
          if (!sourceId || sourceId === task.id) continue;
          allRawEdges.push({
            id: `external:${sourceId}->${task.id}`,
            source: sourceId,
            target: task.id,
            kind: 'external',
          });
        }
      }
    }

    const dimmedNodeIds = new Set<string>();
    if (statusFilters && statusFilters.size > 0) {
      for (const task of taskArray) {
        const runningLike = runningTaskIds?.has(task.id) === true;
        const vs = getEffectiveVisualStatus(task.status, task.execution, { runningLike });
        if (!Array.from(statusFilters).some((filterKey) => matchesStatusFilter(filterKey, vs))) {
          dimmedNodeIds.add(task.id);
        }
      }
    }

    const layoutTasks = [...taskArray].sort((a, b) => a.id.localeCompare(b.id));
    const rawEdges = allRawEdges.sort((a, b) => (a.id ?? '').localeCompare(b.id ?? ''));

    return {
      taskArray,
      rawEdges,
      gateStatuses,
      dimmedNodeIds,
      fallbackLayout: makeFallbackLayout(taskArray),
      layoutKey: layoutKeyFor(layoutTasks, rawEdges),
    };
  }, [runningTaskIds, tasks, statusFilters]);
  useEffect(() => {
    browserRemountDoneRef.current = false;
  }, [rawGraph.layoutKey, surfaceMode]);

  useEffect(() => {
    if (rawGraph.taskArray.length === 0) return;
    let stale = false;
    const layoutTasks = [...rawGraph.taskArray].sort((a, b) => a.id.localeCompare(b.id));
    const layoutEdges = rawGraph.rawEdges.map(({ id, source, target }) => ({ id, source, target }));

    void layoutTaskGraph(layoutTasks, layoutEdges).then((result) => {
      if (!stale) {
        lastLayoutRef.current = result;
        setLayoutState({ key: rawGraph.layoutKey, result });
      }
    });

    return () => {
      stale = true;
    };
  }, [rawGraph.layoutKey]);

  const activeLayout = useMemo(() => {
    if (layoutState && layoutHasAllTasks(layoutState.result, rawGraph.taskArray)) {
      return layoutState.result;
    }
    const priorPositions = layoutState?.result.positions ?? lastLayoutRef.current?.positions;
    if (!priorPositions) {
      return rawGraph.fallbackLayout;
    }
    const positions = new Map<string, { x: number; y: number }>();
    let usedFallback = false;
    for (const task of rawGraph.taskArray) {
      const prior = priorPositions.get(task.id);
      if (prior) {
        positions.set(task.id, prior);
      } else {
        positions.set(task.id, rawGraph.fallbackLayout.positions.get(task.id) ?? { x: 0, y: 0 });
        usedFallback = true;
      }
    }
    return { positions, edgePoints: new Map(), usedFallback };
  }, [layoutState, rawGraph.fallbackLayout, rawGraph.taskArray]);

  const emptyEdgePoints = useMemo(() => new Map<string, { x: number; y: number }[]>(), []);
  const routedEdgePoints = useMemo(
    () => layoutState?.key === rawGraph.layoutKey ? layoutState.result.edgePoints : emptyEdgePoints,
    [emptyEdgePoints, layoutState, rawGraph.layoutKey],
  );

  const { nodes, edges } = useMemo(() => {
    const allNodes: Node[] = [];
    for (const task of rawGraph.taskArray) {
      const wfGroupId = task.config.workflowId ?? 'unknown';
      const wfMeta = workflows?.get(wfGroupId);
      const wfMergeMode = (wfMeta?.mergeMode as 'manual' | 'automatic' | 'external_review') ?? 'manual';
      const pos = activeLayout.positions.get(task.id) ?? { x: 0, y: 0 };
      const runningLike = runningTaskIds?.has(task.id) === true;
      const visualStatus = getEffectiveVisualStatus(task.status, task.execution, { runningLike });
      const dimmed = statusFilters
        && statusFilters.size > 0
        && !Array.from(statusFilters).some((filterKey) => matchesStatusFilter(filterKey, visualStatus));

      if (task.config.isMergeNode) {
        let gateKind = resolveMergeGateKind(task, wfMeta);
        if (wfMergeMode === 'external_review') {
          gateKind = 'external_review';
        }
        const showMergeModeRow = gateKind !== 'external_review';
        allNodes.push({
          id: task.id,
          type: 'mergeGateNode',
          position: pos,
          data: {
            taskId: task.id,
            status: task.status,
            label: mergeGatePlanTitle(task.description),
            gateKind,
            showMergeModeRow,
            baseBranch: wfMeta?.baseBranch,
            featureBranch: wfMeta?.featureBranch,
            mergeMode: wfMergeMode,
            workflowId: wfGroupId,
            reviewUrl: task.execution?.reviewUrl,
            reviewStatus: task.execution?.reviewStatus,
            summary: task.config?.summary,
            onFinish: wfMeta?.onFinish,
            pendingFixError: task.execution?.pendingFixError,
            dimmed,
            selected: selectedTaskId === task.id,
          },
        });
      } else {
        allNodes.push({
          id: task.id,
          type: 'taskNode',
          position: pos,
          data: {
            task,
            label: task.description,
            dimmed,
            selected: selectedTaskId === task.id,
            runningLike,
          },
        });
      }
    }

    // Build edges with offset calculations
    const sourceOutCount = new Map<string, number>();
    const targetInCount = new Map<string, number>();
    for (const e of rawGraph.rawEdges) {
      sourceOutCount.set(e.source, (sourceOutCount.get(e.source) ?? 0) + 1);
      targetInCount.set(e.target, (targetInCount.get(e.target) ?? 0) + 1);
    }

    const sourceOutIndex = new Map<string, number>();
    const targetInIndex = new Map<string, number>();
    const EDGE_SPACING = 12;

    const newEdges: Edge<BundledEdgeData>[] = rawGraph.rawEdges.map((e) => {
      const srcTotal = sourceOutCount.get(e.source) ?? 1;
      const srcIdx = sourceOutIndex.get(e.source) ?? 0;
      sourceOutIndex.set(e.source, srcIdx + 1);

      const tgtTotal = targetInCount.get(e.target) ?? 1;
      const tgtIdx = targetInIndex.get(e.target) ?? 0;
      targetInIndex.set(e.target, tgtIdx + 1);

      const sourceOffset = srcTotal > 1 ? (srcIdx - (srcTotal - 1) / 2) * EDGE_SPACING : 0;
      const targetOffset = tgtTotal > 1 ? (tgtIdx - (tgtTotal - 1) / 2) * EDGE_SPACING : 0;

      const sourceTask = tasks.get(e.source);
      const targetTask = tasks.get(e.target);
      const sourceStatus = sourceTask?.status ?? rawGraph.gateStatuses.get(e.source) ?? 'pending';
      const targetStatus = targetTask?.status ?? rawGraph.gateStatuses.get(e.target) ?? 'pending';
      const edgeStyle = getEdgeStyle(sourceStatus, targetStatus);

      const srcIsMerge = tasks.get(e.source)?.config.isMergeNode || isMergeGateId(e.source);
      const tgtIsMerge = tasks.get(e.target)?.config.isMergeNode || isMergeGateId(e.target);
      const srcLabel = srcIsMerge ? 'Merge' : e.source;
      const tgtLabel = tgtIsMerge ? 'Merge' : e.target;
      const truncSrc = srcLabel.length > 12 ? srcLabel.slice(0, 12) + '..' : srcLabel;
      const truncTgt = tgtLabel.length > 12 ? tgtLabel.slice(0, 12) + '..' : tgtLabel;
      const label = `${truncSrc} → ${truncTgt}`;

      const edgeDimmed = rawGraph.dimmedNodeIds.has(e.source) || rawGraph.dimmedNodeIds.has(e.target);
      const selectionActive = selectedTaskId === e.source || selectedTaskId === e.target;
      const baseOpacity = edgeDimmed ? 0.15 : e.kind === 'external' ? 0.24 : 1;

      return {
        id: e.id ?? `${e.kind}:${e.source}->${e.target}`,
        source: e.source,
        target: e.target,
        type: 'bundled',
        animated: sourceStatus === 'running' && targetStatus !== 'stale' && e.kind !== 'external',
        style: {
          stroke: edgeStyle.stroke,
          strokeWidth: edgeStyle.strokeWidth,
          strokeDasharray: e.kind === 'external' ? '6 4' : edgeStyle.strokeDasharray,
          opacity: selectionActive ? Math.max(baseOpacity, e.kind === 'external' ? 0.86 : 1) : baseOpacity,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: edgeStyle.stroke,
          width: 16,
          height: 16,
        },
        data: {
          sourceOffset,
          targetOffset,
          sourceStatus,
          targetStatus,
          label: e.kind === 'external' ? `external ${label}` : label,
          hoverStroke: edgeStyle.hoverStroke,
          hoverWidth: edgeStyle.hoverWidth,
          routePoints: routedEdgePoints.get(e.id ?? `${e.kind}:${e.source}->${e.target}`),
          external: e.kind === 'external',
          selectionActive,
        },
      };
    });

    return { nodes: allNodes, edges: newEdges };
  }, [activeLayout.positions, rawGraph, routedEdgePoints, runningTaskIds, selectedTaskId, statusFilters, tasks, workflows]);

  // Merge task-derived nodes with React Flow's internal dimension state.
  // Without this, each task-delta re-render creates new node objects that discard
  // previously measured dimensions, forcing React Flow to re-measure.
  const [rfNodes, setRfNodes] = useState<Node[]>([]);

  useEffect(() => {
    setRfNodes((prev) => mergeMeasuredNodeState(prev, nodes));
  }, [nodes]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const filtered = changes.filter(c => c.type === 'dimensions' || c.type === 'select');
    if (filtered.length > 0) {
      setRfNodes(prev => applyNodeChanges(filtered, prev));
    }
  }, []);

  // Topology changes (added/removed nodes) reset the watchdog recovery state but
  // preserve the camera — a status refresh or new task must never re-fit or
  // re-center. The initial fit is owned by onInit (first non-empty mount).
  useEffect(() => {
    if (nodes.length !== prevNodeCount.current && nodes.length > 0) {
      prevNodeCount.current = nodes.length;
      watchdogMissCountRef.current = 0;
      watchdogRecoveryAttemptedRef.current = false;
    }
  }, [nodes.length]);

  // Manual pan/zoom from the user. React Flow passes a non-null DOM event for
  // user-driven moves and null for programmatic setCenter/fitView, so this only
  // reports genuine manual interaction.
  const onMoveStart = useCallback(
    (event: unknown) => {
      if (event) onManualViewport?.();
    },
    [onManualViewport],
  );
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  // Consume each task-scoped camera command exactly once, by sequence. Centering
  // preserves the current zoom so ordinary refreshes never zoom the graph; only
  // an explicit fitInitial command refits.
  useEffect(() => {
    const command = cameraCommand;
    if (!command || command.scope !== 'task') return;
    if (command.sequence <= lastHandledCameraSeqRef.current) return;
    lastHandledCameraSeqRef.current = command.sequence;
    if (nodes.length === 0) return;

    if (command.kind === 'fitInitial') {
      const frame = requestAnimationFrame(() => fitView({ padding: 0.2 }));
      return () => cancelAnimationFrame(frame);
    }

    const targetId = command.target;
    if (!targetId) return;
    const node = nodes.find((candidate) => candidate.id === targetId);
    if (!node) return;
    const frame = requestAnimationFrame(() => {
      if (typeof setCenter === 'function') {
        const zoom = typeof getZoom === 'function' ? getZoom() : 1;
        setCenter(node.position.x + 132, node.position.y + 55, { zoom, duration: 180 });
      } else {
        fitView({ padding: 0.2 });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [cameraCommand, fitView, getZoom, nodes, setCenter]);

  useEffect(() => {
    if (surfaceMode !== 'browser' || nodesRef.current.length === 0) return;

    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      if (cancelled) return;
      fitView({ padding: 0.2 });
      if (!selectedTaskId) return;
      const node = nodesRef.current.find((candidate) => candidate.id === selectedTaskId);
      if (!node) return;
      requestAnimationFrame(() => {
        if (cancelled) return;
        const zoom = Math.max(typeof getZoom === 'function' ? getZoom() : 1, 0.85);
        setCenter(node.position.x + 132, node.position.y + 55, { zoom, duration: 0 });
      });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [fitView, getZoom, rawGraph.layoutKey, selectedTaskId, setCenter, surfaceMode]);

  useEffect(() => {
    if (surfaceMode !== 'browser' || nodesRef.current.length === 0 || browserRemountDoneRef.current) return;

    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      if (cancelled) return;
      requestAnimationFrame(() => {
        if (cancelled || browserRemountDoneRef.current) return;
        browserRemountDoneRef.current = true;
        setFlowInstanceKey((key) => key + 1);
      });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [rawGraph.layoutKey, surfaceMode]);

  useEffect(() => {
    if (reportedGraphVisibleRef.current || nodes.length === 0 || typeof window === 'undefined') {
      return;
    }
    const frame = requestAnimationFrame(() => {
      const visibleNode = document.querySelector('.react-flow__node');
      if (!visibleNode) return;
      reportedGraphVisibleRef.current = true;
      void window.invoker?.reportUiPerf?.('startup_graph_visible', {
        nodeCount: nodes.length,
        elapsedMs: Math.round(performance.now()),
        processElapsedMs: window.__INVOKER_BOOTSTRAP__?.appStartedAtEpochMs
          ? Date.now() - window.__INVOKER_BOOTSTRAP__.appStartedAtEpochMs
          : undefined,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [nodes.length]);

  // Watchdog: detect when nodes are absent from the DOM or stuck with visibility: hidden
  useEffect(() => {
    if (nodes.length === 0) return;
    const interval = setInterval(() => {
      const root = graphRootRef.current;
      if (!root) return;
      const renderedNodeElements = root.querySelectorAll('.react-flow__node');
      const missingRenderedNodes = root.querySelectorAll(
        '.react-flow__node[style*="visibility: hidden"]',
      );

      if (
        (renderedNodeElements.length === 0 && nodes.length > 0) ||
        (missingRenderedNodes.length > 0 && missingRenderedNodes.length === renderedNodeElements.length)
      ) {
        watchdogMissCountRef.current += 1;
        const shouldRecover =
          watchdogMissCountRef.current >= WATCHDOG_RECOVERY_MISS_COUNT &&
          !watchdogRecoveryAttemptedRef.current;

        console.warn(
          shouldRecover
            ? '[DAG-watchdog] Nodes hidden or missing, remounting React Flow'
            : '[DAG-watchdog] Nodes hidden or missing, forcing fitView',
          {
            propsNodeCount: nodes.length,
            renderedNodeElementCount: renderedNodeElements.length,
            missingRenderedNodeCount: missingRenderedNodes.length,
            missCount: watchdogMissCountRef.current,
            recoveryAttempted: watchdogRecoveryAttemptedRef.current,
            recoveryTriggered: shouldRecover,
          },
        );
        fitView({ padding: 0.2 });
        if (shouldRecover) {
          watchdogRecoveryAttemptedRef.current = true;
          setFlowInstanceKey((key) => key + 1);
        }
      } else {
        watchdogMissCountRef.current = 0;
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [nodes.length, fitView]);

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      const task = tasks.get(node.id);
      if (task && onTaskClick) {
        onTaskClick(task);
      }
    },
    [tasks, onTaskClick],
  );

  const onNodeDoubleClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      const task = tasks.get(node.id);
      if (task && onTaskDoubleClick) {
        onTaskDoubleClick(task);
      }
    },
    [tasks, onTaskDoubleClick],
  );

  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.preventDefault();
      const task = tasks.get(node.id);
      if (task && onTaskContextMenu) {
        onTaskContextMenu(task, event);
      }
    },
    [tasks, onTaskContextMenu],
  );

  if (tasks.size === 0) {
    return (
      <div className="h-full w-full flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <p>Your plan will appear here.</p>
        </div>
      </div>
    );
  }

  const browserHeight = surfaceMode === 'browser' ? '300px' : '100%';

  return (
    <div
      ref={graphRootRef}
      className="flex min-h-0 w-full flex-1 overflow-hidden"
      style={{ height: browserHeight }}
    >
      <ReactFlow
        key={flowInstanceKey}
        className="h-full w-full"
        style={{ width: '100%', height: browserHeight }}
        nodes={rfNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onNodeContextMenu={onNodeContextMenu}
        onMoveStart={onMoveStart}
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
          style={{
            background: 'var(--graph-controls)',
            borderRadius: '8px',
            border: '1px solid var(--graph-controls-border)',
          }}
        />
        <Panel position="top-right">
          <button
            type="button"
            data-testid="snap-to-graph"
            onClick={handleSnapToGraph}
            title="Snap view to fit the whole graph"
            aria-label="Snap view to fit the whole graph"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 10px',
              background: 'var(--graph-controls)',
              color: 'var(--graph-controls-button-color, #000)',
              border: '1px solid var(--graph-controls-border)',
              borderRadius: '8px',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            <span aria-hidden="true">⤢</span>
            Snap to graph
          </button>
        </Panel>
      </ReactFlow>
    </div>
  );
}

export function TaskDAG(props: TaskDAGProps) {
  return (
    <ReactFlowProvider>
      <TaskDAGInner {...props} />
    </ReactFlowProvider>
  );
}
