import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { MouseEvent } from 'react';
import type { TaskState, WorkflowMeta, WorkflowStatus } from '../types.js';
import type { GraphCameraCommand } from '../lib/graph-camera.js';
import { deriveWorkflowGraph, layoutWorkflowGraph } from '../lib/workflow-graph.js';
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
  /** Latest typed camera command for the workflow scope; consumed once by sequence. */
  cameraCommand?: GraphCameraCommand | null;
  /** Invoked when the user manually pans or wheel-zooms the viewport. */
  onManualViewportChange?: () => void;
  statusFilters: Set<WorkflowStatus>;
  onSelectWorkflow: (workflowId: string) => void;
  onWorkflowContextMenu: (event: MouseEvent, workflowId: string) => void;
}

interface WorkflowNodeData extends Record<string, unknown> {
  workflow: WorkflowMeta;
  selected: boolean;
  dimmed: boolean;
}

const nodeTypes = {
  workflowNode: WorkflowFlowNode,
};

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
  onManualViewportChange,
  statusFilters,
  onSelectWorkflow,
  onWorkflowContextMenu,
}: WorkflowGraphProps): JSX.Element {
  const { fitView, setCenter, getZoom } = useReactFlow();
  const didInitialFitRef = useRef(false);
  const lastCameraSequenceRef = useRef(0);
  const reportedVisibleRef = useRef(false);
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

  const edges = useMemo<Edge[]>(() => graph.edges.map((edge) => ({
    id: `workflow:${edge.source}->${edge.target}`,
    source: edge.source,
    target: edge.target,
    type: 'smoothstep',
    animated: false,
    style: {
      stroke: 'rgba(148,163,184,0.55)',
      strokeWidth: 2,
    },
    zIndex: 0,
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: 'rgba(148,163,184,0.55)',
      width: 16,
      height: 16,
    },
  })), [graph.edges]);

  const onInitHandler = useCallback(() => {
    requestAnimationFrame(() => fitView({ padding: 0.2 }));
  }, [fitView]);

  // Frame the graph once, on the first non-empty render. Ordinary status or
  // topology updates never re-fit — that would fight a user who has panned.
  useEffect(() => {
    if (didInitialFitRef.current || nodes.length === 0) return;
    didInitialFitRef.current = true;
    const frame = requestAnimationFrame(() => fitView({ padding: 0.2 }));
    return () => cancelAnimationFrame(frame);
  }, [fitView, nodes.length]);

  // A user-initiated pan or wheel zoom carries a DOM event; programmatic moves
  // (setCenter / fitView) pass `null`. Only the former hands control to the user.
  const onMoveStart = useCallback(
    (event: globalThis.MouseEvent | globalThis.TouchEvent | null) => {
      if (event) onManualViewportChange?.();
    },
    [onManualViewportChange],
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

  // Consume each typed camera command exactly once, keyed by its monotonic
  // sequence. Centering preserves the current zoom so it never yanks the user's
  // zoom level; `fitInitial` re-frames. The sequence is only marked consumed
  // once the target node exists, so a command issued before its node mounts is
  // applied on a later render rather than dropped.
  useEffect(() => {
    if (!cameraCommand || cameraCommand.sequence <= lastCameraSequenceRef.current) return;
    if (nodes.length === 0) return;
    if (cameraCommand.style === 'fitInitial') {
      lastCameraSequenceRef.current = cameraCommand.sequence;
      const frame = requestAnimationFrame(() => fitView({ padding: 0.2 }));
      return () => cancelAnimationFrame(frame);
    }
    const node = cameraCommand.target
      ? nodes.find((candidate) => candidate.id === cameraCommand.target)
      : null;
    if (!node) return;
    lastCameraSequenceRef.current = cameraCommand.sequence;
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
      const domNodes = document.querySelectorAll('[data-testid^="workflow-node-"]');
      const hiddenNodes = document.querySelectorAll(
        '.react-flow__node[style*="visibility: hidden"] [data-testid^="workflow-node-"]',
      );
      if (
        (domNodes.length === 0 && nodes.length > 0) ||
        (hiddenNodes.length > 0 && hiddenNodes.length === domNodes.length)
      ) {
        fitView({ padding: 0.2 });
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
      <div data-testid="workflow-graph-react-flow" className="h-full w-full">
        <ReactFlow
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
