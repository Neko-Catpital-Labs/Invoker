import type { ReviewGateQueryResponse } from '@invoker/contracts';
import type { TaskState } from '@invoker/workflow-core';

type ReviewGateArtifact = NonNullable<NonNullable<TaskState['execution']['reviewGate']>['artifacts']>[number];

const completion = { required: 'all' as const, status: 'approved' as const };

function scalarArtifact(task: TaskState): ReviewGateArtifact | null {
  if (!task.execution.reviewId && !task.execution.reviewUrl) return null;
  return {
    id: task.execution.reviewId ?? 'review',
    title: task.config.summary,
    url: task.execution.reviewUrl,
    providerId: task.execution.reviewId,
    provider: task.execution.reviewProviderId,
    required: true,
    status: task.execution.reviewStatus === 'Approved' ? 'approved' : 'open',
    rawStatus: task.execution.reviewStatus,
    generation: task.execution.generation ?? 0,
  };
}

function deriveReviewGateSubstate(
  mergeTask: TaskState,
  requiredArtifacts: readonly ReviewGateArtifact[],
): ReviewGateQueryResponse['substate'] {
  if (mergeTask.execution.pendingFixError !== undefined) return 'fix_pending';
  if (requiredArtifacts.some((artifact) => artifact.mergeState === 'dirty')) return 'merge_conflict';
  if (requiredArtifacts.some((artifact) => artifact.checksState === 'failure')) return 'ci_failing';
  if (requiredArtifacts.some((artifact) => artifact.checksState === 'pending')) return 'ci_pending';
  if (
    requiredArtifacts.length > 0
    && requiredArtifacts.every((artifact) => artifact.status === 'open')
    && requiredArtifacts.every((artifact) => artifact.checksState === 'success')
  ) {
    return 'ready_to_land';
  }
  if (requiredArtifacts.length > 0) return 'review_open';
  return null;
}

export function buildReviewGateQueryResponse(args: {
  workflowId: string;
  workflow: unknown | undefined;
  tasks: readonly TaskState[];
}): ReviewGateQueryResponse {
  const mergeTask = args.tasks.find((task) => task.config.isMergeNode === true && task.config.workflowId === args.workflowId);
  if (!mergeTask) {
    return {
      workflowId: args.workflowId,
      mergeTaskId: null,
      status: null,
      activeGeneration: null,
      completion,
      ready: false,
      substate: null,
      artifacts: [],
      discardedArtifacts: [],
      edges: [],
    };
  }

  const reviewGate = mergeTask.execution.reviewGate;
  let activeGeneration: number | null = null;
  let artifacts: ReviewGateArtifact[] = [];
  let discardedArtifacts: ReviewGateArtifact[] = [];

  if (reviewGate) {
    activeGeneration = reviewGate.activeGeneration;
    for (const artifact of reviewGate.artifacts) {
      const discarded = Boolean(artifact.discardedAt) || artifact.status === 'discarded' || artifact.generation !== reviewGate.activeGeneration;
      if (discarded) discardedArtifacts.push(artifact);
      else artifacts.push(artifact);
    }
  } else {
    const fallback = scalarArtifact(mergeTask);
    if (fallback) {
      activeGeneration = fallback.generation;
      artifacts = [fallback];
    }
  }

  const requiredArtifacts = artifacts.filter((artifact) => artifact.required);
  const ready = requiredArtifacts.length > 0 && requiredArtifacts.every((artifact) => artifact.status === 'approved');
  const substate = deriveReviewGateSubstate(mergeTask, requiredArtifacts);
  const edges = artifacts.length < 2
    ? []
    : artifacts.slice(0, -1).map((artifact, index) => ({
      from: artifact.id,
      to: artifacts[index + 1]!.id,
    }));

  return {
    workflowId: args.workflowId,
    mergeTaskId: mergeTask.id,
    status: mergeTask.status,
    activeGeneration,
    completion,
    ready,
    substate,
    artifacts,
    discardedArtifacts,
    edges,
  };
}
