/**
 * Task invalidation policy — routing scaffolding (Step 1, Phase A).
 *
 * Implements the invalidation-class layer described in
 * `docs/architecture/task-invalidation-chart.md`:
 *
 *   - `InvalidationAction` names every retry/recreate route
 *     (`retryTask | recreateTask | retryWorkflow | recreateWorkflow |
 *     recreateWorkflowFromFreshBase | none`).
 *   - `InvalidationScope` separates `task` vs `workflow` ownership.
 *   - `MUTATION_POLICIES` mirrors the chart's example mapping per
 *     execution-defining mutation (command, prompt, executionAgent, ...).
 *   - `applyInvalidation()` enforces the chart's Hard Invariant:
 *     affected in-flight work is interrupted BEFORE the lifecycle dep
 *     is invoked.
 *
 * Step 1 deliberately introduces this surface as scaffolding only.
 * No existing mutation path is migrated onto it yet — Steps 2–18 do
 * that one row at a time per `docs/architecture/task-invalidation-roadmap.md`.
 */

import type { TaskState } from './state-machine.js';

/**
 * Named invalidation classes from the chart's "Proposed API Direction".
 * `none` is the explicit no-op for non-invalidating mutations
 * (e.g. external gate policy edits, approve/reject of a finished fix).
 */
export type InvalidationAction =
  | 'none'
  | 'retryTask'
  | 'retryWorkflow'
  | 'recreateTask'
  | 'recreateWorkflow'
  | 'recreateWorkflowFromFreshBase';

/**
 * Scope at which an `InvalidationAction` applies.
 *  - `'task'`     → applies to a single task identity within a workflow
 *  - `'workflow'` → applies across an entire workflow's active scope
 *  - `'none'`     → no-op (paired with action `'none'`)
 */
export type InvalidationScope = 'none' | 'task' | 'workflow';

/**
 * Per-mutation policy entry mirroring the chart Decision Table.
 */
export interface TaskMutationPolicy {
  invalidatesExecutionSpec: boolean;
  invalidateIfActive: boolean;
  action: InvalidationAction;
}

/**
 * Mutation keys that the policy table classifies in Step 1.
 *
 * The set mirrors the chart's example mapping plus the entries that
 * Steps 2–10 migrate. Adding more keys later is additive.
 */
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
  | 'externalGatePolicy';

/**
 * Mirrors the example mapping in
 * `docs/architecture/task-invalidation-chart.md → "Proposed API Direction"`
 * and the chart's Decision Table.
 *
 * Frozen to lock the policy as a constant. Migrations in Steps 2–10
 * route through these entries rather than redefining them.
 */
export const MUTATION_POLICIES: Readonly<Record<MutationKey, TaskMutationPolicy>> = Object.freeze({
  command:               { invalidatesExecutionSpec: true,  invalidateIfActive: true,  action: 'recreateTask' as const },
  prompt:                { invalidatesExecutionSpec: true,  invalidateIfActive: true,  action: 'recreateTask' as const },
  executionAgent:        { invalidatesExecutionSpec: true,  invalidateIfActive: true,  action: 'recreateTask' as const },
  executorType:          { invalidatesExecutionSpec: true,  invalidateIfActive: true,  action: 'retryTask' as const },
  remoteTargetId:        { invalidatesExecutionSpec: true,  invalidateIfActive: true,  action: 'recreateTask' as const },
  selectedExperiment:    { invalidatesExecutionSpec: true,  invalidateIfActive: true,  action: 'retryTask' as const },
  selectedExperimentSet: { invalidatesExecutionSpec: true,  invalidateIfActive: true,  action: 'retryTask' as const },
  mergeMode:             { invalidatesExecutionSpec: true,  invalidateIfActive: true,  action: 'retryTask' as const },
  fixContext:            { invalidatesExecutionSpec: true,  invalidateIfActive: true,  action: 'retryTask' as const },
  rebaseAndRetry:        { invalidatesExecutionSpec: true,  invalidateIfActive: true,  action: 'recreateWorkflowFromFreshBase' as const },
  externalGatePolicy:    { invalidatesExecutionSpec: false, invalidateIfActive: false, action: 'none' as const },
});

/**
 * Cancel-first runtime hook.
 *
 * Implementations must:
 *   1. interrupt orchestrator-side state for the affected scope, then
 *   2. await any in-flight executor work being killed.
 *
 * Per the chart's Hard Invariant, every retry/recreate route MUST call
 * this BEFORE invoking a lifecycle dep that resets authoritative state.
 */
export type CancelInFlightFn = (
  scope: InvalidationScope,
  id: string,
) => Promise<void>;

/**
 * Lifecycle deps the engine wires to back each `InvalidationAction`.
 *
 * `recreateWorkflowFromFreshBase` is intentionally optional in Step 1.
 * Today that semantic is the composite `rebaseAndRetry()` flow; Step 12
 * promotes it to a first-class primitive and supplies it here.
 */
export interface InvalidationDeps {
  cancelInFlight: CancelInFlightFn;
  retryTask: (taskId: string) => TaskState[] | Promise<TaskState[]>;
  recreateTask: (taskId: string) => TaskState[] | Promise<TaskState[]>;
  retryWorkflow: (workflowId: string) => TaskState[] | Promise<TaskState[]>;
  recreateWorkflow: (workflowId: string) => TaskState[] | Promise<TaskState[]>;
  recreateWorkflowFromFreshBase?: (workflowId: string) => TaskState[] | Promise<TaskState[]>;
}

const TASK_ACTIONS = new Set<InvalidationAction>(['retryTask', 'recreateTask']);
const WORKFLOW_ACTIONS = new Set<InvalidationAction>([
  'retryWorkflow',
  'recreateWorkflow',
  'recreateWorkflowFromFreshBase',
]);

/**
 * Centralized cancel-first router.
 *
 * Sequence (per chart "Hard Invariant"):
 *   1. await deps.cancelInFlight(scope, id)
 *   2. await deps.<action>(id)
 *
 * If `cancelInFlight` rejects, the lifecycle dep is NEVER called and
 * `applyInvalidation` rejects with that error. Stale in-flight work
 * must not survive a failed cancel — that is a hard policy.
 *
 * For `action === 'none'` this is a true no-op: `cancelInFlight` is
 * not called and `[]` is returned. Scope must also be `'none'`.
 */
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
  }
}
