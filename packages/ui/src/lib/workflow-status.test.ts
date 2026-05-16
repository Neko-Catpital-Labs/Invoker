import { describe, expect, it } from 'vitest';
import { normalizeWorkflowStatus, workflowStatusVisual } from './workflow-status.js';
import { getStatusVisual } from './status-colors.js';
import type { WorkflowStatus } from '../types.js';

const WORKFLOW_STATUSES: readonly WorkflowStatus[] = [
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
    for (const status of WORKFLOW_STATUSES) {
      expect(normalizeWorkflowStatus(status)).toBe(status);
    }
    expect(normalizeWorkflowStatus('UNKNOWN')).toBe('pending');
    expect(normalizeWorkflowStatus(undefined)).toBe('pending');
  });

  it('normalizes mixed case input to a known workflow status', () => {
    expect(normalizeWorkflowStatus('REVIEW_READY')).toBe('review_ready');
    expect(normalizeWorkflowStatus('Fixing_With_AI')).toBe('fixing_with_ai');
  });

  it('maps every workflow status to the canonical task palette', () => {
    for (const status of WORKFLOW_STATUSES) {
      const visual = workflowStatusVisual(status);
      const canonical = getStatusVisual(status);
      expect(visual.borderClass).toBe(canonical.border);
      expect(visual.railClass).toBe(canonical.rail);
      expect(visual.textClass).toBe(canonical.text);
      expect(visual.pulse).toBe(canonical.pulse);
    }
  });

  it('uses the sky/blue review_ready treatment from the task palette', () => {
    const visual = workflowStatusVisual('review_ready');
    expect(visual.borderClass).toBe('border-sky-500/55');
    expect(visual.railClass).toBe('bg-sky-400');
    expect(visual.textClass).toBe('text-sky-300');
    expect(visual.pulse).toBe(false);
  });

  it('matches exact canonical visuals for every workflow status', () => {
    const expected: Record<WorkflowStatus, { borderClass: string; railClass: string; textClass: string; pulse: boolean }> = {
      pending: {
        borderClass: 'border-white/10',
        railClass: 'bg-slate-400',
        textClass: 'text-slate-100',
        pulse: false,
      },
      running: {
        borderClass: 'border-blue-400/25',
        railClass: 'bg-blue-400',
        textClass: 'text-blue-300',
        pulse: true,
      },
      fixing_with_ai: {
        borderClass: 'border-orange-400/25',
        railClass: 'bg-orange-400',
        textClass: 'text-orange-100',
        pulse: true,
      },
      completed: {
        borderClass: 'border-green-500/30',
        railClass: 'bg-green-500',
        textClass: 'text-green-300',
        pulse: false,
      },
      failed: {
        borderClass: 'border-red-500/55',
        railClass: 'bg-red-500',
        textClass: 'text-red-300',
        pulse: false,
      },
      blocked: {
        borderClass: 'border-slate-500/30',
        railClass: 'bg-slate-500',
        textClass: 'text-slate-300',
        pulse: false,
      },
      review_ready: {
        borderClass: 'border-sky-500/55',
        railClass: 'bg-sky-400',
        textClass: 'text-sky-300',
        pulse: false,
      },
      awaiting_approval: {
        borderClass: 'border-purple-500/55',
        railClass: 'bg-purple-400',
        textClass: 'text-purple-300',
        pulse: false,
      },
      stale: {
        borderClass: 'border-white/5',
        railClass: 'bg-slate-600',
        textClass: 'text-slate-500',
        pulse: false,
      },
    };

    for (const status of WORKFLOW_STATUSES) {
      expect(workflowStatusVisual(status)).toEqual(expected[status]);
    }
  });
});
