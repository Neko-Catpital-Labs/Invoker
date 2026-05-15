import { useCallback, useMemo } from 'react';
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
  onSelectWorkflow,
  onWorkflowContextMenu,
}: WorkflowGraphProps): JSX.Element {
  const { fitView } = useReactFlow();
  const graph = useMemo(() => deriveWorkflowGraph(workflows, tasks), [workflows, tasks]);
  const positions = useMemo(() => layoutWorkflowGraph(graph), [graph]);

  const nodes = useMemo<Node<WorkflowNodeData>[]>(() => graph.nodes.map((node) => {
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
  }), [graph.nodes, positions, selectedWorkflowId, statusFilters]);

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

  const onNodeClick = useCallback((_event: MouseEvent, node: Node) => {
    onSelectWorkflow(node.id);
  }, [onSelectWorkflow]);

  const onNodeContextMenu = useCallback((event: MouseEvent, node: Node) => {
    event.preventDefault();
    onWorkflowContextMenu(event, node.id);
  }, [onWorkflowContextMenu]);

  if (graph.nodes.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-gray-500 text-sm">
        Load a plan to render workflow graph
      </div>
    );
  }

  return (
    <div data-testid="workflow-graph-react-flow" className="h-full w-full" style={{ minHeight: '300px' }}>
      <ReactFlow
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
  );
}

export function WorkflowGraph(props: WorkflowGraphProps): JSX.Element {
  return (
    <ReactFlowProvider>
      <WorkflowGraphInner {...props} />
    </ReactFlowProvider>
  );
}
