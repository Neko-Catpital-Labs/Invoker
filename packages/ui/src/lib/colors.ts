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
  if (status === 'awaiting_approval' && execution?.pendingFixError) return 'fix_approval';
  if (status === 'awaiting_approval') return 'awaiting_approval';
  if (opts?.runningLike === true && (status === 'running' || status === 'pending')) {
    if (execution?.phase === 'launching') return 'assigning';
    if (execution?.phase === 'executing') return 'running_executing';
    return 'running';
  }
  if (status === 'running' && execution?.phase === 'launching') return 'assigning';
  if (status === 'running' && execution?.phase === 'executing') return 'running_executing';
  return status;
}

/**
 * Status-bar filters use keys like "running", "assigning", and "awaiting_approval".
 * Graph nodes may render with finer-grained visual states such as
 * "assigning", "running_executing", or "fix_approval".
 */
export function matchesStatusFilter(filterKey: string, visualStatus: string): boolean {
  if (filterKey === visualStatus) return true;
  if (filterKey === 'running') {
    return visualStatus === 'running' || visualStatus === 'running_executing';
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
  if (phase === 'launching') return 'Assigning';
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

const EDGE_BASE_STROKE = 'rgba(255,255,255,0.22)';
const EDGE_BASE_HOVER = 'rgba(255,255,255,0.42)';
const EDGE_MUTED_STROKE = 'rgba(255,255,255,0.14)';
const EDGE_MUTED_HOVER = 'rgba(255,255,255,0.3)';
const EDGE_COMPLETED_STROKE = 'rgba(52,211,153,0.6)';
const EDGE_COMPLETED_HOVER = 'rgba(52,211,153,0.9)';
const EDGE_RUNNING_STROKE = 'rgba(96,165,250,0.7)';
const EDGE_RUNNING_HOVER = 'rgba(147,197,253,0.95)';
const EDGE_FAILED_STROKE = 'rgba(239,68,68,0.7)';
const EDGE_FAILED_HOVER = 'rgba(248,113,113,0.95)';
const EDGE_FIXING_STROKE = 'rgba(251,146,60,0.7)';
const EDGE_FIXING_HOVER = 'rgba(253,186,116,0.95)';

export function getEdgeStyle(sourceStatus: string, targetStatus: string): EdgeStyle {
  if (sourceStatus === 'stale' || targetStatus === 'stale') {
    return {
      stroke: EDGE_MUTED_STROKE,
      strokeWidth: 1.2,
      strokeDasharray: '4 4',
      hoverStroke: EDGE_MUTED_HOVER,
      hoverWidth: 1.8,
    };
  }

  const base: EdgeStyle = {
    stroke: EDGE_BASE_STROKE,
    strokeWidth: 1.8,
    hoverStroke: EDGE_BASE_HOVER,
    hoverWidth: 2.4,
  };

  if (sourceStatus === 'completed') {
    return { ...base, stroke: EDGE_COMPLETED_STROKE, hoverStroke: EDGE_COMPLETED_HOVER, strokeWidth: 2, hoverWidth: 2.8 };
  }

  if (sourceStatus === 'pending' || sourceStatus === 'blocked') {
    return { ...base, strokeDasharray: '5 4' };
  }

  if (sourceStatus === 'failed') {
    return { ...base, stroke: EDGE_FAILED_STROKE, hoverStroke: EDGE_FAILED_HOVER, strokeDasharray: '3 4', strokeWidth: 2, hoverWidth: 2.8 };
  }

  if (sourceStatus === 'running') {
    return { ...base, stroke: EDGE_RUNNING_STROKE, hoverStroke: EDGE_RUNNING_HOVER, strokeWidth: 2 };
  }

  if (sourceStatus === 'fixing_with_ai') {
    return { ...base, stroke: EDGE_FIXING_STROKE, hoverStroke: EDGE_FIXING_HOVER, strokeWidth: 2 };
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
    queued: 'Queued',
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
