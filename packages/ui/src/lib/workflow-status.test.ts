import { describe, expect, it } from 'vitest';
import { normalizeWorkflowStatus, workflowStatusVisual } from './workflow-status.js';
import type { WorkflowStatus } from '../types.js';

describe('workflow-status', () => {
  it('normalizes known statuses and falls back to pending', () => {
    const statuses: WorkflowStatus[] = [
      'pending',
      'running',
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
      'completed',
      'failed',
      'blocked',
      'review_ready',
      'awaiting_approval',
      'stale',
    ];

    for (const status of statuses) {
      const visual = workflowStatusVisual(status);
      expect(visual.borderClass.length).toBeGreaterThan(0);
      expect(visual.railClass.length).toBeGreaterThan(0);
      expect(visual.textClass.length).toBeGreaterThan(0);
    }
  });
});
