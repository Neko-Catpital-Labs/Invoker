import { getTransitiveDependents, type TaskState } from '@invoker/workflow-graph';
import type { InvalidationAction, InvalidationScope } from './invalidation-policy.js';

export type InvalidationMode = 'retry' | 'recreate' | 'scheduleOnly';

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

export interface InvalidationPlanningContext {
  targetId: string;
  tasks: readonly TaskState[];
  retryStatuses?: ReadonlySet<TaskState['status']>;
}

export interface InvalidationPlanningRequest extends InvalidationPlanningContext {
  action: InvalidationAction;
  reason?: string;
}

interface InvalidationPolicy {
  action: InvalidationAction;
  scope: InvalidationScope;
  mode: InvalidationMode;
  reason: string;
  selectAffectedTasks: (context: InvalidationPlanningContext) => TaskState[];
  selectInitialEnqueueCandidates?: (context: InvalidationPlanningContext, affectedTasks: readonly TaskState[]) => string[];
}

function definePolicy(policy: InvalidationPolicy): InvalidationPolicy {
  return Object.freeze(policy);
}

function sorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort();
}

function taskMap(tasks: readonly TaskState[]): Map<string, TaskState> {
  return new Map(tasks.map((task) => [task.id, task]));
}

function workflowIdsForTasks(tasks: Iterable<TaskState>): string[] {
  return sorted(
    Array.from(tasks)
      .map((task) => task.config.workflowId)
      .filter((id): id is string => !!id),
  );
}

function descendantsOf(
  taskId: string,
  tasksById: ReadonlyMap<string, TaskState>,
  stop?: (task: TaskState) => boolean,
): TaskState[] {
  return getTransitiveDependents(taskId, tasksById, stop ?? (() => false))
    .map((id) => tasksById.get(id))
    .filter((task): task is TaskState => !!task);
}

function taskAndDescendants(
  taskId: string,
  tasks: readonly TaskState[],
  stop?: (task: TaskState) => boolean,
): TaskState[] {
  const byId = taskMap(tasks);
  const root = byId.get(taskId);
  if (!root) return [];
  return [root, ...descendantsOf(taskId, byId, stop)];
}

function retryStop(task: TaskState): boolean {
  return task.status === 'completed' || task.status === 'stale';
}

function defaultRetryStatuses(): ReadonlySet<TaskState['status']> {
  return new Set<TaskState['status']>([
    'failed',
    'needs_input',
    'blocked',
    'stale',
    'fixing_with_ai',
    'awaiting_approval',
    'review_ready',
  ]);
}

function makePlan(policy: InvalidationPolicy, context: InvalidationPlanningContext, reason?: string): InvalidationPlan {
  const affectedTasks = policy.selectAffectedTasks(context);
  const affectedWorkflowIds = workflowIdsForTasks(affectedTasks);
  const enqueueTaskIds = policy.selectInitialEnqueueCandidates?.(context, affectedTasks) ?? [];
  return {
    reason: reason ?? policy.reason,
    action: policy.action,
    scope: policy.scope,
    mode: policy.mode,
    affectedWorkflowIds,
    affectedTaskIds: sorted(affectedTasks.map((task) => task.id)),
    schedulerEnqueueCandidates: sorted(enqueueTaskIds).map((taskId) => ({ taskId })),
    lockPlan: { workflowIds: affectedWorkflowIds },
  };
}

export const INVALIDATION_POLICIES: Readonly<Partial<Record<InvalidationAction, InvalidationPolicy>>> = Object.freeze({
  recreateWorkflow: definePolicy({
    action: 'recreateWorkflow',
    scope: 'workflow',
    mode: 'recreate',
    reason: 'workflow.recreate',
    selectAffectedTasks: ({ targetId, tasks }) => tasks.filter((task) => task.config.workflowId === targetId),
  }),
  recreateWorkflowFromFreshBase: definePolicy({
    action: 'recreateWorkflowFromFreshBase',
    scope: 'workflow',
    mode: 'recreate',
    reason: 'workflow.recreateFromFreshBase',
    selectAffectedTasks: ({ targetId, tasks }) => tasks.filter((task) => task.config.workflowId === targetId),
  }),
  recreateTask: definePolicy({
    action: 'recreateTask',
    scope: 'task',
    mode: 'recreate',
    reason: 'task.recreate',
    selectAffectedTasks: ({ targetId, tasks }) => taskAndDescendants(targetId, tasks),
  }),
  retryTask: definePolicy({
    action: 'retryTask',
    scope: 'task',
    mode: 'retry',
    reason: 'task.retry',
    selectAffectedTasks: ({ targetId, tasks }) => taskAndDescendants(targetId, tasks, retryStop),
  }),
  retryWorkflow: definePolicy({
    action: 'retryWorkflow',
    scope: 'workflow',
    mode: 'retry',
    reason: 'workflow.retry',
    selectAffectedTasks: ({ targetId, tasks, retryStatuses }) => {
      const statuses = retryStatuses ?? defaultRetryStatuses();
      const byId = taskMap(tasks);
      const affectedIds = new Set<string>();
      for (const task of tasks) {
        if (task.config.workflowId !== targetId || !statuses.has(task.status)) continue;
        affectedIds.add(task.id);
        for (const descendant of descendantsOf(task.id, byId, retryStop)) {
          affectedIds.add(descendant.id);
        }
      }
      return Array.from(affectedIds)
        .map((id) => byId.get(id))
        .filter((task): task is TaskState => !!task);
    },
  }),
  scheduleOnly: definePolicy({
    action: 'scheduleOnly',
    scope: 'task',
    mode: 'scheduleOnly',
    reason: 'externalGatePolicy',
    selectAffectedTasks: ({ targetId, tasks }) => {
      const task = tasks.find((item) => item.id === targetId);
      return task ? [task] : [];
    },
    selectInitialEnqueueCandidates: (_context, affectedTasks) => affectedTasks.map((task) => task.id),
  }),
});

export function planInvalidation(request: InvalidationPlanningRequest): InvalidationPlan {
  const policy = INVALIDATION_POLICIES[request.action];
  if (!policy) {
    throw new Error(`No invalidation policy registered for action "${request.action}"`);
  }
  return makePlan(policy, request, request.reason);
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
