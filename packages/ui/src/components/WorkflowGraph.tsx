import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { MouseEvent } from 'react';
import type { TaskState, WorkflowMeta, WorkflowStatus } from '../types.js';
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
  statusFilters: Set<WorkflowStatus>;
  cameraSelection?: { requestId: number; target: string } | null;
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
  statusFilters,
  cameraSelection,
  onSelectWorkflow,
  onWorkflowContextMenu,
}: WorkflowGraphProps): JSX.Element {
  const { fitView, setCenter, getZoom } = useReactFlow();
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

  const graphSignature = useMemo(() => {
    const nodeIds = graph.nodes.map((node) => node.id).join('|');
    const edgeIds = graph.edges.map((edge) => `${edge.source}->${edge.target}`).join('|');
    return `${nodeIds}::${edgeIds}`;
  }, [graph.edges, graph.nodes]);

  const onInitHandler = useCallback(() => {
    requestAnimationFrame(() => fitView({ padding: 0.2 }));
  }, [fitView]);

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

  useEffect(() => {
    if (graph.nodes.length === 0 || typeof window === 'undefined') return;
    const frame = requestAnimationFrame(() => {
      requestAnimationFrame(() => fitView({ padding: 0.2 }));
    });
    return () => cancelAnimationFrame(frame);
  }, [fitView, graph.nodes.length, graphSignature]);

  useEffect(() => {
    if (!cameraSelection || typeof window === 'undefined') return;
    const position = positions.get(cameraSelection.target);
    if (!position) return;
    const frame = requestAnimationFrame(() => {
      setCenter(position.x + 110, position.y + 44, { zoom: getZoom() });
    });
    return () => cancelAnimationFrame(frame);
  }, [cameraSelection, getZoom, positions, setCenter]);

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
          key={graphSignature}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick}
          onNodeContextMenu={onNodeContextMenu}
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
