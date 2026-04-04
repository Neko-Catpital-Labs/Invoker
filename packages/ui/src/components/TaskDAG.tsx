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

import type { TaskState, WorkflowMeta } from '../types.js';
import { layoutNodes } from '../lib/layout.js';
import { getEdgeStyle, getEffectiveVisualStatus } from '../lib/colors.js';
import { TaskNode } from './TaskNode.js';
import { BundledEdge, type BundledEdgeData } from './BundledEdge.js';
import { MergeGateNode } from './MergeGateNode.js';
import {
  isMergeGateId,
  groupTasksByWorkflow,
  sortedWorkflowGroups,
  resolveMergeGateKind,
  mergeGatePlanTitle,
} from '../lib/merge-gate.js';

interface TaskDAGProps {
  tasks: Map<string, TaskState>;
  workflows?: Map<string, WorkflowMeta>;
  onTaskClick?: (task: TaskState) => void;
  onTaskDoubleClick?: (task: TaskState) => void;
  onTaskContextMenu?: (task: TaskState, event: React.MouseEvent) => void;
  statusFilters?: Set<string>;
}

const nodeTypes = { taskNode: TaskNode, mergeGateNode: MergeGateNode };
const edgeTypes = { bundled: BundledEdge };

/** Short label for edge hover tooltip showing the dependency relationship. */
function buildEdgeLabel(source: TaskState, target: TaskState, kind: 'local' | 'external'): string {
  const srcId = source.id.length > 12 ? source.id.slice(0, 12) + '..' : source.id;
  const tgtId = target.id.length > 12 ? target.id.slice(0, 12) + '..' : target.id;
  if (kind === 'external') {
    return `external: ${srcId} → ${tgtId}`;
  }
  return `${srcId} → ${tgtId}`;
}

function resolveExternalDependencyTaskId(
  dep: { workflowId: string; taskId: string },
  tasks: Map<string, TaskState>,
): string | undefined {
  if (dep.taskId.includes('/')) {
    return tasks.has(dep.taskId) ? dep.taskId : undefined;
  }
  const scoped = `${dep.workflowId}/${dep.taskId}`;
  if (tasks.has(scoped)) return scoped;
  if (tasks.has(dep.taskId)) return dep.taskId;
  return undefined;
}

function TaskDAGInner({ tasks, workflows, onTaskClick, onTaskDoubleClick, onTaskContextMenu, statusFilters }: TaskDAGProps) {
  const { fitView } = useReactFlow();
  const prevNodeCount = useRef(0);

  const onInitHandler = useCallback(() => {
    setTimeout(() => fitView({ padding: 0.2 }), 50);
  }, [fitView]);

  const { nodes, edges } = useMemo(() => {
    const taskArray = [...tasks.values()];
    if (taskArray.length === 0) return { nodes: [], edges: [] };

    const workflowGroups = groupTasksByWorkflow(taskArray);

    const allNodes: Node[] = [];
    const allRawEdges: Array<{ source: string; target: string; kind: 'local' | 'external' }> = [];
    const gateStatuses = new Map<string, ReturnType<typeof computeMergeGateStatus>>();

    let yOffset = 0;
    const WORKFLOW_GAP = 100;

    for (const [wfGroupId, wfTasksRaw] of sortedWorkflowGroups(workflowGroups)) {
      const wfTasks = [...wfTasksRaw].sort((a, b) => a.id.localeCompare(b.id));
      const wfMeta = workflows?.get(wfGroupId);
      const wfBaseBranch = wfMeta?.baseBranch;
      const wfMergeMode = (wfMeta?.mergeMode as 'manual' | 'automatic' | 'external_review') ?? 'manual';
      const positions = layoutNodes(wfTasks);

      // Find bounding box to apply yOffset
      let minY = Infinity;
      let maxY = -Infinity;
      for (const pos of positions.values()) {
        if (pos.y < minY) minY = pos.y;
        if (pos.y > maxY) maxY = pos.y;
      }

      for (const task of wfTasks) {
        const pos = positions.get(task.id) ?? { x: 0, y: 0 };
        if (task.config.isMergeNode) {
          gateStatuses.set(task.id, task.status);
          let gateKind = resolveMergeGateKind(task, wfMeta);
          if (wfMergeMode === 'external_review') {
            gateKind = 'external_review';
          }
          const showMergeModeRow = gateKind !== 'external_review';
          const mergeVisualStatus = getEffectiveVisualStatus(task.status, task.execution);
          const mergeGateDimmed = statusFilters && statusFilters.size > 0 && !statusFilters.has(mergeVisualStatus);
          allNodes.push({
            id: task.id,
            type: 'mergeGateNode',
            position: { x: pos.x, y: pos.y + yOffset },
            data: {
              taskId: task.id,
              status: task.status,
              label: mergeGatePlanTitle(task.description),
              gateKind,
              showMergeModeRow,
              baseBranch: wfBaseBranch,
              featureBranch: wfMeta?.featureBranch,
              mergeMode: wfMergeMode,
              workflowId: wfGroupId,
              reviewUrl: task.execution?.reviewUrl,
              reviewStatus: task.execution?.reviewStatus,
              summary: task.config?.summary,
              onFinish: wfMeta?.onFinish,
              pendingFixError: task.execution?.pendingFixError,
              dimmed: mergeGateDimmed,
            },
          });
        } else {
          const taskVisualStatus = getEffectiveVisualStatus(task.status, task.execution);
          const taskDimmed = statusFilters && statusFilters.size > 0 && !statusFilters.has(taskVisualStatus);
          allNodes.push({
            id: task.id,
            type: 'taskNode',
            position: { x: pos.x, y: pos.y + yOffset },
            data: { task, label: task.description, dimmed: taskDimmed },
          });
        }
      }

      for (const task of wfTasks) {
        for (const depId of task.dependencies) {
          if (tasks.has(depId)) {
            allRawEdges.push({ source: depId, target: task.id, kind: 'local' });
          }
        }

        for (const dep of task.config.externalDependencies ?? []) {
          const sourceId = resolveExternalDependencyTaskId(dep, tasks);
          if (!sourceId || sourceId === task.id) continue;
          allRawEdges.push({ source: sourceId, target: task.id, kind: 'external' });
        }
      }

      const groupHeight = maxY === -Infinity ? 0 : maxY - minY + 80;
      yOffset += groupHeight + WORKFLOW_GAP;
    }

    // Build dimmed node set for edge opacity
    const dimmedNodeIds = new Set<string>();
    if (statusFilters && statusFilters.size > 0) {
      for (const task of taskArray) {
        const vs = getEffectiveVisualStatus(task.status, task.execution);
        if (!statusFilters.has(vs)) {
          dimmedNodeIds.add(task.id);
        }
      }
    }

    // Build edges with offset calculations
    const sourceOutCount = new Map<string, number>();
    const targetInCount = new Map<string, number>();
    for (const e of allRawEdges) {
      sourceOutCount.set(e.source, (sourceOutCount.get(e.source) ?? 0) + 1);
      targetInCount.set(e.target, (targetInCount.get(e.target) ?? 0) + 1);
    }

    const sourceOutIndex = new Map<string, number>();
    const targetInIndex = new Map<string, number>();
    const EDGE_SPACING = 12;

    const newEdges: Edge<BundledEdgeData>[] = allRawEdges.map((e) => {
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
      const sourceStatus = sourceTask?.status ?? gateStatuses.get(e.source) ?? 'pending';
      const targetStatus = targetTask?.status ?? gateStatuses.get(e.target) ?? 'pending';
      const edgeStyle = getEdgeStyle(sourceStatus, targetStatus);

      const label =
        sourceTask && targetTask
          ? buildEdgeLabel(sourceTask, targetTask, e.kind)
          : `${e.source} → ${e.target}`;

      const edgeDimmed = dimmedNodeIds.has(e.source) || dimmedNodeIds.has(e.target);
      const isExternal = e.kind === 'external';
      const strokeColor = isExternal ? '#0ea5e9' : edgeStyle.stroke;

      return {
        id: `${e.kind}:${e.source}->${e.target}`,
        source: e.source,
        target: e.target,
        type: 'bundled',
        animated: sourceStatus === 'running' && targetStatus !== 'stale' && !isExternal,
        style: {
          stroke: strokeColor,
          strokeWidth: isExternal ? Math.max(1.5, edgeStyle.strokeWidth - 0.5) : edgeStyle.strokeWidth,
          strokeDasharray: isExternal ? '5 4' : edgeStyle.strokeDasharray,
          opacity: edgeDimmed ? 0.15 : 1,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: strokeColor,
          width: 16,
          height: 16,
        },
        data: {
          sourceOffset,
          targetOffset,
          sourceStatus,
          targetStatus,
          label,
          hoverStroke: isExternal ? '#38bdf8' : edgeStyle.hoverStroke,
          hoverWidth: edgeStyle.hoverWidth,
        },
      };
    });

    return { nodes: allNodes, edges: newEdges };
  }, [tasks, workflows, statusFilters]);

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
