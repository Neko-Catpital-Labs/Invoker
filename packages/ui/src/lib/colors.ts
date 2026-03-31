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

const STATUS_COLOR_MAP: Record<string, StatusColors> = {
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
  fixing_with_ai: {
    bg: 'bg-orange-400',
    border: 'border-orange-500',
    text: 'text-orange-950',
    dot: 'bg-orange-600',
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
    bg: 'bg-cyan-400',
    border: 'border-cyan-500',
    text: 'text-cyan-950',
    dot: 'bg-cyan-600',
  },
  awaiting_approval: {
    bg: 'bg-purple-400',
    border: 'border-purple-500',
    text: 'text-purple-950',
    dot: 'bg-purple-600',
  },
  fix_approval: {
    bg: 'bg-fuchsia-400',
    border: 'border-fuchsia-500',
    text: 'text-fuchsia-950',
    dot: 'bg-fuchsia-600',
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
    needs_input: { bg: '#22d3ee', border: '#06b6d4', text: '#083344' },
    awaiting_approval: { bg: '#c084fc', border: '#a855f7', text: '#3b0764' },
    fixing_with_ai: { bg: '#fb923c', border: '#f97316', text: '#431407' },
    fix_approval: { bg: '#e879f9', border: '#d946ef', text: '#4a044e' },
    stale: { bg: '#d1d5db', border: '#9ca3af', text: '#6b7280' },
  };

  return map[status] ?? { bg: '#e5e7eb', border: '#9ca3af', text: '#374151' };
}

/**
 * Returns the visual status key for color lookups, accounting for
 * AI-fix and fix-approval substates.
 */
export function getEffectiveVisualStatus(status: string, execution?: { isFixingWithAI?: boolean; pendingFixError?: string }): string {
  if (status === 'fixing_with_ai') return 'fixing_with_ai';
  if (status === 'running' && execution?.isFixingWithAI) return 'fixing_with_ai';
  if (status === 'awaiting_approval' && execution?.pendingFixError) return 'fix_approval';
  return status;
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
