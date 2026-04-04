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

import { useState, useEffect } from 'react';
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
  const externalDeps = task.config.externalDependencies ?? [];
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
      dotClass = 'bg-green-500 animate-pulse';
    }
  }

  return (
    <div
      className={`rounded-lg border-2 px-3 py-2 w-[260px] transition-opacity duration-75 ${colors.bg} ${colors.border} ${dimmed ? 'opacity-20 pointer-events-none' : isStale ? 'opacity-50' : ''}`}
    >
      <Handle type="target" position={Position.Left} className="!bg-gray-500" />

      <div className={`font-mono text-xs opacity-60 truncate ${colors.text}`}>
        {task.config.isReconciliation && <span className="mr-1">[R]</span>}
        {task.id.length > 20 ? task.id.slice(0, 20) + '...' : task.id}
      </div>

      <div className={`text-sm font-medium truncate mt-1 ${colors.text} ${isStale ? 'line-through' : ''}`}>
        {task.description.length > 35
          ? task.description.slice(0, 35) + '...'
          : task.description}
      </div>

      {externalDeps.length > 0 && (
        <div className="mt-1">
          <span className="inline-flex items-center rounded bg-sky-900/40 border border-sky-700/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-300">
            XWF Gate x{externalDeps.length}
          </span>
        </div>
      )}

      <div className="flex items-center gap-1.5 mt-1">
        <span className={`w-2 h-2 rounded-full ${dotClass}`} />
        <span className={`text-xs uppercase ${colors.text}`}>{statusLabel}</span>
      </div>

      <Handle type="source" position={Position.Right} className="!bg-gray-500" />
    </div>
  );
}
