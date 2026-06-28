import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
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
  type Edge,
  type Node,
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
  onWorkflowContextMenu: (event: MouseEvent, workflowId: string) => void;
  onOpenPlan?: () => void;
  onOpenSetup?: () => void;
  /** Fired when the user manually pans or zooms the viewport. */
  onManualViewport?: () => void;
}

interface WorkflowNodeData extends Record<string, unknown> {
  workflow: WorkflowMeta;
  selected: boolean;
  dimmed: boolean;
  coreActivity?: WorkflowCoreActivity;
}

const nodeTypes = {
  workflowNode: WorkflowFlowNode,
};
const WATCHDOG_RECOVERY_MISS_COUNT = 3;

function WorkflowGraphEmptyState({
  onOpenPlan,
  onOpenSetup,
}: {
  onOpenPlan?: () => void;
  onOpenSetup?: () => void;
}): JSX.Element {
  const suggestedCommands = [
    'plan "fix a failing test"',
    'plan "add GitHub OAuth"',
    'plan "improve the README"',
    'inspect repo',
  ];
  const firstRunSteps = [
    ['Describe a goal', 'Start from plain language or open an Invoker YAML/JSON plan.'],
    ['Review the plan', 'Check tasks, dependencies, gates, and verification before execution.'],
    ['Approve and run', 'Keep control at important gates before anything mutates.'],
  ];
  const nextStateItems = [
    ['Plan graph', 'The local task relationship appears here before the run starts.'],
    ['Task terminals', 'Logs stay attached to the task and run you are inspecting.'],
    ['Approvals', 'Schema, merge, and manual gates pause here for a decision.'],
  ];

  return (
    <div
      data-testid="workflow-empty-state"
      className="h-full w-full overflow-auto bg-[radial-gradient(circle_at_50%_0%,rgba(59,130,246,0.16),rgba(15,23,42,0)_34%),radial-gradient(circle_at_86%_18%,rgba(124,58,237,0.16),rgba(15,23,42,0)_28%),linear-gradient(135deg,#030712_0%,#07111f_54%,#050712_100%)] px-4 py-4 text-gray-200"
    >
      <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-3">
        <section className="rounded-md border border-slate-700/70 bg-slate-950/70 p-4 shadow-2xl shadow-black/25 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-blue-200">
                Invoker terminal
                <span className="ml-2 rounded border border-blue-400/40 bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-200">
                  First run
                </span>
              </div>
              <h2 className="mt-2 text-xl font-semibold text-white">
                Drive Invoker from a goal
              </h2>
            </div>
            {(onOpenPlan || onOpenSetup) && (
              <div className="flex flex-wrap gap-2">
                {onOpenPlan && (
                  <button
                    type="button"
                    onClick={onOpenPlan}
                    className="rounded-md bg-blue-600 px-3 py-2 text-xs font-medium text-white shadow-lg shadow-blue-950/30 hover:bg-blue-500"
                  >
                    Open Plan
                  </button>
                )}
                {onOpenSetup && (
                  <button
                    type="button"
                    onClick={onOpenSetup}
                    className="rounded-md border border-slate-600 bg-slate-900/80 px-3 py-2 text-xs font-medium text-slate-100 hover:bg-slate-800"
                  >
                    Check Setup
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="mt-5 rounded-md border border-blue-400/70 bg-slate-950 px-4 py-4 shadow-[0_0_30px_rgba(37,99,235,0.2)]">
            <div className="flex items-center gap-3 font-mono text-sm">
              <span className="text-emerald-300">invoker&gt;</span>
              <span className="min-w-0 flex-1 truncate text-slate-400">
                Describe a goal or command...
              </span>
              <span className="hidden rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-500 sm:inline">
                plan first
              </span>
            </div>
          </div>

          <p className="mt-4 max-w-3xl text-sm leading-6 text-slate-300">
            Invoker creates a plan first, then executes with your approval. Open an existing
            Invoker YAML or JSON plan from the rail, or start from a goal when planning is available.
          </p>

          <div className="mt-4">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Suggested commands
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {suggestedCommands.map((command) => (
                <span
                  key={command}
                  className="rounded-md border border-slate-700 bg-slate-900/80 px-2.5 py-1.5 font-mono text-xs text-slate-300"
                >
                  <span className="mr-1 text-blue-300">&gt;_</span>
                  <span>{command}</span>
                </span>
              ))}
            </div>
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-3">
            {firstRunSteps.map(([title, body], index) => (
              <div
                key={title}
                className="rounded-md border border-slate-800 bg-slate-900/70 p-3"
              >
                <div className="flex items-center gap-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-md border border-violet-400/40 bg-violet-500/10 text-xs font-semibold text-violet-200">
                    {index + 1}
                  </div>
                  <div className="text-sm font-medium text-white">{title}</div>
                </div>
                <div className="mt-2 text-xs leading-5 text-slate-400">{body}</div>
              </div>
            ))}
          </div>
        </section>

        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_320px]">
          <section className="rounded-md border border-slate-700/70 bg-slate-950/60 p-4 shadow-2xl shadow-black/20">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                Plan graph
              </div>
              <span className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-500">
                Waiting for plan
              </span>
            </div>
            <div className="mt-4 flex min-h-[185px] items-center justify-center rounded-md border border-slate-800 bg-[radial-gradient(circle_at_center,rgba(56,189,248,0.08),rgba(15,23,42,0)_46%)] px-4 py-5">
              <div className="text-center">
                <div className="mx-auto grid w-48 grid-cols-3 gap-x-3 gap-y-3">
                  <div className="col-start-2 rounded-md border border-blue-400/75 bg-blue-500/10 px-3 py-2 text-[11px] text-blue-100">
                    Goal
                  </div>
                  <div className="col-span-3 h-px bg-gradient-to-r from-transparent via-slate-600 to-transparent" />
                  <div className="rounded-md border border-emerald-400/50 bg-emerald-500/10 px-2 py-2 text-[11px] text-emerald-100">
                    Task
                  </div>
                  <div className="rounded-md border border-violet-400/50 bg-violet-500/10 px-2 py-2 text-[11px] text-violet-100">
                    Gate
                  </div>
                  <div className="rounded-md border border-amber-400/50 bg-amber-500/10 px-2 py-2 text-[11px] text-amber-100">
                    Merge
                  </div>
                </div>
                <div className="mt-4 text-sm font-medium text-white">Your plan will appear here.</div>
                <div className="mt-1 text-xs leading-5 text-slate-400">
                  Review tasks, gates, and dependencies before anything runs.
                </div>
              </div>
            </div>
          </section>

          <aside className="rounded-md border border-slate-700/70 bg-slate-950/60 p-4 shadow-2xl shadow-black/20">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-300">
              What appears next
            </div>
            <div className="mt-4 space-y-3">
              {nextStateItems.map(([title, body]) => (
                <div key={title} className="rounded-md border border-slate-800 bg-slate-900/70 p-3">
                  <div className="text-sm font-medium text-white">{title}</div>
                  <div className="mt-1 text-xs leading-5 text-slate-400">{body}</div>
                </div>
              ))}
            </div>
            <div className="mt-4 rounded-md border border-blue-400/40 bg-blue-500/10 p-3">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-blue-400/40 bg-slate-950/60 font-mono text-sm text-blue-200">
                  &gt;_
                </div>
                <div>
                  <div className="text-sm font-medium text-white">Logs appear after tasks start.</div>
                  <div className="mt-1 text-xs leading-5 text-slate-400">
                    Terminal output stays attached to each task.
                  </div>
                </div>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
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
        className="!h-2 !w-2 !border !border-slate-400 !bg-gray-900"
        isConnectable={false}
      />
      <WorkflowNode
        workflow={data.workflow}
        selected={data.selected}
        dimmed={data.dimmed}
        coreActivity={data.coreActivity}
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
  workflows,
  selectedWorkflowId,
  cameraCommand,
  statusFilters,
  coreActivityByWorkflow,
  onSelectWorkflow,
  onWorkflowContextMenu,
  onOpenPlan,
  onOpenSetup,
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
        },
      };
    });
    graphMetricsRef.current.objectsMs = performance.now() - startedAt;
    return nextNodes;
  }, [coreActivityByWorkflow, graph.nodes, positions, selectedWorkflowId, statusFilters]);

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
    return <WorkflowGraphEmptyState onOpenPlan={onOpenPlan} onOpenSetup={onOpenSetup} />;
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
