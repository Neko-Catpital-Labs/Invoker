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
  MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import type { TaskState } from '../types.js';
import { layoutNodes } from '../lib/layout.js';
import { getEdgeStyle } from '../lib/colors.js';
import { TaskNode } from './TaskNode.js';
import { BundledEdge, type BundledEdgeData } from './BundledEdge.js';
import { MergeGateNode } from './MergeGateNode.js';
import { MERGE_GATE_ID, computeMergeGateStatus, findLeafTasks } from '../lib/merge-gate.js';

interface TaskDAGProps {
  tasks: Map<string, TaskState>;
  onFinish?: 'none' | 'merge' | 'pull_request';
  onTaskClick?: (task: TaskState) => void;
  onTaskDoubleClick?: (task: TaskState) => void;
  onTaskContextMenu?: (task: TaskState, event: React.MouseEvent) => void;
}

const nodeTypes = { taskNode: TaskNode, mergeGateNode: MergeGateNode };
const edgeTypes = { bundled: BundledEdge };

/** Short label for edge hover tooltip showing the dependency relationship. */
function buildEdgeLabel(source: TaskState, target: TaskState): string {
  const srcId = source.id.length > 12 ? source.id.slice(0, 12) + '..' : source.id;
  const tgtId = target.id.length > 12 ? target.id.slice(0, 12) + '..' : target.id;
  return `${srcId} → ${tgtId}`;
}

function TaskDAGInner({ tasks, onFinish, onTaskClick, onTaskDoubleClick, onTaskContextMenu }: TaskDAGProps) {
  const { fitView } = useReactFlow();
  const prevNodeCount = useRef(0);

  const onInitHandler = useCallback(() => {
    setTimeout(() => fitView({ padding: 0.2 }), 50);
  }, [fitView]);

  const { nodes, edges } = useMemo(() => {
    const taskArray = [...tasks.values()];
    if (taskArray.length === 0) return { nodes: [], edges: [] };

    // Determine if we should show the merge gate
    const showMergeGate = onFinish !== 'none' && taskArray.length > 0;
    const effectiveOnFinish = onFinish ?? 'merge';

    // Find leaf tasks (tasks that no other task depends on)
    const leaves = findLeafTasks(taskArray);

    // Build layout input: real tasks + optional synthetic merge gate
    const layoutTasks: TaskState[] = [...taskArray];
    if (showMergeGate && leaves.length > 0) {
      layoutTasks.push({
        id: MERGE_GATE_ID,
        description: effectiveOnFinish === 'pull_request' ? 'Create PR' : 'Merge to base',
        status: computeMergeGateStatus(taskArray),
        dependencies: leaves.map(t => t.id),
        createdAt: new Date(),
      });
    }

    const positions = layoutNodes(layoutTasks);

    const newNodes: Node[] = taskArray.map((task) => {
      const pos = positions.get(task.id) ?? { x: 0, y: 0 };
      return {
        id: task.id,
        type: 'taskNode',
        position: pos,
        data: { task, label: task.description },
      };
    });

    // Add merge gate node
    if (showMergeGate && leaves.length > 0) {
      const gatePos = positions.get(MERGE_GATE_ID) ?? { x: 0, y: 0 };
      newNodes.push({
        id: MERGE_GATE_ID,
        type: 'mergeGateNode',
        position: gatePos,
        data: {
          status: computeMergeGateStatus(taskArray),
          label: 'All tasks must pass',
          onFinish: effectiveOnFinish === 'pull_request' ? 'pull_request' : 'merge',
        },
      });
    }

    // Collect raw edges, then compute per-handle offsets to fan out overlapping edges.
    const rawEdges: { source: string; target: string }[] = [];
    for (const task of taskArray) {
      for (const depId of task.dependencies) {
        if (tasks.has(depId)) {
          rawEdges.push({ source: depId, target: task.id });
        }
      }
    }

    // Add edges from leaves to merge gate
    if (showMergeGate && leaves.length > 0) {
      for (const leaf of leaves) {
        rawEdges.push({ source: leaf.id, target: MERGE_GATE_ID });
      }
    }

    // Count outgoing edges per source and incoming edges per target
    const sourceOutCount = new Map<string, number>();
    const targetInCount = new Map<string, number>();
    for (const e of rawEdges) {
      sourceOutCount.set(e.source, (sourceOutCount.get(e.source) ?? 0) + 1);
      targetInCount.set(e.target, (targetInCount.get(e.target) ?? 0) + 1);
    }

    // Track current index per handle to assign offsets
    const sourceOutIndex = new Map<string, number>();
    const targetInIndex = new Map<string, number>();

    const EDGE_SPACING = 12; // pixels between fanned edges

    const newEdges: Edge<BundledEdgeData>[] = rawEdges.map((e) => {
      const srcTotal = sourceOutCount.get(e.source) ?? 1;
      const srcIdx = sourceOutIndex.get(e.source) ?? 0;
      sourceOutIndex.set(e.source, srcIdx + 1);

      const tgtTotal = targetInCount.get(e.target) ?? 1;
      const tgtIdx = targetInIndex.get(e.target) ?? 0;
      targetInIndex.set(e.target, tgtIdx + 1);

      // Center the fan: offset = (index - (total-1)/2) * spacing
      const sourceOffset = srcTotal > 1 ? (srcIdx - (srcTotal - 1) / 2) * EDGE_SPACING : 0;
      const targetOffset = tgtTotal > 1 ? (tgtIdx - (tgtTotal - 1) / 2) * EDGE_SPACING : 0;

      // Look up task state — merge gate is synthetic, not in the tasks map
      const mergeGateStatus = computeMergeGateStatus(taskArray);
      const sourceTask = tasks.get(e.source);
      const targetTask = tasks.get(e.target);
      const sourceStatus = sourceTask?.status ?? mergeGateStatus;
      const targetStatus = targetTask?.status ?? mergeGateStatus;
      const edgeStyle = getEdgeStyle(sourceStatus, targetStatus);

      // Build label for hover display
      const srcLabel = (e.source === MERGE_GATE_ID ? 'Merge' : e.source);
      const tgtLabel = (e.target === MERGE_GATE_ID ? 'Merge' : e.target);
      const truncSrc = srcLabel.length > 12 ? srcLabel.slice(0, 12) + '..' : srcLabel;
      const truncTgt = tgtLabel.length > 12 ? tgtLabel.slice(0, 12) + '..' : tgtLabel;
      const label = `${truncSrc} → ${truncTgt}`;

      return {
        id: `${e.source}->${e.target}`,
        source: e.source,
        target: e.target,
        type: 'bundled',
        animated: sourceStatus === 'running',
        style: {
          stroke: edgeStyle.stroke,
          strokeWidth: edgeStyle.strokeWidth,
          strokeDasharray: edgeStyle.strokeDasharray,
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
          label,
          hoverStroke: edgeStyle.hoverStroke,
          hoverWidth: edgeStyle.hoverWidth,
        },
      };
    });

    return { nodes: newNodes, edges: newEdges };
  }, [tasks, onFinish]);

  // Merge task-derived nodes with React Flow's internal dimension/selection state.
  // Without this, each task-delta re-render creates new node objects that discard
  // previously measured dimensions, forcing React Flow to re-measure.
  const [rfNodes, setRfNodes] = useState<Node[]>([]);

  useEffect(() => {
    setRfNodes(nodes);
  }, [nodes]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const filtered = changes.filter(c => c.type === 'dimensions' || c.type === 'select');
    if (filtered.length > 0) {
      setRfNodes(prev => applyNodeChanges(filtered, prev));
    }
  }, []);

  // Re-fit view when the actual rendered node count changes (includes merge gate)
  useEffect(() => {
    if (nodes.length !== prevNodeCount.current && nodes.length > 0) {
      prevNodeCount.current = nodes.length;
      const timer = setTimeout(() => {
        requestAnimationFrame(() => fitView({ padding: 0.2 }));
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [nodes.length, fitView]);

  // Watchdog: detect when nodes are absent from the DOM or stuck with visibility: hidden
  useEffect(() => {
    if (nodes.length === 0) return;
    const interval = setInterval(() => {
      const domNodes = document.querySelectorAll('.react-flow__node');
      const hiddenNodes = document.querySelectorAll(
        '.react-flow__node[style*="visibility: hidden"]',
      );

      if (
        (domNodes.length === 0 && nodes.length > 0) ||
        (hiddenNodes.length > 0 && hiddenNodes.length === domNodes.length)
      ) {
        console.warn(
          '[DAG-watchdog] Nodes hidden or missing, forcing fitView',
          {
            propsNodeCount: nodes.length,
            domNodeCount: domNodes.length,
            hiddenCount: hiddenNodes.length,
          },
        );
        fitView({ padding: 0.2 });
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
      <div className="h-full w-full flex items-center justify-center text-gray-500">
        <div className="text-center">
          <p>No tasks yet</p>
          <p className="text-sm mt-1">Load a plan to create a task graph</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full" style={{ minHeight: '300px' }}>
      <ReactFlow
        nodes={rfNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
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

export function TaskDAG(props: TaskDAGProps) {
  return (
    <ReactFlowProvider>
      <TaskDAGInner {...props} />
    </ReactFlowProvider>
  );
}
