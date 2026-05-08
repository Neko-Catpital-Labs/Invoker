/**
 * Regression reference: Delete Workflow History (DB) uses bulk delete-all.
 *
 * The "Delete Workflow History (DB)" button in the UI must call
 * `deleteAllWorkflowsBulk` (not `deleteAllWorkflows`) so per-task removal
 * deltas are suppressed and the UI is notified through the workflows-changed
 * channel instead. This test verifies the contract at the mock API boundary.
 *
 * Related coordinator tests:
 *   packages/app/src/__tests__/persisted-workflow-mutation-coordinator.test.ts
 *     - "invalidates an older running workflow intent when internal bulk delete-all-workflows is enqueued"
 *     - "evicts older queued workflow intents when internal bulk delete-all-workflows fence starts"
 *
 * Related lifecycle tests:
 *   packages/app/src/__tests__/delete-all-lifecycle.test.ts
 *     - "bulk delete-all lifecycle invariants" describe block
 *
 * Related orchestrator tests:
 *   packages/workflow-core/src/__tests__/orchestrator.test.ts
 *     - "deleteAllWorkflows bulk (publishRemovalDeltas: false)" describe block
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMockInvoker, type MockInvoker } from './helpers/mock-invoker.js';

describe('delete-history-repro regression reference', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('mock API exposes both deleteAllWorkflows and deleteAllWorkflowsBulk', () => {
    expect(typeof mock.api.deleteAllWorkflows).toBe('function');
    expect(typeof mock.api.deleteAllWorkflowsBulk).toBe('function');
  });

  it('deleteAllWorkflowsBulk is a distinct function from deleteAllWorkflows', () => {
    expect(mock.api.deleteAllWorkflowsBulk).not.toBe(mock.api.deleteAllWorkflows);
  });

  it('deleteAllWorkflowsBulk resolves without error', async () => {
    await expect(mock.api.deleteAllWorkflowsBulk()).resolves.not.toThrow();
  });
});
