/**
 * Review-gate / merge-gate polling family, extracted from TaskRunner.
 *
 * Owns the poll loop that reconciles each merge-node task's review artifacts
 * against the merge-gate provider, maps provider lifecycle → artifact status,
 * completes approved gates, closes reviews on teardown, and publishes CI-failure
 * lifecycle triggers.
 *
 * Stateful functions take a {@link TaskRunnerReviewGateHost} — a
 * `Pick<TaskRunner, …>` — as their first parameter, so the type-only import of
 * `TaskRunner` avoids a runtime cycle while the host shape stays locked to the
 * runner's real member types (no drift). Pure helpers that read only their
 * arguments take no host. Sibling functions call each other directly within
 * this module; the same-named `TaskRunner` methods are thin delegates that route
 * through `gitPlumbing`-style namespace calls.
 *
 * The `ReviewGateCiFailureTrigger` / `ReviewGateCiFailureLifecyclePublisher`
 * declarations live here (their owning cluster) and stay barrel-visible via the
 * package index re-export.
 */

import type { TaskState } from '@invoker/workflow-core';

import type { MergeGateApprovalStatus } from './merge-gate-provider.js';
import type { TaskRunner } from './task-runner.js';

type ReviewGateState = NonNullable<TaskState['execution']['reviewGate']>;
type ReviewGateArtifact = ReviewGateState['artifacts'][number];
type ReviewGateArtifactStatus = ReviewGateArtifact['status'];

export interface ReviewGateCiFailureTrigger {
  taskId: string;
  workflowId: string;
  reviewId: string;
  reviewUrl: string;
  headSha?: string;
  headRef?: string;
  branch?: string;
  selectedAttemptId?: string;
  generation: number;
  failedChecks: NonNullable<MergeGateApprovalStatus['checks']>['failed'];
  statusText: string;
}

export interface ReviewGateCiFailureLifecyclePublisher {
  publish(trigger: ReviewGateCiFailureTrigger): void | Promise<void>;
}
export interface ReviewGateMergeConflictTrigger {
  taskId: string;
  workflowId: string;
  status?: TaskState['status'];
  taskStateVersion?: number;
  reviewId: string;
  reviewUrl: string;
  headSha?: string;
  headRef?: string;
  branch?: string;
  selectedAttemptId?: string;
  generation: number;
  statusText: string;
}

export interface ReviewGateMergeConflictLifecyclePublisher {
  publish(trigger: ReviewGateMergeConflictTrigger): void | Promise<void>;
}


/**
 * Subset of {@link TaskRunner} the review-gate polling family reads. Picked from
 * `TaskRunner` (not hand-written) so the host stays locked to the runner's real
 * member types. `reviewGateCiFailureInFlight` is single-cluster-owned: it lives
 * here as an `@internal` runner field and is picked into this host.
 */
export type TaskRunnerReviewGateHost = Pick<
  TaskRunner,
  // Shared collaborators
  | 'orchestrator'
  | 'persistence'
  | 'cwd'
  | 'logger'
  | 'mergeGateProvider'
  | 'executeTasks'
  // Review-gate cluster state
  | 'reviewGateCiFailurePublisher'
  | 'reviewGateCiFailureInFlight'
>;

export async function closeWorkflowReview(
  host: TaskRunnerReviewGateHost,
  workflowId: string,
): Promise<void> {
  const closeReview = host.mergeGateProvider?.closeReview?.bind(host.mergeGateProvider);
  if (!closeReview) return;
  const getAllTasks = host.orchestrator.getAllTasks?.bind(host.orchestrator);
  if (!getAllTasks) return;
  const mergeTask = getAllTasks().find((task) =>
    task.config.workflowId === workflowId
    && task.config.isMergeNode
    && (!!task.execution.reviewGate || !!task.execution.reviewId)
  );
  if (!mergeTask) return;

  const identifiers = getCurrentClosableReviewIdentifiers(mergeTask);
  const cwd = mergeTask.execution.workspacePath ?? host.cwd;
  for (const identifier of identifiers) {
    try {
      await closeReview({ identifier, cwd });
    } catch (err) {
      host.logger.error(`[merge-gate] Failed to close review ${identifier}`, { err });
    }
  }
}

export function isCurrentReviewGateArtifact(gate: ReviewGateState, artifact: ReviewGateArtifact): boolean {
  return artifact.generation === gate.activeGeneration
    && artifact.status !== 'discarded'
    && !artifact.discardedAt;
}

export function getCurrentReviewArtifacts(task: TaskState): ReviewGateArtifact[] {
  const gate = task.execution.reviewGate;
  if (!gate) {
    if (!task.execution.reviewId) {
      return [];
    }
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
  return getCurrentReviewArtifacts(task).filter((artifact) => artifact.required && !!artifact.providerId);
}

export function getCurrentClosableReviewIdentifiers(task: TaskState): string[] {
  return getCurrentReviewArtifacts(task)
    .flatMap((artifact) => (artifact.providerId ? [artifact.providerId] : []));
}

export function mapReviewGateArtifactStatus(status: MergeGateApprovalStatus): ReviewGateArtifactStatus {
  if (status.lifecycle === 'closed') return 'closed';
  if (status.lifecycle === 'merged') return 'approved';
  if (status.rejected) return 'changes_requested';
  return 'open';
}

export function reviewPollStillMatches(
  before: TaskState,
  current: TaskState | undefined,
  providerId: string,
): boolean {
  if (!current) return false;
  // Stale-write guard: a late poll must not write after the task already left
  // the approval state (e.g. completed/closed/retried by another poll).
  if (current.status !== 'review_ready' && current.status !== 'awaiting_approval') return false;
  if (current.execution.selectedAttemptId !== before.execution.selectedAttemptId) return false;
  if ((current.execution.generation ?? 0) !== (before.execution.generation ?? 0)) return false;

  const beforeGate = before.execution.reviewGate;
  if (!beforeGate) {
    return !current.execution.reviewGate && current.execution.reviewId === providerId;
  }

  const currentGate = current.execution.reviewGate;
  if (!currentGate || currentGate.activeGeneration !== beforeGate.activeGeneration) {
    return false;
  }
  return currentGate.artifacts.some((artifact) =>
    isCurrentReviewGateArtifact(currentGate, artifact)
    && artifact.required
    && artifact.providerId === providerId,
  );
}

export function updateReviewGateArtifact(
  gate: ReviewGateState,
  providerId: string,
  status: MergeGateApprovalStatus,
): ReviewGateState {
  const mappedStatus = mapReviewGateArtifactStatus(status);
  return {
    ...gate,
    artifacts: gate.artifacts.map((artifact) => {
      if (
        !isCurrentReviewGateArtifact(gate, artifact)
        || artifact.providerId !== providerId
      ) {
        return artifact;
      }
      return {
        ...artifact,
        status: mappedStatus,
        checksState: status.checks?.state,
        ...(status.checks
          ? { failedChecks: status.checks.failed }
          : mappedStatus !== 'open'
            ? { failedChecks: undefined }
            : {}),
        ...(status.mergeState !== undefined
          ? { mergeState: status.mergeState }
          : mappedStatus !== 'open'
            ? { mergeState: undefined }
            : {}),
        ...(mappedStatus === 'open' ? { rawStatus: status.statusText } : {}),
        ...(status.headSha ? { headSha: status.headSha } : {}),
        ...(status.headRef ? { headRef: status.headRef } : {}),
        updatedAt: new Date().toISOString(),
      };
    }),
  };
}

export function reviewGateIsApproved(gate: ReviewGateState): boolean {
  const currentRequired = gate.artifacts.filter((artifact) =>
    isCurrentReviewGateArtifact(gate, artifact) && artifact.required,
  );
  return currentRequired.length > 0
    && currentRequired.every((artifact) => artifact.status === 'approved');
}

export async function handleApprovedMergeGate(
  host: TaskRunnerReviewGateHost,
  taskId: string,
  reviewId: string,
  source?: 'refresh' | 'manual check',
): Promise<void> {
  const sourceSuffix = source ? ` (${source})` : '';
  host.logger.info(`[merge-gate] PR ${reviewId} approved${sourceSuffix}, completing merge gate`);
  const newlyStarted = await host.orchestrator.approve(taskId);
  if (newlyStarted.length > 0) {
    await host.executeTasks(newlyStarted);
  }
}

export async function pollMergeGateTask(
  host: TaskRunnerReviewGateHost,
  task: TaskState,
  source: 'refresh' | 'manual check',
): Promise<void> {
  const artifacts = getCurrentRequiredReviewArtifacts(task);
  if (artifacts.length === 0) return;

  host.orchestrator.recordTaskHeartbeat?.(task.id, { at: new Date(), source: 'executor' });

  let latestGate = task.execution.reviewGate;
  let approvedGate = false;
  for (const artifact of artifacts) {
    const providerId = artifact.providerId;
    if (!providerId) continue;
    const gateCwd = task.execution.workspacePath ?? host.cwd;
    const status = await host.mergeGateProvider!.checkApproval({
      identifier: providerId,
      cwd: gateCwd,
    });

    const current = host.orchestrator.getTask(task.id);
    if (!reviewPollStillMatches(task, current, providerId)) {
      continue;
    }

    // Rebase each provider update on the freshest persisted gate so concurrent
    // polls don't clobber each other's artifact statuses with a stale snapshot.
    const currentGate = current!.execution.reviewGate ?? latestGate;
    if (currentGate) {
      latestGate = updateReviewGateArtifact(currentGate, providerId, status);
      host.persistence.updateTask(task.id, {
        ...(status.lifecycle === 'closed' ? { status: 'closed' as const } : {}),
        execution: { reviewGate: latestGate, reviewStatus: status.statusText },
      });
      if (!approvedGate && reviewGateIsApproved(latestGate)) {
        approvedGate = true;
        await handleApprovedMergeGate(host, task.id, providerId, source);
      } else if (status.rejected) {
        host.logger.info(`[merge-gate] PR ${providerId} rejected (${source}): ${status.statusText}`);
      } else if (status.lifecycle === 'open') {
        await maybePublishReviewGateCiFailure(host, current!, status, providerId);
      }
      continue;
    }

    host.persistence.updateTask(task.id, {
      ...(status.lifecycle === 'closed' ? { status: 'closed' as const } : {}),
      execution: { reviewStatus: status.statusText },
    });
    if (!approvedGate && status.lifecycle === 'merged') {
      approvedGate = true;
      await handleApprovedMergeGate(host, task.id, providerId, source);
    } else if (status.rejected) {
      host.logger.info(`[merge-gate] PR ${providerId} rejected (${source}): ${status.statusText}`);
    } else if (status.lifecycle === 'open') {
      await maybePublishReviewGateCiFailure(host, current!, status, providerId);
    }
  }
}

export async function checkMergeGateStatuses(host: TaskRunnerReviewGateHost): Promise<void> {
  if (!host.mergeGateProvider) return;
  for (const task of host.orchestrator.getAllTasks()) {
    if (
      task.config.isMergeNode &&
      (task.status === 'review_ready' || task.status === 'awaiting_approval') &&
      getCurrentRequiredReviewArtifacts(task).length > 0
    ) {
      try {
        await pollMergeGateTask(host, task, 'refresh');
      } catch (err) {
        host.logger.error(`[merge-gate] PR status check error for ${task.id}`, { err });
      }
    }
  }
}

export async function checkPrApprovalNow(host: TaskRunnerReviewGateHost, taskId: string): Promise<void> {
  if (!host.mergeGateProvider) return;

  const task = host.orchestrator.getTask(taskId);
  if (!task) return;

  try {
    await pollMergeGateTask(host, task, 'manual check');
  } catch (err) {
    host.logger.error(`[merge-gate] Manual PR check error for ${taskId}`, { err });
  }
}

export async function maybePublishReviewGateCiFailure(
  host: TaskRunnerReviewGateHost,
  task: TaskState,
  status: MergeGateApprovalStatus,
  reviewId: string = task.execution.reviewId ?? '',
): Promise<void> {
  if (!host.reviewGateCiFailurePublisher) return;
  if (!task.config.workflowId || !reviewId) return;
  if (status.checks?.state !== 'failure' || status.checks.failed.length === 0) return;

  const key = [
    task.id,
    task.execution.selectedAttemptId ?? 'no-attempt',
    task.execution.generation ?? 0,
    status.headSha ?? 'no-head-sha',
  ].join(':');
  if (host.reviewGateCiFailureInFlight.has(key)) return;

  host.reviewGateCiFailureInFlight.add(key);
  try {
    await host.reviewGateCiFailurePublisher.publish({
      taskId: task.id,
      workflowId: task.config.workflowId,
      reviewId,
      reviewUrl: status.url,
      headSha: status.headSha,
      headRef: status.headRef,
      branch: task.execution.branch,
      selectedAttemptId: task.execution.selectedAttemptId,
      generation: task.execution.generation ?? 0,
      failedChecks: status.checks.failed,
      statusText: status.statusText,
    });
  } finally {
    host.reviewGateCiFailureInFlight.delete(key);
  }
}
