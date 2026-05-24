
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
  | 'runnerKind'
  | 'poolMemberId'
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
  runnerKind:          { invalidatesExecutionSpec: true,  invalidateIfActive: true,  action: 'retryTask' as const },
  poolMemberId:        { invalidatesExecutionSpec: true,  invalidateIfActive: true,  action: 'recreateTask' as const },
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
  /**
   * Cross-workflow cascade hook. Invoked by `applyInvalidation` after
   * an invalidating action's dep returns, so any transitive downstream
   * workflow that depends on the invalidated upstream is itself
   * cancel-and-reset-to-pending. The downstream's existing external
   * dependency gate then re-blocks the freshly-pending tasks until
   * the upstream re-completes.
   *
   * Only invoked for actions that change execution state:
   *   - task scope:     `retryTask`, `recreateTask`
   *   - workflow scope: `retryWorkflow`, `recreateWorkflow`,
   *                     `recreateWorkflowFromFreshBase`, `workflowFork`
   *
   * Skipped for `'none'`, `'scheduleOnly'`, `'fixApprove'`, and
   * `'fixReject'` — these are non-invalidating per `MUTATION_POLICIES`
   * and must not reset downstream lineage.
   *
   * Production callers wire this via `buildInvalidationDeps`
   * (`packages/app/src/workflow-actions.ts`) to
   * `Orchestrator.cascadeInvalidationToDownstream`. The dep is
   * optional so unit tests that build a partial `InvalidationDeps`
   * keep working without supplying the cascade.
   */
  cascadeDownstream?: (
    scope: InvalidationScope,
    id: string,
  ) => TaskState[] | Promise<TaskState[]>;
}

// `applyInvalidation` is a reducer over a per-action ordered list of
// `Stage`s declared in `ACTION_SPECS`. Adding a new
// `InvalidationAction` is a single table entry; "cancel-first" and
// "every invalidating action cascades across workflows" are asserted
// as property tests over the spec table.
//
//   validateScope            → reject mismatched (scope, action) combos
//   cancelInFlight           → run `deps.cancelInFlight(scope, id)`
//   applyPrimitive           → dispatch to the matching dep and capture
//                              its returned `TaskState[]`
//   cascadeAcrossWorkflows   → run `deps.cascadeDownstream` if provided

export type InvalidationStage =
  | 'validateScope'
  | 'cancelInFlight'
  | 'applyPrimitive'
  | 'cascadeAcrossWorkflows';

export interface ActionSpec {
  /** Required `scope` for this action. */
  readonly scope: InvalidationScope;
  /** Ordered list of stages executed by `applyInvalidation`. */
  readonly stages: readonly InvalidationStage[];
  /**
   * True iff this action propagates to transitive downstream
   * workflows. Asserted to be equivalent to
   * `stages.includes('cascadeAcrossWorkflows')` by the property tests
   * in `invalidation-policy.test.ts`.
   */
  readonly cascadesAcrossWorkflows: boolean;
}

const NON_INVALIDATING_TASK_STAGES: readonly InvalidationStage[] = [
  'validateScope',
  'applyPrimitive',
];

const INVALIDATING_STAGES: readonly InvalidationStage[] = [
  'validateScope',
  'cancelInFlight',
  'applyPrimitive',
  'cascadeAcrossWorkflows',
];

export const ACTION_SPECS: Readonly<Record<InvalidationAction, ActionSpec>> = Object.freeze({
  none:                          { scope: 'none',     stages: ['validateScope'] as const, cascadesAcrossWorkflows: false },
  scheduleOnly:                  { scope: 'task',     stages: NON_INVALIDATING_TASK_STAGES, cascadesAcrossWorkflows: false },
  fixApprove:                    { scope: 'task',     stages: NON_INVALIDATING_TASK_STAGES, cascadesAcrossWorkflows: false },
  fixReject:                     { scope: 'task',     stages: NON_INVALIDATING_TASK_STAGES, cascadesAcrossWorkflows: false },
  retryTask:                     { scope: 'task',     stages: INVALIDATING_STAGES,         cascadesAcrossWorkflows: true  },
  recreateTask:                  { scope: 'task',     stages: INVALIDATING_STAGES,         cascadesAcrossWorkflows: true  },
  retryWorkflow:                 { scope: 'workflow', stages: INVALIDATING_STAGES,         cascadesAcrossWorkflows: true  },
  recreateWorkflow:              { scope: 'workflow', stages: INVALIDATING_STAGES,         cascadesAcrossWorkflows: true  },
  recreateWorkflowFromFreshBase: { scope: 'workflow', stages: INVALIDATING_STAGES,         cascadesAcrossWorkflows: true  },
  workflowFork:                  { scope: 'workflow', stages: INVALIDATING_STAGES,         cascadesAcrossWorkflows: true  },
});

interface PipelineCtx {
  readonly scope: InvalidationScope;
  readonly action: InvalidationAction;
  readonly id: string;
  /**
   * Holds the array reference returned by `applyPrimitive`. Stays a
   * mutable array (the type the public `applyInvalidation` returns
   * verbatim) so callers that compare via `===` to the dep's return
   * value keep observing the same reference, matching the historical
   * imperative implementation.
   */
  readonly started: TaskState[];
}

type StageHandler = (ctx: PipelineCtx, deps: InvalidationDeps) => Promise<PipelineCtx>;

const STAGE_HANDLERS: Readonly<Record<InvalidationStage, StageHandler>> = Object.freeze({
  validateScope: async (ctx) => {
    const expected = ACTION_SPECS[ctx.action].scope;
    if (ctx.scope === expected) return ctx;
    // Preserve the historical 'none' message so existing tests keep
    // matching it verbatim.
    if (ctx.action === 'none') {
      throw new Error(
        `applyInvalidation: scope must be 'none' when action is 'none' (got scope='${ctx.scope}')`,
      );
    }
    throw new Error(
      `applyInvalidation: action '${ctx.action}' requires scope '${expected}' (got '${ctx.scope}')`,
    );
  },
  cancelInFlight: async (ctx, deps) => {
    await deps.cancelInFlight(ctx.scope, ctx.id);
    return ctx;
  },
  applyPrimitive: async (ctx, deps) => {
    const started = await invokePrimitive(ctx, deps);
    // Preserve referential identity with the dep's return value:
    // tests (and callers) rely on `out === deps.<action>(id)`.
    return { ...ctx, started: started as TaskState[] };
  },
  cascadeAcrossWorkflows: async (ctx, deps) => {
    if (deps.cascadeDownstream) {
      await deps.cascadeDownstream(ctx.scope, ctx.id);
    }
    return ctx;
  },
});

async function invokePrimitive(
  ctx: PipelineCtx,
  deps: InvalidationDeps,
): Promise<TaskState[]> {
  switch (ctx.action) {
    case 'none':
      // `'none'` declares no `applyPrimitive` stage in `ACTION_SPECS`,
      // so this branch is unreachable. Keep it for exhaustiveness.
      return [];
    case 'scheduleOnly': {
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
      return await deps.scheduleOnly(ctx.id);
    }
    case 'fixApprove':
    case 'fixReject': {
      const dep = ctx.action === 'fixApprove' ? deps.fixApprove : deps.fixReject;
      if (!dep) {
        throw new Error(
          `applyInvalidation: '${ctx.action}' dep is missing. ` +
            'Production callers wire this via buildInvalidationDeps in ' +
            '@invoker/app/workflow-actions; tests must supply the dep to use this action.',
        );
      }
      return await dep(ctx.id);
    }
    case 'retryTask':
      return await deps.retryTask(ctx.id);
    case 'recreateTask':
      return await deps.recreateTask(ctx.id);
    case 'retryWorkflow':
      return await deps.retryWorkflow(ctx.id);
    case 'recreateWorkflow':
      return await deps.recreateWorkflow(ctx.id);
    case 'recreateWorkflowFromFreshBase': {
      if (!deps.recreateWorkflowFromFreshBase) {
        throw new Error(
          "applyInvalidation: 'recreateWorkflowFromFreshBase' is not yet wired (Step 12). " +
            'Provide deps.recreateWorkflowFromFreshBase to use this action.',
        );
      }
      return await deps.recreateWorkflowFromFreshBase(ctx.id);
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
      return await deps.workflowFork(ctx.id);
    }
  }
}

export async function applyInvalidation(
  scope: InvalidationScope,
  action: InvalidationAction,
  id: string,
  deps: InvalidationDeps,
): Promise<TaskState[]> {
  const spec = ACTION_SPECS[action];
  let ctx: PipelineCtx = { scope, action, id, started: [] };
  for (const stage of spec.stages) {
    ctx = await STAGE_HANDLERS[stage](ctx, deps);
  }
  return ctx.started;
}

// Structural type to avoid a circular import on the full
// `Orchestrator` class (which imports `applyInvalidation` from here).
export interface InvalidationDepsOrchestrator {
  cancelTask(taskId: string): unknown;
  cancelWorkflow(workflowId: string): unknown;
  retryTask(taskId: string): TaskState[];
  recreateTask(taskId: string): TaskState[];
  retryWorkflow(workflowId: string): TaskState[];
  recreateWorkflow(workflowId: string): TaskState[];
  recreateWorkflowFromFreshBase(workflowId: string): Promise<TaskState[]>;
  forkWorkflow(workflowId: string): { started: TaskState[] };
  autoStartExternallyUnblockedReadyTasks(): TaskState[];
  approve(taskId: string): Promise<TaskState[]>;
  reject(taskId: string, reason?: string): void;
  getTask(taskId: string): { config?: { workflowId?: string } } | undefined;
  cascadeInvalidationToDownstream(workflowId: string): TaskState[];
}

const TERMINAL_CANCEL_ERROR_CODES = new Set([
  'TASK_ALREADY_TERMINAL',
  'WORKFLOW_ALREADY_TERMINAL',
]);

export function buildOrchestratorOnlyInvalidationDeps(
  orchestrator: InvalidationDepsOrchestrator,
): InvalidationDeps {
  return {
    cancelInFlight: async (scope, id) => {
      if (scope === 'none') return;
      try {
        if (scope === 'task') orchestrator.cancelTask(id);
        else orchestrator.cancelWorkflow(id);
      } catch (e) {
        // Already-terminal targets have nothing to cancel; the rest
        // of the pipeline still runs.
        const code = (e as { code?: string })?.code;
        if (code && TERMINAL_CANCEL_ERROR_CODES.has(code)) return;
        throw e;
      }
    },
    retryTask: (taskId) => orchestrator.retryTask(taskId),
    recreateTask: (taskId) => orchestrator.recreateTask(taskId),
    retryWorkflow: (workflowId) => orchestrator.retryWorkflow(workflowId),
    recreateWorkflow: (workflowId) => orchestrator.recreateWorkflow(workflowId),
    recreateWorkflowFromFreshBase: (workflowId) =>
      orchestrator.recreateWorkflowFromFreshBase(workflowId),
    workflowFork: (workflowId) => orchestrator.forkWorkflow(workflowId).started,
    scheduleOnly: () => orchestrator.autoStartExternallyUnblockedReadyTasks(),
    fixApprove: (taskId) => orchestrator.approve(taskId),
    fixReject: (taskId) => {
      orchestrator.reject(taskId);
      return [];
    },
    cascadeDownstream: (scope, id) => {
      const workflowId =
        scope === 'workflow'
          ? id
          : orchestrator.getTask(id)?.config?.workflowId;
      if (!workflowId) return [];
      return orchestrator.cascadeInvalidationToDownstream(workflowId);
    },
  };
}

