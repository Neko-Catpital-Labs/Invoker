/**
 * TaskNode — Custom node component for the DAG visualization.
 *
 * Renders a task card with:
 * - Truncated ID
 * - Description
 * - Status indicator dot with color and heartbeat liveness
 * - Status label
 *
 * Used as a custom node type in @xyflow/react.
 */

import { Handle, Position } from '@xyflow/react';
import type { MouseEvent } from 'react';
import type { TaskState } from '../types.js';
import { getStatusColor, getEffectiveVisualStatus } from '../lib/colors.js';

interface TaskNodeData {
  task: TaskState;
  label?: string;
  dimmed?: boolean;
  selected?: boolean;
  runningLike?: boolean;
  onDoubleClick?: (task: TaskState) => void;
  [key: string]: unknown;
}

interface TaskNodeProps {
  data: TaskNodeData;
}

const TASK_NODE_STATUS_LABELS: Record<string, string> = {
  assigning: 'Assigning',
  awaiting_approval: 'Approve',
  fix_approval: 'Approve fix',
  fixing_with_ai: 'Fixing with AI',
  running: 'Running',
  running_executing: 'Running · Executing',
};

function humanizeStatus(status: string): string {
  const label = status.replace(/_/g, ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function getTaskNodeStatusLabel(task: TaskState, visualStatus: string): string {
  if (task.config.isReconciliation && task.status === 'needs_input') return 'Select';
  return TASK_NODE_STATUS_LABELS[visualStatus] ?? humanizeStatus(task.status);
}

export function TaskNode({ data }: TaskNodeProps) {
  const { task } = data;
  const dimmed = data.dimmed ?? false;
  const selected = data.selected ?? false;
  const visualStatus = getEffectiveVisualStatus(task.status, task.execution, { runningLike: data.runningLike });
  const colors = getStatusColor(visualStatus);

  const isAnimated =
    data.runningLike === true ||
    task.status === 'running' ||
    task.status === 'needs_input' ||
    task.status === 'awaiting_approval';

  const statusLabel = getTaskNodeStatusLabel(task, visualStatus);

  const isStale = task.status === 'stale';
  const dotClass = `${colors.dot} ${isAnimated ? 'pulse-strong' : ''}`;
  const handleDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!data.onDoubleClick) return;
    event.stopPropagation();
    data.onDoubleClick(task);
  };

  return (
    <div
      className={`relative w-[312px] overflow-hidden rounded-xl border px-4 py-4 transition-[opacity,box-shadow,border-color] duration-150 shadow-sm ${colors.bg} ${colors.border} ${selected ? 'ring-1 ring-ring/60 shadow-md' : ''} ${dimmed ? 'opacity-20 pointer-events-none' : isStale ? 'opacity-50' : ''}`}
      title={task.id}
      data-selected={selected ? 'true' : 'false'}
      onDoubleClick={handleDoubleClick}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!w-2.5 !h-2.5 !bg-neutral-500/90 !border !border-background"
      />

      <span className={`absolute left-0 top-0 bottom-0 w-[3px] ${dotClass}`} />

      <div className={`text-[20px] font-medium leading-snug truncate pl-3 text-card-foreground ${isStale ? 'line-through opacity-70' : ''}`}>
        {task.description.length > 40
          ? `${task.description.slice(0, 40)}...`
          : task.description}
      </div>

      <div className={`mt-1.5 pl-3 text-[15px] tracking-wide ${colors.text}`}>
        {statusLabel}
      </div>

      <Handle
        type="source"
        position={Position.Right}
        className="!w-2.5 !h-2.5 !bg-neutral-500/90 !border !border-background"
      />
    </div>
  );
}
