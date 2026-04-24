
import type { TaskState } from '@invoker/workflow-graph';

export type InvalidationAction =
  | 'none'
  | 'retryTask'
  | 'retryWorkflow'
  | 'recreateTask'
  | 'recreateWorkflow'
  | 'recreateWorkflowFromFreshBase'
  | 'workflowFork';

/**
 * Scope at which an `InvalidationAction` applies.
 *  - `'task'`     → applies to a single task identity within a workflow
 *  - `'workflow'` → applies across an entire workflow's active scope
 *  - `'none'`     → no-op (paired with action `'none'`)
 */
export type InvalidationScope = 'none' | 'task' | 'workflow';

export interface TaskMutationPolicy {
  invalidatesExecutionSpec: boolean;
  invalidateIfActive: boolean;
  action: InvalidationAction;
}

export type MutationKey =
  | 'command'
  | 'prompt'
  | 'executionAgent'
  | 'executorType'
  | 'remoteTargetId'
  | 'selectedExperiment'
  | 'selectedExperimentSet'
  | 'mergeMode'
  | 'fixContext'
  | 'rebaseAndRetry'
  | 'externalGatePolicy'
  | 'topology';

export const MUTATION_POLICIES: Readonly<Record<MutationKey, TaskMutationPolicy>> = Object.freeze({
  command:               { invalidatesExecutionSpec: true,  invalidateIfActive: true,  action: 'recreateTask' as const },
  prompt:                { invalidatesExecutionSpec: true,  invalidateIfActive: true,  action: 'recreateTask' as const },
  executionAgent:        { invalidatesExecutionSpec: true,  invalidateIfActive: true,  action: 'recreateTask' as const },
  executorType:          { invalidatesExecutionSpec: true,  invalidateIfActive: true,  action: 'retryTask' as const },
  remoteTargetId:        { invalidatesExecutionSpec: true,  invalidateIfActive: true,  action: 'recreateTask' as const },
  selectedExperiment:    { invalidatesExecutionSpec: true,  invalidateIfActive: true,  action: 'recreateTask' as const },
  selectedExperimentSet: { invalidatesExecutionSpec: true,  invalidateIfActive: true,  action: 'recreateTask' as const },
  mergeMode:             { invalidatesExecutionSpec: true,  invalidateIfActive: true,  action: 'retryTask' as const },
  fixContext:            { invalidatesExecutionSpec: true,  invalidateIfActive: true,  action: 'retryTask' as const },
  rebaseAndRetry:        { invalidatesExecutionSpec: true,  invalidateIfActive: true,  action: 'recreateWorkflowFromFreshBase' as const },
  externalGatePolicy:    { invalidatesExecutionSpec: false, invalidateIfActive: false, action: 'none' as const },
  // Step 11 (`docs/architecture/task-invalidation-roadmap.md`): graph
  // topology mutations (e.g. `replaceTask`, `addTask` that changes
  // parent edges) are fork-class / workflow scope. They must NOT
  // mutate a live workflow in place; they fork a new workflow rooted
  // from the relevant node/result. Step 12 wires the matching
  // `forkWorkflow*` lifecycle dep on `applyInvalidation`.
  topology:              { invalidatesExecutionSpec: true,  invalidateIfActive: true,  action: 'workflowFork' as const },
});

export type CancelInFlightFn = (
  scope: InvalidationScope,
  id: string,
) => Promise<void>;

export interface InvalidationDeps {
  cancelInFlight: CancelInFlightFn;
  retryTask: (taskId: string) => TaskState[] | Promise<TaskState[]>;
  recreateTask: (taskId: string) => TaskState[] | Promise<TaskState[]>;
  retryWorkflow: (workflowId: string) => TaskState[] | Promise<TaskState[]>;
  recreateWorkflow: (workflowId: string) => TaskState[] | Promise<TaskState[]>;
  recreateWorkflowFromFreshBase?: (workflowId: string) => TaskState[] | Promise<TaskState[]>;
  /**
   * Step 11 surfaces `'workflowFork'` as the topology-class action.
   * Step 12 supplies the implementation that creates a new workflow
   * rooted from the relevant node/result. Until then, invocation
   * fails fast through `applyInvalidation` with an explicit
   * "not yet wired (Step 12)" error.
   */
  workflowFork?: (workflowId: string) => TaskState[] | Promise<TaskState[]>;
}

const TASK_ACTIONS = new Set<InvalidationAction>(['retryTask', 'recreateTask']);
const WORKFLOW_ACTIONS = new Set<InvalidationAction>([
  'retryWorkflow',
  'recreateWorkflow',
  'recreateWorkflowFromFreshBase',
  'workflowFork',
]);

export async function applyInvalidation(
  scope: InvalidationScope,
  action: InvalidationAction,
  id: string,
  deps: InvalidationDeps,
): Promise<TaskState[]> {
  if (action === 'none') {
    if (scope !== 'none') {
      throw new Error(
        `applyInvalidation: scope must be 'none' when action is 'none' (got scope='${scope}')`,
      );
    }
    return [];
  }

  if (TASK_ACTIONS.has(action) && scope !== 'task') {
    throw new Error(
      `applyInvalidation: action '${action}' requires scope 'task' (got '${scope}')`,
    );
  }
  if (WORKFLOW_ACTIONS.has(action) && scope !== 'workflow') {
    throw new Error(
      `applyInvalidation: action '${action}' requires scope 'workflow' (got '${scope}')`,
    );
  }

  await deps.cancelInFlight(scope, id);

  switch (action) {
    case 'retryTask':
      return await deps.retryTask(id);
    case 'recreateTask':
      return await deps.recreateTask(id);
    case 'retryWorkflow':
      return await deps.retryWorkflow(id);
    case 'recreateWorkflow':
      return await deps.recreateWorkflow(id);
    case 'recreateWorkflowFromFreshBase': {
      if (!deps.recreateWorkflowFromFreshBase) {
        throw new Error(
          "applyInvalidation: 'recreateWorkflowFromFreshBase' is not yet wired (Step 12). " +
            'Provide deps.recreateWorkflowFromFreshBase to use this action.',
        );
      }
      return await deps.recreateWorkflowFromFreshBase(id);
    }
    case 'workflowFork': {
      if (!deps.workflowFork) {
        throw new Error(
          "applyInvalidation: 'workflowFork' is not yet wired (Step 12). " +
            'Provide deps.workflowFork to use this action.',
        );
      }
      return await deps.workflowFork(id);
    }
  }
}
