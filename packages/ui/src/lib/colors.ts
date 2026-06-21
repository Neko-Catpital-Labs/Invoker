/**
 * Maps TaskStatus to Tailwind CSS classes.
 *
 * Used by TaskNode and other components for consistent status coloring.
 */

import type { TaskStatus } from '../types.js';
import { getStatusInlineColors as getCanonicalStatusInlineColors, getStatusVisual } from './status-colors.js';

export interface StatusColors {
  bg: string;
  border: string;
  text: string;
  dot: string;
}

/**
 * Returns the color classes for a given task status.
 * Returns default gray for unknown statuses.
 */
export function getStatusColor(status: string): StatusColors {
  const visual = getStatusVisual(status);
  return {
    bg: visual.bg,
    border: visual.border,
    text: visual.text,
    dot: visual.dot,
  };
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
  return getCanonicalStatusInlineColors(status);
}

/**
 * Returns the visual status key for color lookups, accounting for
 * AI-fix and fix-approval substates.
 */
export function getEffectiveVisualStatus(
  status: string,
  execution?: { isFixingWithAI?: boolean; pendingFixError?: string; phase?: string },
  opts?: { runningLike?: boolean },
): string {
  if (status === 'fixing_with_ai') return 'fixing_with_ai';
  if (status === 'running' && execution?.isFixingWithAI) return 'fixing_with_ai';
  if (opts?.runningLike === true && execution?.phase === 'launching') return 'running_launching';
  if (opts?.runningLike === true && execution?.phase === 'executing') return 'running_executing';
  if (opts?.runningLike === true) return 'running';
  if (status === 'awaiting_approval' && execution?.pendingFixError) return 'fix_approval';
  if (status === 'running' && execution?.phase === 'launching') return 'running_launching';
  if (status === 'running' && execution?.phase === 'executing') return 'running_executing';
  return status;
}

/**
 * Status-bar filters use coarse keys like "running" and "awaiting_approval".
 * Graph nodes may render with finer-grained visual states such as
 * "running_launching", "running_executing", or "fix_approval".
 */
export function matchesStatusFilter(filterKey: string, visualStatus: string): boolean {
  if (filterKey === visualStatus) return true;
  if (filterKey === 'running') {
    return visualStatus === 'running' || visualStatus === 'running_launching' || visualStatus === 'running_executing';
  }
  if (filterKey === 'awaiting_approval') {
    return visualStatus === 'awaiting_approval' || visualStatus === 'fix_approval';
  }
  if (filterKey === 'fixing_with_ai') {
    return visualStatus === 'fixing_with_ai';
  }
  return false;
}

export function getRunningPhaseLabel(phase?: string): string | null {
  if (phase === 'launching') return 'Launching';
  if (phase === 'executing') return 'Executing';
  return null;
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
    const stale = getStatusVisual('stale').inline;
    return {
      stroke: stale.border,
      strokeWidth: 1,
      strokeDasharray: '4 4',
      hoverStroke: stale.bg,
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
    const completed = getStatusVisual('completed').inline;
    return { ...base, stroke: completed.border, hoverStroke: completed.bg, strokeWidth: 2.2, hoverWidth: 3 };
  }

  // Pending/blocked → * : dashed to show unfulfilled path
  if (sourceStatus === 'pending' || sourceStatus === 'blocked') {
    return { ...base, strokeDasharray: '5 4' };
  }

  // Failed → * : dotted to highlight broken dependency
  if (sourceStatus === 'failed') {
    const failed = getStatusVisual('failed').inline;
    return { ...base, stroke: failed.border, hoverStroke: failed.bg, strokeDasharray: '3 4', strokeWidth: 2.1, hoverWidth: 3 };
  }

  // Running → * : normal solid (animation handled separately)
  if (sourceStatus === 'running' || sourceStatus === 'fixing_with_ai') {
    const running = getStatusVisual(sourceStatus).inline;
    return { ...base, stroke: running.border, hoverStroke: running.bg };
  }

  return base;
}

/**
 * Formats a TaskStatus into Title Case for display in the UI.
 * Unknown statuses fall back to the raw string.
 */
export function formatStatusLabel(status: TaskStatus): string {
  const labelMap: Record<TaskStatus, string> = {
    pending: 'Pending',
    running: 'Running',
    review_ready: 'Review Ready',
    awaiting_approval: 'Awaiting Approval',
    completed: 'Completed',
    failed: 'Failed',
    closed: 'Closed',
    blocked: 'Blocked',
    stale: 'Stale',
    needs_input: 'Needs Input',
    fixing_with_ai: 'Fixing With AI',
  };
  return labelMap[status] ?? status;
}
