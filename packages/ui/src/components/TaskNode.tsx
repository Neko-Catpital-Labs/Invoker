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

import { useEffect, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { TaskState } from '../types.js';
import { getStatusColor, getEffectiveVisualStatus } from '../lib/colors.js';

const HEARTBEAT_WARN_MS = 60_000;
const HEARTBEAT_STALE_MS = 90_000;

interface TaskNodeData {
  task: TaskState;
  label?: string;
  dimmed?: boolean;
  [key: string]: unknown;
}

interface TaskNodeProps {
  data: TaskNodeData;
}

function useHeartbeatAge(task: TaskState): number | null {
  const [age, setAge] = useState<number | null>(null);

  useEffect(() => {
    if (task.status !== 'running' || !task.execution.lastHeartbeatAt) {
      setAge(null);
      return;
    }
    const compute = () => {
      const hb = task.execution.lastHeartbeatAt instanceof Date
        ? task.execution.lastHeartbeatAt
        : new Date(task.execution.lastHeartbeatAt as unknown as string);
      setAge(Date.now() - hb.getTime());
    };
    compute();
    const timer = setInterval(compute, 10_000);
    return () => clearInterval(timer);
  }, [task.status, task.execution.lastHeartbeatAt]);

  return age;
}

export function TaskNode({ data }: TaskNodeProps) {
  const { task } = data;
  const dimmed = data.dimmed ?? false;
  const visualStatus = getEffectiveVisualStatus(task.status, task.execution);
  const colors = getStatusColor(visualStatus);
  const heartbeatAge = useHeartbeatAge(task);

  const isAnimated =
    task.status === 'running' ||
    task.status === 'needs_input' ||
    task.status === 'awaiting_approval';

  const statusLabel =
    visualStatus === 'fixing_with_ai'
      ? 'FIXING WITH AI'
      : visualStatus === 'fix_approval'
        ? 'APPROVE FIX'
        : task.status === 'awaiting_approval'
          ? 'APPROVE'
          : task.config.isReconciliation && task.status === 'needs_input'
            ? 'SELECT'
            : task.status.toUpperCase();

  const isStale = task.status === 'stale';

  let dotClass = `${colors.dot} ${isAnimated ? 'animate-pulse' : ''}`;
  if (task.status === 'running' && heartbeatAge !== null) {
    if (heartbeatAge > HEARTBEAT_STALE_MS) {
      dotClass = 'bg-red-600';
    } else if (heartbeatAge > HEARTBEAT_WARN_MS) {
      dotClass = 'bg-yellow-500 animate-pulse';
    } else {
      dotClass = 'bg-blue-400 animate-pulse';
    }
  }

  return (
    <div
      className={`relative w-[264px] rounded-2xl border px-5 py-4 transition-opacity duration-75 shadow-[0_6px_24px_rgba(0,0,0,0.28)] ${colors.bg} ${colors.border} ${dimmed ? 'opacity-20 pointer-events-none' : isStale ? 'opacity-50' : ''}`}
      title={task.id}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!w-2 !h-2 !bg-slate-500/90 !border !border-slate-900"
      />

      <span className={`absolute left-0 top-0 bottom-0 w-1.5 rounded-l-2xl ${dotClass}`} />

      <div className={`text-2xl font-medium truncate pl-3 ${colors.text} ${isStale ? 'line-through' : ''}`}>
        {task.description.length > 34
          ? `${task.description.slice(0, 34)}...`
          : task.description}
      </div>

      <div className={`mt-1 pl-3 text-sm uppercase tracking-wide ${colors.text} opacity-75`}>
        {statusLabel}
      </div>

      <Handle
        type="source"
        position={Position.Right}
        className="!w-2 !h-2 !bg-slate-500/90 !border !border-slate-900"
      />
    </div>
  );
}
