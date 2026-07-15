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
import type { TaskState } from '../types.js';
import { getStatusColor, getEffectiveVisualStatus } from '../lib/colors.js';

interface TaskNodeData {
  task: TaskState;
  label?: string;
  dimmed?: boolean;
  selected?: boolean;
  runningLike?: boolean;
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

  return (
    <div
      className={`relative w-[167px] overflow-hidden rounded-xl border px-2 py-2 transition-[opacity,box-shadow,border-color] duration-150 shadow-sm ${colors.bg} ${colors.border} ${selected ? 'ring-1 ring-ring/60 shadow-md' : ''} ${dimmed ? 'opacity-20 pointer-events-none' : isStale ? 'opacity-50' : ''}`}
      title={task.id}
      data-selected={selected ? 'true' : 'false'}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!w-2 !h-2 !bg-neutral-500/90 !border !border-background"
      />

      <span className={`absolute left-0 top-0 bottom-0 w-[2px] ${dotClass}`} />

      <div className={`text-[11px] font-medium leading-snug truncate pl-2 text-card-foreground ${isStale ? 'line-through opacity-70' : ''}`}>
        {task.description.length > 20
          ? `${task.description.slice(0, 20)}...`
          : task.description}
      </div>

      <div className={`mt-0.5 pl-2 text-[8px] tracking-wide ${colors.text}`}>
        {statusLabel}
      </div>

      <Handle
        type="source"
        position={Position.Right}
        className="!w-2 !h-2 !bg-neutral-500/90 !border !border-background"
      />
    </div>
  );
}
