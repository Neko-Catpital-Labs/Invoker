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
  'closed',
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

  it.each(WORKFLOW_STATUSES)('maps %s to the canonical task palette', (status) => {
    const canonical = getStatusVisual(status);
    expect(workflowStatusVisual(status)).toEqual({
      borderClass: canonical.border,
      railClass: canonical.rail,
      textClass: canonical.text,
      pulse: canonical.pulse,
    });
  });

  it('normalizes closed as a supported workflow status', () => {
    expect(normalizeWorkflowStatus('closed')).toBe('closed');
    expect(normalizeWorkflowStatus('CLOSED')).toBe('closed');
    // Closed is terminal-neutral, not a fallback to pending.
    expect(normalizeWorkflowStatus('closed')).not.toBe('pending');
  });

  it('gives closed a non-pulsing visual distinct from failed and review_ready', () => {
    const closed = workflowStatusVisual('closed');
    const failed = workflowStatusVisual('failed');
    const reviewReady = workflowStatusVisual('review_ready');

    expect(closed.pulse).toBe(false);
    // Surfaces (border) stay uniform; identity lives in the rail dot and label text.
    expect(closed.railClass).not.toBe(failed.railClass);
    expect(closed.textClass).not.toBe(failed.textClass);
    expect(closed.railClass).not.toBe(reviewReady.railClass);
    expect(closed.textClass).not.toBe(reviewReady.textClass);
  });

});
