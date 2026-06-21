import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import type { TaskState, WorkflowMeta, WorkflowStatus } from '../types.js';
import type { GraphCameraCommand } from '../lib/graph-camera.js';
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
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

interface WorkflowGraphProps {
  tasks: Map<string, TaskState>;
  workflows: Map<string, WorkflowMeta>;
  selectedWorkflowId: string | null;
  /**
   * Latest typed camera command. The graph consumes each command once by
   * sequence; commands scoped to other graphs are ignored. React Flow keeps
   * owning x/y/zoom locally — this is intent, not a controlled viewport.
   */
  cameraCommand?: GraphCameraCommand | null;
  statusFilters: Set<WorkflowStatus>;
  onSelectWorkflow: (workflowId: string) => void;
  onWorkflowContextMenu: (event: MouseEvent, workflowId: string) => void;
  /** Fired when the user manually pans or zooms the viewport. */
  onManualViewport?: () => void;
}

interface WorkflowNodeData extends Record<string, unknown> {
  workflow: WorkflowMeta;
  selected: boolean;
  dimmed: boolean;
}

const nodeTypes = {
  workflowNode: WorkflowFlowNode,
};
const WATCHDOG_RECOVERY_MISS_COUNT = 3;


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
        className="!h-2 !w-2 !border !border-slate-400 !bg-gray-900"
        isConnectable={false}
      />
      <WorkflowNode
        workflow={data.workflow}
        selected={data.selected}
        dimmed={data.dimmed}
        onClick={() => {}}
        onContextMenu={() => {}}
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !border !border-slate-400 !bg-gray-900"
        isConnectable={false}
      />
    </div>
  );
}

function WorkflowGraphInner({
  tasks,
  workflows,
  selectedWorkflowId,
  cameraCommand,
  statusFilters,
  onSelectWorkflow,
  onWorkflowContextMenu,
  onManualViewport,
}: WorkflowGraphProps): JSX.Element {
  const { fitView, setCenter, getZoom } = useReactFlow();
  const graphRootRef = useRef<HTMLDivElement>(null);
  const reportedVisibleRef = useRef(false);
  const lastHandledCameraSeqRef = useRef(0);
  const initFitFrameRef = useRef(0);
  const watchdogMissCountRef = useRef(0);
  const watchdogRecoveryAttemptedRef = useRef(false);
  const [flowInstanceKey, setFlowInstanceKey] = useState(0);
  const graphMetricsRef = useRef({ deriveMs: 0, layoutMs: 0, objectsMs: 0 });
  const graph = useMemo(() => {
    const startedAt = performance.now();
    const nextGraph = deriveWorkflowGraph(workflows, tasks);
    graphMetricsRef.current.deriveMs = performance.now() - startedAt;
    return nextGraph;
  }, [workflows, tasks]);
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
        },
      };
    });
    graphMetricsRef.current.objectsMs = performance.now() - startedAt;
    return nextNodes;
  }, [graph.nodes, positions, selectedWorkflowId, statusFilters]);

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

  // First non-empty render fits the whole graph once. React Flow only mounts
  // when there is at least one node (the empty state short-circuits below), so
  // onInit fires exactly on the first non-empty render — no graphSignature key
  // and no per-update remount are needed.
  const onInitHandler = useCallback(() => {
    initFitFrameRef.current = requestAnimationFrame(() => fitView({ padding: 0.2 }));
  }, [fitView]);

  // Cancel a pending first-fit frame on unmount so it never fires against a
  // torn-down graph after the component has gone away.
  useEffect(() => () => cancelAnimationFrame(initFitFrameRef.current), []);
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
      if (event) onManualViewport?.();
    },
    [onManualViewport],
  );

  const onNodeClick = useCallback((_event: MouseEvent, node: Node) => {
    onSelectWorkflow(node.id);
  }, [onSelectWorkflow]);

  const onNodeContextMenu = useCallback((event: MouseEvent, node: Node) => {
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
        setCenter(node.position.x + 110, node.position.y + 45, { zoom, duration: 180 });
      } else {
        fitView({ padding: 0.2 });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [cameraCommand, fitView, getZoom, nodes, setCenter]);

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
  }, [fitView, nodes.length]);

  if (graph.nodes.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-gray-500 text-sm">
        Load a plan to render workflow graph
      </div>
    );
  }

  return (
    <div
      data-testid="workflow-graph-scroll"
      className="h-full w-full overflow-hidden"
      style={{ minHeight: '300px' }}
    >
      <div ref={graphRootRef} data-testid="workflow-graph-react-flow" className="h-full w-full">
        <ReactFlow
          key={flowInstanceKey}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick}
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
          <Background color="#374151" gap={20} />
          <Controls
            style={{
              background: '#1f2937',
              borderRadius: '8px',
              border: '1px solid #374151',
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
