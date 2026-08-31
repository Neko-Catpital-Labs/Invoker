import { describe, it, expect } from 'vitest';
import type { TaskStatus, WorkflowDerivedStatus } from '@invoker/workflow-core';
import {
  IDLE_WORKFLOW_RETENTION_MS,
  isInactiveCleanupTaskStatus,
  isInactiveCleanupWorkflowStatus,
  isWorkflowPastRetention,
} from '../workers/idle-task-cleanup-policy.js';

const NOW = new Date('2026-08-15T12:00:00.000Z').getTime();

describe('isInactiveCleanupTaskStatus', () => {
  it.each(['completed', 'failed', 'closed', 'stale'] as const)('accepts terminal status %s', (status) => {
    expect(isInactiveCleanupTaskStatus(status)).toBe(true);
  });

  it.each([
    'pending',
    'queued',
    'running',
    'fixing_with_ai',
    'needs_input',
    'blocked',
    'review_ready',
    'awaiting_approval',
  ] as const)('retains non-terminal status %s', (status) => {
    expect(isInactiveCleanupTaskStatus(status)).toBe(false);
  });

  it('retains an unknown status', () => {
    expect(isInactiveCleanupTaskStatus('new-future-status' as TaskStatus)).toBe(false);
  });
});

describe('isInactiveCleanupWorkflowStatus', () => {
  it.each(['completed', 'failed', 'closed', 'stale'] as const)('accepts inactive workflow status %s', (status) => {
    expect(isInactiveCleanupWorkflowStatus(status)).toBe(true);
  });

  it.each([
    'pending',
    'running',
    'fixing_with_ai',
    'blocked',
    'review_ready',
    'awaiting_approval',
  ] as const)('retains active workflow status %s', (status) => {
    expect(isInactiveCleanupWorkflowStatus(status)).toBe(false);
  });

  it('retains an unknown status', () => {
    expect(isInactiveCleanupWorkflowStatus('new-future-status' as WorkflowDerivedStatus)).toBe(false);
  });
});

describe('isWorkflowPastRetention', () => {
  it('is false at exactly 48 hours and true one millisecond later', () => {
    expect(isWorkflowPastRetention(new Date(NOW - IDLE_WORKFLOW_RETENTION_MS).toISOString(), NOW)).toBe(false);
    expect(isWorkflowPastRetention(new Date(NOW - IDLE_WORKFLOW_RETENTION_MS - 1).toISOString(), NOW)).toBe(true);
  });

  it('fails closed for missing, malformed, and future activity times', () => {
    expect(isWorkflowPastRetention(undefined, NOW)).toBe(false);
    expect(isWorkflowPastRetention('not-a-date', NOW)).toBe(false);
    expect(isWorkflowPastRetention(new Date(NOW + 1).toISOString(), NOW)).toBe(false);
  });
});
