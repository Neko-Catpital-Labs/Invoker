/**
 * Repro: review-gate CI auto-fix intents die at dispatch because the fix
 * entry path only accepts `failed` tasks.
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
 * ci-failure-worker.ts), but `fixWithAgentAction` entered the fix lifecycle
 * through `beginConflictResolution`, whose guard requires `status === 'failed'`.
 * Every review-gate CI repair intent therefore failed within milliseconds of
 * being queued.
 *
 * Fixed behavior, proven here against a REAL orchestrator:
 *   1. `beginConflictResolution` still throws for a review_ready gate — the
 *      root cause stays reproducible.
 *   2. `fixWithAgentAction` with a reviewGateContext routes through
 *      `beginAutoFixSession`, runs the agent fix, and parks the gate in
 *      `awaiting_approval`.
 *   3. When the agent fix throws, the gate is restored to `review_ready` —
 *      not flipped to `failed`, which would eject an open review gate from
 *      the review-polling loop.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestHarness, type TestHarness } from '@invoker/test-kit';
import type { PlanDefinition } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { TaskRunner } from '@invoker/execution-engine';
import { fixWithAgentAction } from '../workflow-actions.js';

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

  it('root cause: beginConflictResolution rejects a review_ready merge gate', async () => {
    const mergeId = await driveGateToReviewReady(h);

    // This is the exact production error from mutation intent 27908.
    expect(() => h.orchestrator.beginConflictResolution(mergeId))
      .toThrow(`Task ${mergeId} is not failed (status: review_ready)`);
  });

  it('fixed: a review-gate CI fix starts from review_ready and parks in awaiting_approval', async () => {
    const mergeId = await driveGateToReviewReady(h);
    const fixWithAgent = vi.fn(async () => {
      // The agent must run while the gate is in the fix lifecycle.
      expect(h.getTask(mergeId)!.status).toBe('fixing_with_ai');
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
    expect(h.getTask(mergeId)!.status).toBe('review_ready');
  });
});
