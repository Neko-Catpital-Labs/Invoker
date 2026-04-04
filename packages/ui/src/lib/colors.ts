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
    bg: 'bg-slate-800/95',
    border: 'border-white/10',
    text: 'text-slate-100',
    dot: 'bg-slate-400',
  },
  running: {
    bg: 'bg-slate-800/95',
    border: 'border-blue-400/25',
    text: 'text-slate-100',
    dot: 'bg-blue-400',
  },
  fixing_with_ai: {
    bg: 'bg-slate-800/95',
    border: 'border-sky-400/20',
    text: 'text-slate-100',
    dot: 'bg-sky-400',
  },
  completed: {
    bg: 'bg-slate-800/95',
    border: 'border-green-500/30',
    text: 'text-slate-100',
    dot: 'bg-green-500',
  },
  failed: {
    bg: 'bg-red-500/20',
    border: 'border-red-500/55',
    text: 'text-red-100',
    dot: 'bg-red-500',
  },
  blocked: {
    bg: 'bg-slate-800/95',
    border: 'border-slate-500/30',
    text: 'text-slate-300',
    dot: 'bg-slate-500',
  },
  needs_input: {
    bg: 'bg-orange-950/30',
    border: 'border-orange-400/25',
    text: 'text-orange-100',
    dot: 'bg-orange-400',
  },
  awaiting_approval: {
    bg: 'bg-purple-500/20',
    border: 'border-purple-500/55',
    text: 'text-purple-100',
    dot: 'bg-purple-400',
  },
  fix_approval: {
    bg: 'bg-fuchsia-500/20',
    border: 'border-fuchsia-500/55',
    text: 'text-fuchsia-100',
    dot: 'bg-fuchsia-500',
  },
  stale: {
    bg: 'bg-slate-900/80',
    border: 'border-white/5',
    text: 'text-slate-500',
    dot: 'bg-slate-600',
  },
};

const DEFAULT_COLORS: StatusColors = {
  bg: 'bg-slate-800/95',
  border: 'border-white/10',
  text: 'text-slate-100',
  dot: 'bg-slate-400',
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
    pending: { bg: '#4b5563', border: '#3f4859', text: '#f8fafc' },
    running: { bg: '#60a5fa', border: '#2f5f8f', text: '#ecfeff' },
    completed: { bg: '#22c55e', border: '#1f7a45', text: '#ecfeff' },
    failed: { bg: '#f87171', border: '#ef4444', text: '#fee2e2' },
    blocked: { bg: '#64748b', border: '#475569', text: '#e2e8f0' },
    needs_input: { bg: '#fb923c', border: '#9a4f0a', text: '#ffedd5' },
    awaiting_approval: { bg: '#c084fc', border: '#a855f7', text: '#ede9fe' },
    fixing_with_ai: { bg: '#7dd3fc', border: '#2c6f90', text: '#e0f2fe' },
    fix_approval: { bg: '#e879f9', border: '#d946ef', text: '#fae8ff' },
    stale: { bg: '#475569', border: '#374151', text: '#94a3b8' },
  };

  return map[status] ?? { bg: '#4b5563', border: '#3f4859', text: '#f8fafc' };
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
      stroke: '#50596b',
      strokeWidth: 1,
      strokeDasharray: '4 4',
      hoverStroke: '#64748b',
      hoverWidth: 1.5,
    };
  }

  // Base defaults
  const base: EdgeStyle = {
    stroke: '#3b4454',
    strokeWidth: 1.8,
    hoverStroke: '#55607a',
    hoverWidth: 2.4,
  };

  // Completed → * : thicker, solid, indicating fulfilled dependency
  if (sourceStatus === 'completed') {
    return { ...base, stroke: '#2f855a', hoverStroke: '#34d399', strokeWidth: 2.2, hoverWidth: 3 };
  }

  // Pending/blocked → * : dashed to show unfulfilled path
  if (sourceStatus === 'pending' || sourceStatus === 'blocked') {
    return { ...base, strokeDasharray: '5 4' };
  }

  // Failed → * : dotted to highlight broken dependency
  if (sourceStatus === 'failed') {
    return { ...base, stroke: '#9f2d2d', hoverStroke: '#f87171', strokeDasharray: '3 4', strokeWidth: 2.1, hoverWidth: 3 };
  }

  // Running → * : normal solid (animation handled separately)
  if (sourceStatus === 'running' || sourceStatus === 'fixing_with_ai') {
    return { ...base, stroke: '#3f6f8f', hoverStroke: '#7dd3fc' };
  }

  return base;
}
