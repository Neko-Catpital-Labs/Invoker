/**
 * Maps TaskStatus to Tailwind CSS classes.
 *
 * Used by TaskNode and other components for consistent status coloring.
 */

import type { TaskStatus } from '../types.js';

export interface StatusColors {
  bg: string;
  border: string;
  text: string;
  dot: string;
}

const STATUS_COLOR_MAP: Record<TaskStatus, StatusColors> = {
  pending: {
    bg: 'bg-gray-200',
    border: 'border-gray-400',
    text: 'text-gray-700',
    dot: 'bg-gray-400',
  },
  running: {
    bg: 'bg-blue-400',
    border: 'border-blue-500',
    text: 'text-blue-950',
    dot: 'bg-blue-600',
  },
  completed: {
    bg: 'bg-green-400',
    border: 'border-green-500',
    text: 'text-green-950',
    dot: 'bg-green-600',
  },
  failed: {
    bg: 'bg-red-400',
    border: 'border-red-500',
    text: 'text-red-950',
    dot: 'bg-red-600',
  },
  blocked: {
    bg: 'bg-gray-400',
    border: 'border-gray-500',
    text: 'text-gray-800',
    dot: 'bg-gray-600',
  },
  needs_input: {
    bg: 'bg-amber-400',
    border: 'border-amber-500',
    text: 'text-amber-950',
    dot: 'bg-amber-600',
  },
  awaiting_approval: {
    bg: 'bg-purple-400',
    border: 'border-purple-500',
    text: 'text-purple-950',
    dot: 'bg-purple-600',
  },
  stale: {
    bg: 'bg-gray-300',
    border: 'border-gray-400',
    text: 'text-gray-500',
    dot: 'bg-gray-400',
  },
};

const DEFAULT_COLORS: StatusColors = {
  bg: 'bg-gray-200',
  border: 'border-gray-400',
  text: 'text-gray-700',
  dot: 'bg-gray-400',
};

/**
 * Returns the color classes for a given task status.
 * Returns default gray for unknown statuses.
 */
export function getStatusColor(status: string): StatusColors {
  return STATUS_COLOR_MAP[status as TaskStatus] ?? DEFAULT_COLORS;
}

/**
 * Returns inline style colors for use in @xyflow/react nodes,
 * which require inline styles rather than Tailwind classes.
 */
export function getStatusInlineColors(status: string): {
  bg: string;
  border: string;
  text: string;
} {
  const map: Record<string, { bg: string; border: string; text: string }> = {
    pending: { bg: '#e5e7eb', border: '#9ca3af', text: '#374151' },
    running: { bg: '#60a5fa', border: '#3b82f6', text: '#172554' },
    completed: { bg: '#4ade80', border: '#22c55e', text: '#052e16' },
    failed: { bg: '#f87171', border: '#ef4444', text: '#450a0a' },
    blocked: { bg: '#9ca3af', border: '#6b7280', text: '#1f2937' },
    needs_input: { bg: '#fbbf24', border: '#f59e0b', text: '#451a03' },
    awaiting_approval: { bg: '#c084fc', border: '#a855f7', text: '#3b0764' },
    stale: { bg: '#d1d5db', border: '#9ca3af', text: '#6b7280' },
  };

  return map[status] ?? { bg: '#e5e7eb', border: '#9ca3af', text: '#374151' };
}

/** Edge styling per status — stroke width, dash pattern, and hover color. */
export interface EdgeStyle {
  stroke: string;
  strokeWidth: number;
  strokeDasharray?: string;
  hoverStroke: string;
  hoverWidth: number;
}

export function getEdgeStyle(sourceStatus: string, targetStatus: string): EdgeStyle {
  if (sourceStatus === 'stale' || targetStatus === 'stale') {
    return {
      stroke: '#9ca3af',
      strokeWidth: 1,
      strokeDasharray: '4 4',
      hoverStroke: '#9ca3af',
      hoverWidth: 1.5,
    };
  }

  const sourceColors = getStatusInlineColors(sourceStatus);

  // Base defaults
  const base: EdgeStyle = {
    stroke: sourceColors.border,
    strokeWidth: 2,
    hoverStroke: sourceColors.bg,
    hoverWidth: 3,
  };

  // Completed → * : thicker, solid, indicating fulfilled dependency
  if (sourceStatus === 'completed') {
    return { ...base, strokeWidth: 2.5, hoverWidth: 4 };
  }

  // Pending/blocked → * : dashed to show unfulfilled path
  if (sourceStatus === 'pending' || sourceStatus === 'blocked') {
    return { ...base, strokeDasharray: '6 4' };
  }

  // Failed → * : dotted to highlight broken dependency
  if (sourceStatus === 'failed') {
    return { ...base, strokeDasharray: '3 3', strokeWidth: 2.5, hoverWidth: 4 };
  }

  // Running → * : normal solid (animation handled separately)
  return base;
}
