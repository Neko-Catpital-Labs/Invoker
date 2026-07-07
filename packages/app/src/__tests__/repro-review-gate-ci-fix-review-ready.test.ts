/**
 * Repro: review-gate CI auto-fix intents die at dispatch because the fix
 * entry path only accepted `failed` tasks.
 *
 * Production failure (workflow "Prove Review Gate Fix No-op Root Cause",
 * mutation intent 27908):
 *
 *   Error: Task __merge__wf-... is not failed (status: review_ready)
 *       at beginConflictResolutionImpl
 *       at fixWithAgentAction
 *       at executeFixWithAgentMutation
 *
 * A merge gate whose review PR has a red CI check stays `review_ready` — the
 * gate task itself never failed. The ci-failure worker intentionally targets
 * gates in `review_ready` / `awaiting_approval` (see `staleReasonForEvent` in
 * ci-failure-worker.ts), but the fix action entered the lifecycle through a
 * failed-only guard. Every review-gate CI repair intent therefore failed
 * within milliseconds of being queued.
 *
 * Fixed behavior, proven here against a REAL orchestrator: fix sessions have
 * an explicit entry-state allow-list (`failed`, `review_ready`,
 * `awaiting_approval`) recorded at begin time, and every exit restores the
 * recorded entry:
 *   1. A review-gate CI fix starts from `review_ready` and parks in
 *      `awaiting_approval`.
 *   2. A failing agent fix restores the gate to `review_ready` — not `failed`,
 *      which would eject an open review gate from the review-polling loop.
 *   3. Rejecting the parked fix also restores `review_ready` (the same bug one
 *      screen later — reject used to hard-code `failed`).
 *   4. Non-resting states stay out: the allow-list refuses them loudly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestHarness, type TestHarness } from '@invoker/test-kit';
import type { PlanDefinition } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { TaskRunner } from '@invoker/execution-engine';
import { fixWithAgentAction, rejectTask } from '../workflow-actions.js';

const MANUAL_MERGE_PLAN: PlanDefinition = {
  name: 'Review Gate CI Fix Plan',
  onFinish: 'none',
  mergeMode: 'manual',
  featureBranch: 'plan/review-gate-ci-fix',
  tasks: [
    { id: 'A', description: 'Task A', command: 'echo a' },
  ],
};

async function driveGateToReviewReady(h: TestHarness): Promise<string> {
  h.loadAndStart(MANUAL_MERGE_PLAN);
  h.completeTask('A');
  const mergeId = h.getAllTasks().find((t) => t.config.isMergeNode)!.id;
  await h.executor.executeTasks([h.getTask(mergeId)!]);
  expect(h.getTask(mergeId)!.status).toBe('review_ready');

  // Give the gate the review + workspace lineage a live external-review gate
  // carries. The workspace path only needs to exist as a value: workspace
  // validation goes through taskExecutor.execGitIn, stubbed below.
  h.persistence.updateTask(mergeId, {
    execution: {
      reviewId: 'pr-7',
      workspacePath: '/tmp/fake-merge-gate-workspace',
    },
  });
  // Direct persistence writes bypass the orchestrator cache; getWorkflowStatus()
  // forces a refreshFromDb so fixWithAgentAction sees the review lineage.
  h.orchestrator.getWorkflowStatus();
  return mergeId;
}

function reviewGateContextFor(h: TestHarness, mergeId: string, fixContext: string) {
  const gate = h.orchestrator.getTask(mergeId)!;
  return {
    reviewId: 'pr-7',
    generation: gate.execution.generation ?? 0,
    selectedAttemptId: gate.execution.selectedAttemptId,
    branch: gate.execution.branch,
    fixContext,
  };
}

function makeDeps(h: TestHarness, taskExecutor: Record<string, unknown>) {
  const persistence = Object.create(h.persistence) as Record<string, unknown>;
  persistence.getTaskOutput = vi.fn(() => 'gate output');
  persistence.appendTaskOutput = vi.fn();
  return {
    orchestrator: h.orchestrator,
    persistence: persistence as unknown as SQLiteAdapter,
    taskExecutor: taskExecutor as unknown as TaskRunner,
  };
}

describe('review-gate CI auto-fix from review_ready (repro)', () => {
  let h: TestHarness;

  beforeEach(() => {
    h = createTestHarness();
  });

  it('root cause guard: fix sessions refuse non-resting entry states explicitly', async () => {
    const mergeId = await driveGateToReviewReady(h);

    // review_ready is on the allow-list now — this used to throw
    // "Task ... is not failed (status: review_ready)" (intent 27908).
    expect(() => h.orchestrator.beginFixSession(mergeId)).not.toThrow();
    h.orchestrator.revertFixSession(mergeId, { savedError: '' });

    // The allow-list still refuses states that are not resting states.
    expect(() => h.orchestrator.beginFixSession('A')).toThrow(
      'not in a fix-session entry state',
    );
  });

  it('fixed: a review-gate CI fix starts from review_ready and parks in awaiting_approval', async () => {
    const mergeId = await driveGateToReviewReady(h);
    const fixWithAgent = vi.fn(async () => {
      // The agent must run while the gate is in the fix lifecycle.
      expect(h.getTask(mergeId)!.status).toBe('fixing_with_ai');
      expect(h.getTask(mergeId)!.execution.fixSessionEntryStatus).toBe('review_ready');
    });
    const taskExecutor = {
      fixWithAgent,
      resolveConflict: vi.fn(),
      execGitIn: vi.fn(async () => 'true'),
    };

    const result = await fixWithAgentAction(mergeId, makeDeps(h, taskExecutor), {
      agentName: 'codex',
      reviewGateContext: reviewGateContextFor(h, mergeId, 'make the failed checks pass'),
    });

    expect(fixWithAgent).toHaveBeenCalledWith(
      mergeId, 'gate output', 'codex', '', 'make the failed checks pass',
    );
    expect(result).toMatchObject({ kind: 'fixWithAgent' });
    expect(h.getTask(mergeId)!.status).toBe('awaiting_approval');
  });

  it('fixed: a failing agent fix restores the gate to review_ready, not failed', async () => {
    const mergeId = await driveGateToReviewReady(h);
    const taskExecutor = {
      fixWithAgent: vi.fn(async () => {
        throw new Error('agent exploded');
      }),
      resolveConflict: vi.fn(),
      execGitIn: vi.fn(async () => 'true'),
    };

    await expect(fixWithAgentAction(mergeId, makeDeps(h, taskExecutor), {
      agentName: 'codex',
      reviewGateContext: reviewGateContextFor(h, mergeId, 'make the failed checks pass'),
    })).rejects.toThrow('agent exploded');

    // The open review gate must return to the review-polling loop.
    const gate = h.getTask(mergeId)!;
    expect(gate.status).toBe('review_ready');
    expect(gate.execution.fixSessionEntryStatus).toBeUndefined();
  });

  it('fixed: rejecting a parked review-gate fix restores review_ready, not failed', async () => {
    const mergeId = await driveGateToReviewReady(h);
    const taskExecutor = {
      fixWithAgent: vi.fn(async () => undefined),
      resolveConflict: vi.fn(),
      execGitIn: vi.fn(async () => 'true'),
    };

    await fixWithAgentAction(mergeId, makeDeps(h, taskExecutor), {
      agentName: 'codex',
      reviewGateContext: reviewGateContextFor(h, mergeId, 'make the failed checks pass'),
    });
    expect(h.getTask(mergeId)!.status).toBe('awaiting_approval');
    expect(h.getTask(mergeId)!.execution.pendingFixError).toBeDefined();

    rejectTask(mergeId, { orchestrator: h.orchestrator });

    const gate = h.getTask(mergeId)!;
    expect(gate.status).toBe('review_ready');
    expect(gate.execution.pendingFixError).toBeUndefined();
    expect(gate.execution.fixSessionEntryStatus).toBeUndefined();
  });
});
