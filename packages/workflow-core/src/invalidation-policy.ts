
import type { TaskState } from '@invoker/workflow-graph';
export type InvalidationAction =
  | 'none'
  | 'scheduleOnly'
  | 'fixApprove'
  | 'fixReject'
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
  | 'fixApprove'
  | 'fixReject'
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
  // Step 15 (`docs/architecture/task-invalidation-roadmap.md`): the
  // chart's Decision Table row "Change external gate policy" is the
  // intentional non-invalidating outlier — it's a scheduling policy
  // edit, not an execution-spec edit. Action is now the explicit
  // `'scheduleOnly'` (was `'none'` in Step 1) so the lock-in is
  // encoded in the policy table itself: `applyInvalidation` skips
  // `cancelInFlight` for this action and routes to a `scheduleOnly`
  // dep that triggers an unblock-pass (e.g.
  // `Orchestrator.autoStartExternallyUnblockedReadyTasks`). Per chart:
  //   - `invalidatesExecutionSpec: false` (no ABI change)
  //   - `invalidateIfActive: false`       (in-flight work survives)
  externalGatePolicy:    { invalidatesExecutionSpec: false, invalidateIfActive: false, action: 'scheduleOnly' as const },
  fixApprove:            { invalidatesExecutionSpec: false, invalidateIfActive: false, action: 'fixApprove' as const },
  fixReject:             { invalidatesExecutionSpec: false, invalidateIfActive: false, action: 'fixReject' as const },
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
   * Step 11 surfaced `'workflowFork'` as the topology-class action;
   * Step 14 (`docs/architecture/task-invalidation-roadmap.md`) wires
   * the implementation. Production callers (`buildInvalidationDeps`
   * in `packages/app/src/workflow-actions.ts`) supply
   * `Orchestrator.forkWorkflow` here, so the "not yet wired" error
   * path below is now dead code in production — it only fires for
   * focused unit tests that build a partial `InvalidationDeps`.
   */
  workflowFork?: (workflowId: string) => TaskState[] | Promise<TaskState[]>;
  /**
   * Step 15 (`docs/architecture/task-invalidation-roadmap.md`):
   * scheduling-only unblock pass for the chart's "Change external
   * gate policy" row. Production callers wire this to a scheduler
   * entrypoint (e.g.
   * `Orchestrator.autoStartExternallyUnblockedReadyTasks`) via
   * `buildInvalidationDeps` (`packages/app/src/workflow-actions.ts`).
   * Unlike retry/recreate deps, this is invoked WITHOUT a
   * preceding `cancelInFlight` call — gate-policy edits MUST NOT
   * cancel active work. The dep takes the affected task id so it
   * can scope the scheduling pass if desired; today's
   * implementation re-evaluates all externally-unblocked ready
   * tasks across the orchestrator.
   */
  scheduleOnly?: (taskId: string) => TaskState[] | Promise<TaskState[]>;
  fixApprove?: (taskId: string) => TaskState[] | Promise<TaskState[]>;
  fixReject?: (taskId: string) => TaskState[] | Promise<TaskState[]>;
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

  if (action === 'scheduleOnly') {
    if (scope !== 'task') {
      throw new Error(
        `applyInvalidation: action 'scheduleOnly' requires scope 'task' (got '${scope}')`,
      );
    }
    if (!deps.scheduleOnly) {
      // Step 15: production callers wire this dep via
      // `buildInvalidationDeps` (`packages/app/src/workflow-actions.ts`)
      // to `Orchestrator.autoStartExternallyUnblockedReadyTasks`. This
      // branch is reachable only from focused unit tests that build a
      // partial `InvalidationDeps` without the scheduler dep.
      throw new Error(
        "applyInvalidation: 'scheduleOnly' dep is missing. " +
          'Production callers wire this via buildInvalidationDeps in ' +
          '@invoker/app/workflow-actions; tests must supply ' +
          'deps.scheduleOnly to use this action.',
      );
    }
    // Per chart's "Change external gate policy" row: scheduling
    // edits do NOT cancel active work and do NOT bump generation.
    // We deliberately skip `deps.cancelInFlight` here.
    return await deps.scheduleOnly(id);
  }

  if (action === 'fixApprove' || action === 'fixReject') {
    if (scope !== 'task') {
      throw new Error(
        `applyInvalidation: action '${action}' requires scope 'task' (got '${scope}')`,
      );
    }
    const dep = action === 'fixApprove' ? deps.fixApprove : deps.fixReject;
    if (!dep) {
      throw new Error(
        `applyInvalidation: '${action}' dep is missing. ` +
          'Production callers wire this via buildInvalidationDeps in ' +
          '@invoker/app/workflow-actions; tests must supply the dep to use this action.',
      );
    }
    return await dep(id);
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
        // Step 14 wires this dep in production via
        // `buildInvalidationDeps` (`packages/app/src/workflow-actions.ts`).
        // This branch is reachable only from focused unit tests that
        // build a partial `InvalidationDeps` without the topology dep.
        throw new Error(
          "applyInvalidation: 'workflowFork' dep is missing. " +
            'Production callers wire this via buildInvalidationDeps in ' +
            '@invoker/app/workflow-actions; tests must supply ' +
            'deps.workflowFork to use this action.',
        );
      }
      return await deps.workflowFork(id);
    }
  }
}
