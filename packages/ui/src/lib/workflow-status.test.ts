import { describe, expect, it } from 'vitest';
import { normalizeWorkflowStatus, workflowStatusVisual } from './workflow-status.js';
import { getStatusVisual } from './status-colors.js';
import type { WorkflowStatus } from '../types.js';

describe('workflow-status', () => {
  it('normalizes known statuses and falls back to pending', () => {
    const statuses: WorkflowStatus[] = [
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

    for (const status of statuses) {
      expect(normalizeWorkflowStatus(status)).toBe(status);
    }
    expect(normalizeWorkflowStatus('UNKNOWN')).toBe('pending');
    expect(normalizeWorkflowStatus(undefined)).toBe('pending');
  });

  it('provides visual mapping for every workflow status', () => {
    const statuses: WorkflowStatus[] = [
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

    for (const status of statuses) {
      const visual = workflowStatusVisual(status);
      const canonical = getStatusVisual(status);
      expect(visual.borderClass.length).toBeGreaterThan(0);
      expect(visual.railClass.length).toBeGreaterThan(0);
      expect(visual.textClass.length).toBeGreaterThan(0);
      expect(visual.borderClass).toBe(canonical.border);
      expect(visual.railClass).toBe(canonical.rail);
      expect(visual.textClass).toBe(canonical.text);
      expect(visual.pulse).toBe(canonical.pulse);
    }
  });
});
