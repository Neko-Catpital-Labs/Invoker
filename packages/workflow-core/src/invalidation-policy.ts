
import { getTransitiveDependents, type TaskState } from '@invoker/workflow-graph';
export type InvalidationAction =
  | 'none'
  | 'scheduleOnly'
  | 'fixApprove'
  | 'fixReject'
  | 'retryTask'
  | 'retryWorkflow'
  | 'recreateTask'
  | 'recreateDownstream'
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
  // Non-invalidating: scheduling-policy edit, not execution-spec edit.
  externalGatePolicy:    { invalidatesExecutionSpec: false, invalidateIfActive: false, action: 'scheduleOnly' as const },
  fixApprove:            { invalidatesExecutionSpec: false, invalidateIfActive: false, action: 'fixApprove' as const },
  fixReject:             { invalidatesExecutionSpec: false, invalidateIfActive: false, action: 'fixReject' as const },
  // Topology mutations fork rather than mutate live workflows.
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
  /** Recreate a task's transitive downstream dependents while leaving the task itself untouched. */
  recreateDownstream?: (taskId: string) => TaskState[] | Promise<TaskState[]>;
  retryWorkflow: (workflowId: string) => TaskState[] | Promise<TaskState[]>;
  recreateWorkflow: (workflowId: string) => TaskState[] | Promise<TaskState[]>;
  recreateWorkflowFromFreshBase?: (workflowId: string) => TaskState[] | Promise<TaskState[]>;
  workflowFork?: (workflowId: string) => TaskState[] | Promise<TaskState[]>;
  /** Scheduling-only unblock pass; invoked WITHOUT a preceding `cancelInFlight`. */
  scheduleOnly?: (taskId: string) => TaskState[] | Promise<TaskState[]>;
  fixApprove?: (taskId: string) => TaskState[] | Promise<TaskState[]>;
  fixReject?: (taskId: string) => TaskState[] | Promise<TaskState[]>;
  /**
   * Cross-workflow cascade hook. Invoked only for actions that change
   * execution state:
   *   - task scope:     `retryTask`, `recreateTask`
   *   - workflow scope: `retryWorkflow`, `recreateWorkflow`,
   *                     `recreateWorkflowFromFreshBase`, `workflowFork`
   *
   * Skipped for `'none'`, `'scheduleOnly'`, `'fixApprove'`, and
   * `'fixReject'` — these are non-invalidating per `MUTATION_POLICIES`
   * and must not reset downstream lineage.
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

export type InvalidationMode = 'retry' | 'recreate' | 'scheduleOnly';

export interface InvalidationPlanningContext {
  targetId: string;
  tasks: readonly TaskState[];
  retryStatuses?: ReadonlySet<TaskState['status']>;
}

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
  /**
   * Planning fields used by `planInvalidation` (in `invalidation-plan.ts`).
   * Set on actions with planning support; absent for `'none'`,
   * `'fixApprove'`, `'fixReject'`, `'workflowFork'`. `planInvalidation`
   * throws when called with an action that lacks `selectAffectedTasks`.
   */
  readonly mode?: InvalidationMode;
  readonly reason?: string;
  readonly selectAffectedTasks?: (context: InvalidationPlanningContext) => TaskState[];
  readonly selectInitialEnqueueCandidates?: (
    context: InvalidationPlanningContext,
    affectedTasks: readonly TaskState[],
  ) => string[];
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

// ── Planning helpers (used by `selectAffectedTasks` callbacks below) ──

function taskMap(tasks: readonly TaskState[]): Map<string, TaskState> {
  return new Map(tasks.map((task) => [task.id, task]));
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

export const ACTION_SPECS: Readonly<Record<InvalidationAction, ActionSpec>> = Object.freeze({
  none: {
    scope: 'none',
    stages: ['validateScope'] as const,
    cascadesAcrossWorkflows: false,
  },
  scheduleOnly: {
    scope: 'task',
    stages: NON_INVALIDATING_TASK_STAGES,
    cascadesAcrossWorkflows: false,
    mode: 'scheduleOnly',
    reason: 'externalGatePolicy',
    selectAffectedTasks: ({ targetId, tasks }) => {
      const task = tasks.find((item) => item.id === targetId);
      return task ? [task] : [];
    },
    selectInitialEnqueueCandidates: (_context, affectedTasks) => affectedTasks.map((task) => task.id),
  },
  fixApprove: {
    scope: 'task',
    stages: NON_INVALIDATING_TASK_STAGES,
    cascadesAcrossWorkflows: false,
  },
  fixReject: {
    scope: 'task',
    stages: NON_INVALIDATING_TASK_STAGES,
    cascadesAcrossWorkflows: false,
  },
  retryTask: {
    scope: 'task',
    stages: INVALIDATING_STAGES,
    cascadesAcrossWorkflows: true,
    mode: 'retry',
    reason: 'task.retry',
    selectAffectedTasks: ({ targetId, tasks }) => taskAndDescendants(targetId, tasks, retryStop),
  },
  recreateTask: {
    scope: 'task',
    stages: INVALIDATING_STAGES,
    cascadesAcrossWorkflows: true,
    mode: 'recreate',
    reason: 'task.recreate',
    selectAffectedTasks: ({ targetId, tasks }) => taskAndDescendants(targetId, tasks),
  },
  recreateDownstream: {
    scope: 'task',
    stages: INVALIDATING_STAGES,
    cascadesAcrossWorkflows: true,
    mode: 'recreate',
    reason: 'task.recreateDownstream',
    selectAffectedTasks: ({ targetId, tasks }) => descendantsOf(targetId, taskMap(tasks)),
  },
  retryWorkflow: {
    scope: 'workflow',
    stages: INVALIDATING_STAGES,
    cascadesAcrossWorkflows: true,
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
  },
  recreateWorkflow: {
    scope: 'workflow',
    stages: INVALIDATING_STAGES,
    cascadesAcrossWorkflows: true,
    mode: 'recreate',
    reason: 'workflow.recreate',
    selectAffectedTasks: ({ targetId, tasks }) => tasks.filter((task) => task.config.workflowId === targetId),
  },
  recreateWorkflowFromFreshBase: {
    scope: 'workflow',
    stages: INVALIDATING_STAGES,
    cascadesAcrossWorkflows: true,
    mode: 'recreate',
    reason: 'workflow.recreateFromFreshBase',
    selectAffectedTasks: ({ targetId, tasks }) => tasks.filter((task) => task.config.workflowId === targetId),
  },
  workflowFork: {
    scope: 'workflow',
    stages: INVALIDATING_STAGES,
    cascadesAcrossWorkflows: true,
  },
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
    case 'recreateDownstream': {
      if (!deps.recreateDownstream) {
        throw new Error(
          "applyInvalidation: 'recreateDownstream' dep is missing. " +
            'Production callers wire this via buildInvalidationDeps in ' +
            '@invoker/app/workflow-actions; tests must supply ' +
            'deps.recreateDownstream to use this action.',
        );
      }
      return await deps.recreateDownstream(ctx.id);
    }
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
  cancelTask(taskId: string): { runningCancelled: string[] };
  cancelWorkflow(workflowId: string): { runningCancelled: string[] };
  retryTask(taskId: string): TaskState[];
  recreateTask(taskId: string): TaskState[];
  recreateDownstream(taskId: string): TaskState[];
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

export interface BuildCancelInFlightDeps {
  orchestrator: Pick<InvalidationDepsOrchestrator, 'cancelTask' | 'cancelWorkflow'>;
  /**
   * Optional hook to kill the active executor handle for each running
   * task that was cancelled. Production callers wire this to
   * `TaskRunner.killActiveExecution`; the orchestrator-only fallback
   * omits it (the orchestrator state machine still transitions the
   * tasks, but the in-flight process keeps running until it self-exits).
   */
  killActiveExecution?: (taskId: string) => void | Promise<void>;
}

/**
 * Single cancel-in-flight implementation shared by the orchestrator-only
 * fallback and the production `buildInvalidationDeps`. Tolerates
 * already-terminal targets (the rest of the pipeline still runs) and
 * fans out the optional executor-kill hook for every running task that
 * was cancelled.
 */
export function buildCancelInFlight(deps: BuildCancelInFlightDeps): CancelInFlightFn {
  return async (scope, id) => {
    if (scope === 'none') return;
    let result: { runningCancelled: string[] };
    try {
      result = scope === 'task'
        ? deps.orchestrator.cancelTask(id)
        : deps.orchestrator.cancelWorkflow(id);
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code && TERMINAL_CANCEL_ERROR_CODES.has(code)) return;
      throw e;
    }
    if (!deps.killActiveExecution) return;
    for (const runningId of result.runningCancelled) {
      await deps.killActiveExecution(runningId);
    }
  };
}

export function buildOrchestratorOnlyInvalidationDeps(
  orchestrator: InvalidationDepsOrchestrator,
): InvalidationDeps {
  return {
    cancelInFlight: buildCancelInFlight({ orchestrator }),
    retryTask: (taskId) => orchestrator.retryTask(taskId),
    recreateTask: (taskId) => orchestrator.recreateTask(taskId),
    recreateDownstream: (taskId) => orchestrator.recreateDownstream(taskId),
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
