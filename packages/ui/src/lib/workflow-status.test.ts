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

});
