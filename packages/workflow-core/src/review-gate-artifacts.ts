/**
 * Pure review-gate artifact predicates.
 *
 * These live in workflow-core rather than execution-engine so the orchestrator
 * and the execution-engine poll loop read merge-gate readiness from one
 * definition. `task-runner-review-gate` re-exports them unchanged.
 */

import type { TaskState } from '@invoker/workflow-graph';

type ReviewGateState = NonNullable<TaskState['execution']['reviewGate']>;
type ReviewGateArtifact = ReviewGateState['artifacts'][number];

export function isCurrentReviewGateArtifact(
  gate: ReviewGateState,
  artifact: ReviewGateArtifact,
): boolean {
  return artifact.generation === gate.activeGeneration
    && artifact.status !== 'discarded'
    && !artifact.discardedAt;
}

export function getCurrentReviewArtifacts(task: TaskState): ReviewGateArtifact[] {
  const gate = task.execution.reviewGate;
  if (!gate) {
    if (!task.execution.reviewId) return [];
    return [{
      id: task.execution.reviewId,
      providerId: task.execution.reviewId,
      required: true,
      status: 'open',
      generation: task.execution.generation ?? 0,
    }];
  }
  return gate.artifacts.filter((artifact) => isCurrentReviewGateArtifact(gate, artifact));
}

export function getCurrentRequiredReviewArtifacts(task: TaskState): ReviewGateArtifact[] {
  return getCurrentReviewArtifacts(task)
    .filter((artifact) => artifact.required && !!artifact.providerId);
}

export function reviewGateIsApproved(gate: ReviewGateState): boolean {
  const currentRequired = gate.artifacts.filter((artifact) =>
    isCurrentReviewGateArtifact(gate, artifact) && artifact.required,
  );
  return currentRequired.length > 0
    && currentRequired.every((artifact) => artifact.status === 'approved');
}
