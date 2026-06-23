/**
 * Regression coverage for the merge-gate side-effect lineage guard.
 *
 * Merge-gate execution metadata (branch, workspacePath, review fields,
 * fixed-integration fields) is written straight to persistence *before*
 * emitComplete / handleWorkerResponse run the normal worker-response lineage
 * guard. `persistMergeGateMetadata` routes those writes through the
 * orchestrator's `applyMergeGateExecutionMetadata` guard so a stale gate run
 * cannot clobber a task that has advanced to a newer attempt/generation.
 */

import { describe, it, expect, vi } from 'vitest';
import { persistMergeGateMetadata } from '../merge-runner.js';
import type { MergeRunnerHost } from '../merge-runner.js';
import type { TaskStateChanges } from '@invoker/workflow-core';

const STALE_CHANGES: TaskStateChanges = {
  execution: {
    branch: 'feature/stale',
    workspacePath: '/tmp/stale-gate',
    reviewUrl: 'https://example.test/stale',
    reviewId: 'owner/repo#stale',
  },
};

describe('persistMergeGateMetadata lineage routing', () => {
  it('drops a stale write by delegating to the orchestrator guard (no direct persistence write)', () => {
    const updateTask = vi.fn();
    // A real-shaped orchestrator that rejects the write as stale.
    const applyMergeGateExecutionMetadata = vi.fn(() => false);
    const host = {
      orchestrator: { applyMergeGateExecutionMetadata },
      persistence: { updateTask },
    } as unknown as MergeRunnerHost;

    const applied = persistMergeGateMetadata(host, 'merge-1', STALE_CHANGES, {
      attemptId: 'attempt-old',
      executionGeneration: 1,
    });

    expect(applied).toBe(false);
    expect(applyMergeGateExecutionMetadata).toHaveBeenCalledWith(
      'merge-1',
      STALE_CHANGES,
      { attemptId: 'attempt-old', executionGeneration: 1 },
    );
    // The guard owns the write; the helper must NOT also write directly.
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('applies a valid write through the orchestrator guard', () => {
    const updateTask = vi.fn();
    const applyMergeGateExecutionMetadata = vi.fn(() => true);
    const host = {
      orchestrator: { applyMergeGateExecutionMetadata },
      persistence: { updateTask },
    } as unknown as MergeRunnerHost;

    const applied = persistMergeGateMetadata(host, 'merge-1', STALE_CHANGES, {
      attemptId: 'attempt-current',
      executionGeneration: 2,
    });

    expect(applied).toBe(true);
    expect(applyMergeGateExecutionMetadata).toHaveBeenCalledTimes(1);
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('falls back to a direct persistence write for hosts without the guard (legacy/test doubles)', () => {
    const updateTask = vi.fn();
    const host = {
      orchestrator: {},
      persistence: { updateTask },
    } as unknown as MergeRunnerHost;

    const applied = persistMergeGateMetadata(host, 'merge-1', STALE_CHANGES, {
      attemptId: 'attempt-current',
      executionGeneration: 2,
    });

    expect(applied).toBe(true);
    expect(updateTask).toHaveBeenCalledWith('merge-1', STALE_CHANGES);
  });
});
