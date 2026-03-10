/**
 * TaskNode — Custom node component for the DAG visualization.
 *
 * Renders a task card with:
 * - Truncated ID
 * - Description
 * - Status indicator dot with color
 * - Status label
 *
 * Used as a custom node type in @xyflow/react.
 */

import { Handle, Position } from '@xyflow/react';
import type { TaskState } from '../types.js';
import { getStatusColor } from '../lib/colors.js';

interface TaskNodeData {
  task: TaskState;
  label?: string;
  [key: string]: unknown;
}

interface TaskNodeProps {
  data: TaskNodeData;
}

export function TaskNode({ data }: TaskNodeProps) {
  const { task } = data;
  const colors = getStatusColor(task.status);
  const isAnimated =
    task.status === 'running' ||
    task.status === 'needs_input' ||
    task.status === 'awaiting_approval';

  const statusLabel =
    task.status === 'awaiting_approval'
      ? 'APPROVE'
      : task.isReconciliation && task.status === 'needs_input'
        ? 'SELECT'
        : task.status.toUpperCase();

  const isStale = task.status === 'stale';

  return (
    <div className={`rounded-lg border-2 px-3 py-2 w-[260px] ${colors.bg} ${colors.border} ${isStale ? 'opacity-50' : ''}`}>
      <Handle type="target" position={Position.Left} className="!bg-gray-500" />

      <div className={`font-mono text-xs opacity-60 truncate ${colors.text}`}>
        {task.isReconciliation && <span className="mr-1">[R]</span>}
        {task.id.length > 20 ? task.id.slice(0, 20) + '...' : task.id}
      </div>

      <div className={`text-sm font-medium truncate mt-1 ${colors.text} ${isStale ? 'line-through' : ''}`}>
        {task.description.length > 35
          ? task.description.slice(0, 35) + '...'
          : task.description}
      </div>

      <div className="flex items-center gap-1.5 mt-1">
        <span
          className={`w-2 h-2 rounded-full ${colors.dot} ${isAnimated ? 'animate-pulse' : ''}`}
        />
        <span className={`text-xs uppercase ${colors.text}`}>{statusLabel}</span>
      </div>

      <Handle type="source" position={Position.Right} className="!bg-gray-500" />
    </div>
  );
}
