import { useEffect, useMemo, useState } from 'react';
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { ActionGraphNode, ActionGraphResponse } from '@invoker/contracts';

interface ActionGraphViewProps {
  selectedNodeId: string | null;
  onSelectNode: (node: ActionGraphNode | null) => void;
}

const NODE_WIDTH = 230;
const X_GAP = 300;
const Y_GAP = 125;

const statusClasses: Record<ActionGraphNode['status'], string> = {
  queued: 'border-amber-500/70 bg-amber-950/35 text-amber-100',
  pending: 'border-gray-600 bg-gray-800 text-gray-200',
  running: 'border-blue-500/70 bg-blue-950/35 text-blue-100',
  waiting: 'border-violet-500/70 bg-violet-950/35 text-violet-100',
  stalled: 'border-orange-500/80 bg-orange-950/45 text-orange-100',
  failed: 'border-red-500/80 bg-red-950/45 text-red-100',
  cancelled: 'border-gray-600 bg-gray-800/60 text-gray-400',
  completed: 'border-green-500/70 bg-green-950/35 text-green-100',
};

const typeOrder: Record<ActionGraphNode['type'], number> = {
  'user-action': 0,
  'mutation-intent': 1,
  'mutation-lease': 2,
  'scheduler-job': 2,
  'task-attempt': 3,
  blocker: 4,
};

function formatDuration(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms)) return null;
  const abs = Math.max(0, Math.abs(ms));
  if (abs < 1_000) return `${Math.round(abs)}ms`;
  if (abs < 60_000) return `${Math.round(abs / 1_000)}s`;
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m`;
  return `${Math.round(abs / 3_600_000)}h`;
}

function primaryDurationLabel(node: ActionGraphNode): string {
  const durations = node.durations ?? {};
  if (node.status === 'queued') return `queued ${formatDuration(durations.queuedMs) ?? ''}`.trim();
  if (node.status === 'pending') return `pending ${formatDuration(durations.pendingMs) ?? ''}`.trim();
  if (node.status === 'waiting') return `waiting ${formatDuration(durations.waitingMs) ?? ''}`.trim();
  if (node.status === 'stalled') return `stalled ${formatDuration(durations.stalledMs) ?? ''}`.trim();
  if (node.status === 'running' && durations.heartbeatAgeMs !== undefined) {
    return `heartbeat ${formatDuration(durations.heartbeatAgeMs)} ago`;
  }
  if (node.status === 'running') return `running ${formatDuration(durations.runningMs) ?? ''}`.trim();
  return node.status;
}

function ActionNode({ data }: { data: { node: ActionGraphNode; selected: boolean } }): JSX.Element {
  const node = data.node;
  const className = statusClasses[node.status];
  return (
    <div
      className={`w-[230px] rounded border px-3 py-2 shadow-sm ${className} ${data.selected ? 'ring-2 ring-white/70' : ''}`}
      data-testid={`action-graph-node-${node.id}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="truncate text-xs font-semibold">{node.label}</div>
        <span className="shrink-0 rounded border border-current/30 px-1.5 py-0.5 text-[10px] uppercase">
          {node.status}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] opacity-80">
        <span className="truncate">{node.type.replace('-', ' ')}</span>
        <span className="shrink-0">{primaryDurationLabel(node)}</span>
      </div>
      {node.latestError && (
        <div className="mt-1 truncate text-[11px] text-red-100/90">{node.latestError}</div>
      )}
    </div>
  );
}

const nodeTypes = { actionNode: ActionNode };

function layoutGraph(graph: ActionGraphResponse | null, selectedNodeId: string | null): { nodes: Node[]; edges: Edge[] } {
  if (!graph) return { nodes: [], edges: [] };
  const buckets = new Map<number, ActionGraphNode[]>();
  for (const node of graph.nodes) {
    const level = typeOrder[node.type] ?? 0;
    const items = buckets.get(level) ?? [];
    items.push(node);
    buckets.set(level, items);
  }

  const nodes: Node[] = [];
  for (const [level, bucket] of [...buckets.entries()].sort(([a], [b]) => a - b)) {
    bucket
      .sort((a, b) => (a.workflowId ?? '').localeCompare(b.workflowId ?? '') || a.label.localeCompare(b.label))
      .forEach((node, index) => {
        nodes.push({
          id: node.id,
          type: 'actionNode',
          position: { x: level * X_GAP + 40, y: index * Y_GAP + 40 },
          data: { node, selected: node.id === selectedNodeId },
          style: { width: NODE_WIDTH },
        });
      });
  }

  return {
    nodes,
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label,
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { stroke: 'rgba(148, 163, 184, 0.65)' },
    })),
  };
}

function ActionGraphInner({ selectedNodeId, onSelectNode }: ActionGraphViewProps): JSX.Element {
  const [graph, setGraph] = useState<ActionGraphResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      window.invoker?.getActionGraph?.()
        .then((response) => {
          if (!alive) return;
          setGraph(response);
          setError(null);
        })
        .catch((err) => {
          if (!alive) return;
          setError(err instanceof Error ? err.message : String(err));
        });
    };
    load();
    const interval = setInterval(load, 5_000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, []);

  const rendered = useMemo(() => layoutGraph(graph, selectedNodeId), [graph, selectedNodeId]);

  if (error) {
    return <div className="h-full p-4 text-sm text-red-300">Action Graph failed to load: {error}</div>;
  }
  if (!graph) {
    return <div className="h-full flex items-center justify-center text-sm text-gray-500">Loading Action Graph</div>;
  }
  if (graph.nodes.length === 0) {
    return <div className="h-full flex items-center justify-center text-sm text-gray-500">No actions recorded</div>;
  }

  return (
    <div className="h-full" data-testid="action-graph-view">
      <ReactFlow
        nodes={rendered.nodes}
        edges={rendered.edges}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.2}
        maxZoom={1.4}
        onNodeClick={(_event, node) => {
          const actionNode = graph.nodes.find((item) => item.id === node.id) ?? null;
          onSelectNode(actionNode);
        }}
        onPaneClick={() => onSelectNode(null)}
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}

export function ActionGraphView(props: ActionGraphViewProps): JSX.Element {
  return (
    <ReactFlowProvider>
      <ActionGraphInner {...props} />
    </ReactFlowProvider>
  );
}

