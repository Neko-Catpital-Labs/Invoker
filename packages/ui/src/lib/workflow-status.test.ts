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

  it('normalizes uppercase fixing_with_ai because the UI type allows it', () => {
    expect(normalizeWorkflowStatus('FIXING_WITH_AI')).toBe('fixing_with_ai');
  });

  it('maps every workflow status to the canonical task visual border/rail/text/pulse', () => {
    for (const status of ALL_WORKFLOW_STATUSES) {
      const canonical = getStatusVisual(status);
      const visual = workflowStatusVisual(status);
      expect(visual).toEqual({
        borderClass: canonical.border,
        railClass: canonical.rail,
        textClass: canonical.text,
        pulse: canonical.pulse,
      });
    }
  });

  it('uses the sky/blue task palette for review_ready', () => {
    const visual = workflowStatusVisual('review_ready');
    expect(visual.borderClass).toBe('border-sky-500/55');
    expect(visual.railClass).toBe('bg-sky-400');
    expect(visual.textClass).toBe('text-sky-300');
    expect(visual.pulse).toBe(false);
  });

  it('uses the blue task palette for running and pulses', () => {
    const visual = workflowStatusVisual('running');
    expect(visual.borderClass).toBe('border-blue-400/25');
    expect(visual.railClass).toBe('bg-blue-400');
    expect(visual.textClass).toBe('text-blue-300');
    expect(visual.pulse).toBe(true);
  });
});
