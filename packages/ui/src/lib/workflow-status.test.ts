import { describe, expect, it } from 'vitest';
import { normalizeWorkflowStatus, workflowStatusVisual } from './workflow-status.js';
import { getStatusVisual } from './status-colors.js';
import type { WorkflowStatus } from '../types.js';

const ALL_WORKFLOW_STATUSES: WorkflowStatus[] = [
  'pending',
  'running',
  'fixing_with_ai',
  'completed',
  'failed',
  'blocked',
  'review_ready',
  'awaiting_approval',
  'stale',
];

describe('workflow-status', () => {
  it('normalizes known statuses and falls back to pending', () => {
    for (const status of ALL_WORKFLOW_STATUSES) {
      expect(normalizeWorkflowStatus(status)).toBe(status);
    }
    expect(normalizeWorkflowStatus('UNKNOWN')).toBe('pending');
    expect(normalizeWorkflowStatus(undefined)).toBe('pending');
  });

  it('treats fixing_with_ai as a known workflow status', () => {
    expect(normalizeWorkflowStatus('fixing_with_ai')).toBe('fixing_with_ai');
  });

  it('maps every workflow status to the canonical status-colors visual', () => {
    for (const status of ALL_WORKFLOW_STATUSES) {
      const canonical = getStatusVisual(status);
      expect(workflowStatusVisual(status)).toEqual({
        borderClass: canonical.border,
        railClass: canonical.rail,
        textClass: canonical.text,
        pulse: canonical.pulse,
      });
    }
  });

  it('uses the task palette sky/blue treatment for review_ready', () => {
    const visual = workflowStatusVisual('review_ready');
    expect(visual.borderClass).toBe('border-sky-500/55');
    expect(visual.railClass).toBe('bg-sky-400');
    expect(visual.textClass).toBe('text-sky-300');
    expect(visual.pulse).toBe(false);
  });

  it('exposes deterministic visual fields for each status', () => {
    expect(workflowStatusVisual('pending')).toEqual({
      borderClass: 'border-white/10',
      railClass: 'bg-slate-400',
      textClass: 'text-slate-100',
      pulse: false,
    });
    expect(workflowStatusVisual('running')).toEqual({
      borderClass: 'border-blue-400/25',
      railClass: 'bg-blue-400',
      textClass: 'text-blue-300',
      pulse: true,
    });
    expect(workflowStatusVisual('fixing_with_ai')).toEqual({
      borderClass: 'border-orange-400/25',
      railClass: 'bg-orange-400',
      textClass: 'text-orange-100',
      pulse: true,
    });
    expect(workflowStatusVisual('completed')).toEqual({
      borderClass: 'border-green-500/30',
      railClass: 'bg-green-500',
      textClass: 'text-green-300',
      pulse: false,
    });
    expect(workflowStatusVisual('failed')).toEqual({
      borderClass: 'border-red-500/55',
      railClass: 'bg-red-500',
      textClass: 'text-red-300',
      pulse: false,
    });
    expect(workflowStatusVisual('blocked')).toEqual({
      borderClass: 'border-slate-500/30',
      railClass: 'bg-slate-500',
      textClass: 'text-slate-300',
      pulse: false,
    });
    expect(workflowStatusVisual('awaiting_approval')).toEqual({
      borderClass: 'border-purple-500/55',
      railClass: 'bg-purple-400',
      textClass: 'text-purple-300',
      pulse: false,
    });
    expect(workflowStatusVisual('stale')).toEqual({
      borderClass: 'border-white/5',
      railClass: 'bg-slate-600',
      textClass: 'text-slate-500',
      pulse: false,
    });
  });
});
