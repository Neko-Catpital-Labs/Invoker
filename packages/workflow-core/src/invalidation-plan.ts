import type { TaskState } from '@invoker/workflow-graph';
import {
  ACTION_SPECS,
  type InvalidationAction,
  type InvalidationMode,
  type InvalidationPlanningContext,
  type InvalidationScope,
} from './invalidation-policy.js';

export type { InvalidationMode, InvalidationPlanningContext } from './invalidation-policy.js';

export interface SchedulerEnqueueCandidate {
  taskId: string;
  priority?: number;
}

export interface InvalidationLockPlan {
  workflowIds: string[];
}

export interface InvalidationPlan {
  reason: string;
  action: InvalidationAction;
  scope: InvalidationScope;
  mode: InvalidationMode;
  affectedWorkflowIds: string[];
  affectedTaskIds: string[];
  schedulerEnqueueCandidates: SchedulerEnqueueCandidate[];
  lockPlan: InvalidationLockPlan;
}

export interface InvalidationPlanningRequest extends InvalidationPlanningContext {
  action: InvalidationAction;
  reason?: string;
}

function sorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort();
}

function workflowIdsForTasks(tasks: Iterable<TaskState>): string[] {
  return sorted(
    Array.from(tasks)
      .map((task) => task.config.workflowId)
      .filter((id): id is string => !!id),
  );
}

export function planInvalidation(request: InvalidationPlanningRequest): InvalidationPlan {
  const spec = ACTION_SPECS[request.action];
  if (!spec.selectAffectedTasks || !spec.mode) {
    throw new Error(`No invalidation policy registered for action "${request.action}"`);
  }
  const affectedTasks = spec.selectAffectedTasks(request);
  const affectedWorkflowIds = workflowIdsForTasks(affectedTasks);
  const enqueueTaskIds = spec.selectInitialEnqueueCandidates?.(request, affectedTasks) ?? [];
  return {
    reason: request.reason ?? spec.reason ?? request.action,
    action: request.action,
    scope: spec.scope,
    mode: spec.mode,
    affectedWorkflowIds,
    affectedTaskIds: sorted(affectedTasks.map((task) => task.id)),
    schedulerEnqueueCandidates: sorted(enqueueTaskIds).map((taskId) => ({ taskId })),
    lockPlan: { workflowIds: affectedWorkflowIds },
  };
}

export function withSchedulerEnqueueCandidates(
  plan: InvalidationPlan,
  taskIds: Iterable<string>,
): InvalidationPlan {
  return {
    ...plan,
    schedulerEnqueueCandidates: sorted(taskIds).map((taskId) => ({ taskId })),
  };
}
