import { useMemo, useRef, useState } from 'react';
import type { MouseEvent, PointerEvent } from 'react';
import type { TaskState, WorkflowMeta, WorkflowStatus } from '../types.js';
import { deriveWorkflowGraph, layoutWorkflowGraph } from '../lib/workflow-graph.js';
import { WorkflowNode } from './WorkflowNode.js';

interface WorkflowGraphProps {
  tasks: Map<string, TaskState>;
  workflows: Map<string, WorkflowMeta>;
  selectedWorkflowId: string | null;
  statusFilters: Set<WorkflowStatus>;
  onSelectWorkflow: (workflowId: string) => void;
  onWorkflowContextMenu: (event: MouseEvent<HTMLDivElement>, workflowId: string) => void;
}

export function WorkflowGraph({
  tasks,
  workflows,
  selectedWorkflowId,
  statusFilters,
  onSelectWorkflow,
  onWorkflowContextMenu,
}: WorkflowGraphProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);
  const pannedRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const graph = useMemo(() => deriveWorkflowGraph(workflows, tasks), [workflows, tasks]);
  const positions = useMemo(() => layoutWorkflowGraph(graph), [graph]);
  const width = Math.max(1400, ...[...positions.values()].map((position) => position.x + 320));
  const height = Math.max(900, ...[...positions.values()].map((position) => position.y + 220));

  if (graph.nodes.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-gray-500 text-sm">
        Load a plan to render workflow graph
      </div>
    );
  }

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('[data-testid^="workflow-node-"], [role="menu"], button, a, input, textarea, select')) {
      return;
    }
    const scroller = scrollRef.current;
    if (!scroller) return;
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      scrollLeft: scroller.scrollLeft,
      scrollTop: scroller.scrollTop,
    };
    pannedRef.current = false;
    setDragging(true);
    scroller.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const scroller = scrollRef.current;
    if (!drag || !scroller || drag.pointerId !== event.pointerId) return;
    if (Math.abs(event.clientX - drag.x) > 3 || Math.abs(event.clientY - drag.y) > 3) {
      pannedRef.current = true;
    }
    scroller.scrollLeft = drag.scrollLeft - (event.clientX - drag.x);
    scroller.scrollTop = drag.scrollTop - (event.clientY - drag.y);
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const scroller = scrollRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (scroller?.hasPointerCapture(event.pointerId)) {
      scroller.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setDragging(false);
  };

  return (
    <div
      ref={scrollRef}
      className={`h-full w-full overflow-auto ${dragging ? 'cursor-grabbing select-none' : 'cursor-grab'}`}
      data-testid="workflow-graph-scroll"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClick={(event) => {
        if (!pannedRef.current) return;
        pannedRef.current = false;
        event.stopPropagation();
      }}
    >
      <div className="relative" style={{ width, height }}>
        <svg className="absolute inset-0 pointer-events-none" width={width} height={height}>
          {graph.edges.map((edge) => {
            const source = positions.get(edge.source);
            const target = positions.get(edge.target);
            if (!source || !target) return null;
            const x1 = source.x + 220;
            const y1 = source.y + 58;
            const x2 = target.x;
            const y2 = target.y + 58;
            const cx1 = x1 + Math.max(50, (x2 - x1) * 0.4);
            const cx2 = x2 - Math.max(50, (x2 - x1) * 0.4);
            return (
              <path
                key={`${edge.source}-${edge.target}`}
                d={`M ${x1} ${y1} C ${cx1} ${y1}, ${cx2} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke="rgba(148,163,184,0.55)"
                strokeWidth={2}
              />
            );
          })}
        </svg>

        {graph.nodes.map((node) => {
          const position = positions.get(node.id) ?? { x: 80, y: 80 };
          const dimmed = statusFilters.size > 0 && !statusFilters.has(node.workflow.status);
          return (
            <div
              key={node.id}
              className="absolute"
              style={{ left: position.x, top: position.y }}
            >
              <WorkflowNode
                workflow={node.workflow}
                selected={selectedWorkflowId === node.id}
                dimmed={dimmed}
                onClick={() => onSelectWorkflow(node.id)}
                onContextMenu={(event) => onWorkflowContextMenu(event, node.id)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
