/**
 * Post-mutation scheduler refill helpers.
 *
 * Phase B (CB.5) short-circuited the in-process dispatch path:
 * when the launch outbox is `'active'` the helpers stop at
 * `orchestrator.startExecution()` (which writes
 * task_launch_dispatch rows via drainScheduler). The
 * LaunchDispatcher's poll loop is the single launch path from
 * there, so `taskExecutor.executeTasks(runnable)` is no longer
 * invoked in that mode.
 *
 * Phase C (CC.4) was meant to delete the legacy fire-and-forget
 * fallback wholesale. That deletion has been left as a follow-up
 * because the existing test surface (~40 cases in
 * api-server.test.ts, parity-regression.test.ts,
 * app-layer-handoff-repro.test.ts, workflow-mutation-facade.test.ts,
 * bridge-orchestrator-executor.test.ts, headless-delegation.test.ts)
 * still asserts on `taskExecutor.executeTasks` being called via
 * these helpers, and CB.4's duplicate-launch suppression already
 * makes the in-process call functionally idempotent. Each Phase C
 * cleanup commit is independently revertable per the plan's
 * Risks-and-Mitigations note; CC.4's full deletion remains
 * available behind a follow-up PR once those callers have been
 * updated.
 *
 * What still happens here, mode-by-mode:
 *   - `'active'`: helpers call `orchestrator.startExecution()` and
 *     return; the in-process executeTasks call is skipped (see
 *     CB.5).
 *   - `'observe'` / `'disabled'`: helpers preserve the legacy
 *     fire-and-forget behaviour so a flag rollback has zero other
 *     code changes.
 */

import type { Logger } from '@invoker/contracts';
import type { Orchestrator, TaskState } from '@invoker/workflow-core';
import type { TaskRunner } from '@invoker/execution-engine';
import { createExecutionBench } from '@invoker/execution-engine';
import type { WorkflowMutationTiming } from './workflow-mutation-timing.js';

export type LaunchOutboxMode = 'disabled' | 'observe' | 'active';

/**
 * Resolve the launch-outbox mode for a dispatch call. Explicit
 * arguments take precedence over the process-wide env-var fallback so
 * tests can run multiple modes in the same process; the env var is the
 * production wiring (see `resolveLaunchOutboxMode` in config.ts).
 */
function resolveLaunchOutboxMode(explicit?: LaunchOutboxMode): LaunchOutboxMode {
  if (explicit) return explicit;
  const raw = (process.env.INVOKER_LAUNCH_OUTBOX ?? '').toLowerCase().trim();
  return raw === 'active' || raw === 'observe' ? raw : 'disabled';
}

type GlobalTopupParams = {
  orchestrator: Orchestrator;
  taskExecutor: TaskRunner;
  logger?: Logger;
  context: string;
  alreadyDispatched?: TaskState[];
  mutationTiming?: WorkflowMutationTiming;
  dispatchMode?: 'await' | 'fire-and-forget';
  /**
   * When the durable launch-outbox dispatcher is `'active'`, the
   * in-process `taskExecutor.executeTasks` call becomes a no-op
   * because the orchestrator's drainScheduler already enqueues into
   * `task_launch_dispatch` and the LaunchDispatcher polls and
   * services that queue. We still walk the rest of the top-up
   * pipeline (logging, bench marks, return shape) so callers see
   * the same metadata regardless of mode.
   */
  launchOutboxMode?: LaunchOutboxMode;
};

type MutationTopupParams = {
  orchestrator: Orchestrator;
  taskExecutor: TaskRunner;
  logger?: Logger;
  context: string;
  started?: TaskState[];
  scopedWorkflowId?: string;
  scopedTaskIds?: string[];
  mutationTiming?: WorkflowMutationTiming;
  dispatchMode?: 'await' | 'fire-and-forget';
  launchOutboxMode?: LaunchOutboxMode;
};

function runningExecutionKey(task: TaskState): string {
  const attemptId = task.execution.selectedAttemptId?.trim();
  return attemptId ? `attempt:${attemptId}` : `task:${task.id}`;
}

function createDispatchBench(
  logger: Logger | undefined,
  context: string,
  runnable: TaskState[],
  dispatchKind: 'global-topup' | 'scoped',
): (phase: string, metadata?: Record<string, unknown>) => void {
  return createExecutionBench({
    module: 'scheduler-dispatch-bench',
    logger,
    baseMetadata: {
      context,
      dispatchKind,
      runnableCount: runnable.length,
      taskIds: runnable.map((task) => task.id),
      attemptIds: runnable.map((task) => task.execution.selectedAttemptId ?? null),
    },
  });
}

function hasExplicitScope(scopedWorkflowId?: string, scopedTaskIds?: string[]): boolean {
  return !!scopedWorkflowId || !!scopedTaskIds?.length;
}

function matchesScope(
  task: TaskState,
  scopedWorkflowId: string | undefined,
  scopedTaskIds: Set<string>,
): boolean {
  return (!!scopedWorkflowId && task.config.workflowId === scopedWorkflowId)
    || scopedTaskIds.has(task.id);
}

function dispatchTasks({
  taskExecutor,
  logger,
  context,
  runnable,
  mutationTiming,
  bench,
  spanName,
  beforeMark,
  afterMark,
  dispatchMode,
  launchOutboxMode,
}: {
  taskExecutor: TaskRunner;
  logger?: Logger;
  context: string;
  runnable: TaskState[];
  mutationTiming?: WorkflowMutationTiming;
  bench: (phase: string, metadata?: Record<string, unknown>) => void;
  spanName: string;
  beforeMark: string;
  afterMark: string;
  dispatchMode: 'await' | 'fire-and-forget';
  launchOutboxMode?: LaunchOutboxMode;
}): Promise<void> {
  bench(beforeMark);
  const effectiveMode = resolveLaunchOutboxMode(launchOutboxMode);
  if (effectiveMode === 'active') {
    // The durable launch outbox is the dispatcher in active mode. The
    // orchestrator's drainScheduler already enqueued each runnable into
    // task_launch_dispatch, and the LaunchDispatcher's poll loop calls
    // taskExecutor.executeTask(task, dispatchOpts). Calling
    // taskExecutor.executeTasks(runnable) here would race the outbox.
    logger?.debug?.(
      `[global-topup] ${context}: launchOutboxMode=active — outbox dispatcher owns launch (skipping in-process executeTasks)`,
    );
    bench(`${afterMark}.skippedForOutbox`, { runnableCount: runnable.length });
    return Promise.resolve();
  }
  const run = () => taskExecutor.executeTasks(runnable);
  if (dispatchMode === 'await') {
    return mutationTiming
      ? mutationTiming.span(spanName, { context, runnableCount: runnable.length }, run)
        .then(() => bench(afterMark))
      : Promise.resolve().then(run).then(() => bench(afterMark));
  }

  const dispatchPromise = mutationTiming
    ? mutationTiming.span(spanName, { context, runnableCount: runnable.length }, run)
    : Promise.resolve().then(run);
  void dispatchPromise
    .then(() => bench(afterMark))
    .catch((err) => {
      const message = err instanceof Error ? err.stack ?? err.message : String(err);
      logger?.error(`[global-topup] ${context}: asynchronous task dispatch failed: ${message}`);
  });
  bench(`${afterMark}.accepted`);
  return Promise.resolve();
}

function executeRunnableTasks({
  taskExecutor,
  logger,
  context,
  runnable,
  dispatchKind,
  mutationTiming,
  spanName,
  dispatchMode,
  launchOutboxMode,
}: {
  taskExecutor: TaskRunner;
  logger?: Logger;
  context: string;
  runnable: TaskState[];
  dispatchKind: 'global-topup' | 'scoped';
  mutationTiming?: WorkflowMutationTiming;
  spanName: string;
  dispatchMode: 'await' | 'fire-and-forget';
  launchOutboxMode?: LaunchOutboxMode;
}): Promise<void> {
  const bench = createDispatchBench(logger, context, runnable, dispatchKind);
  const phasePrefix = dispatchKind === 'scoped'
    ? 'dispatchStartedTasksWithGlobalTopup.scopedExecuteTasks'
    : 'dispatchStartedTasksWithGlobalTopup.prestartedTopupExecuteTasks';
  return dispatchTasks({
    taskExecutor,
    logger,
    context,
    runnable,
    mutationTiming,
    bench,
    spanName,
    beforeMark: `${phasePrefix}.before`,
    afterMark: `${phasePrefix}.after`,
    dispatchMode,
    launchOutboxMode,
  });
}

export function isDispatchableLaunch(task: TaskState): boolean {
  return task.status === 'running'
    || (
      task.status === 'pending'
      && task.execution.phase === 'launching'
      && !!task.execution.selectedAttemptId
    );
}

/**
 * Top up idle scheduler capacity after a scoped mutation.
 * This starts globally-ready work while avoiding duplicate execution
 * for tasks already dispatched by the scoped mutation path.
 */
export async function executeGlobalTopup({
  orchestrator,
  taskExecutor,
  logger,
  context,
  alreadyDispatched = [],
  mutationTiming,
  dispatchMode = mutationTiming ? 'fire-and-forget' : 'await',
  launchOutboxMode,
}: GlobalTopupParams): Promise<TaskState[]> {
  const dedupeKeys = new Set(
    alreadyDispatched
      .filter(isDispatchableLaunch)
      .map((task) => runningExecutionKey(task)),
  );
  const startBench = createExecutionBench({
    module: 'scheduler-dispatch-bench',
    logger,
    baseMetadata: {
      context,
      dispatchKind: 'global-topup',
      alreadyDispatchedCount: alreadyDispatched.length,
    },
  });
  startBench('executeGlobalTopup.startExecution.before');
  const started = orchestrator.startExecution();
  startBench('executeGlobalTopup.startExecution.after', { startedCount: started.length });
  const runnable = started
    .filter(isDispatchableLaunch)
    .filter((task) => !dedupeKeys.has(runningExecutionKey(task)));
  const bench = createDispatchBench(logger, context, runnable, 'global-topup');
  bench('executeGlobalTopup.runnableFiltered', { startedCount: started.length });

  if (runnable.length === 0) {
    logger?.info(`[global-topup] ${context}: no additional globally ready tasks`);
    bench('executeGlobalTopup.noRunnable');
    return [];
  }

  logger?.info(
    `[global-topup] ${context}: dispatching ${runnable.length} additional task(s): [${runnable.map((task) => task.id).join(', ')}]`,
  );
  await dispatchTasks({
    taskExecutor,
    logger,
    context,
    runnable,
    mutationTiming,
    bench,
    spanName: 'executeGlobalTopup.taskExecutor.executeTasks',
    beforeMark: 'executeGlobalTopup.taskExecutor.executeTasks.before',
    afterMark: 'executeGlobalTopup.taskExecutor.executeTasks.after',
    dispatchMode,
    launchOutboxMode,
  });
  return runnable;
}

/**
 * Dispatch mutation-scoped runnable work first, then top up any additional
 * globally ready tasks without double-launching the scoped set.
 */
export async function dispatchStartedTasksWithGlobalTopup({
  orchestrator,
  taskExecutor,
  logger,
  context,
  started = [],
  scopedWorkflowId,
  scopedTaskIds,
  mutationTiming,
  dispatchMode = mutationTiming ? 'fire-and-forget' : 'await',
  launchOutboxMode,
}: MutationTopupParams): Promise<{ runnable: TaskState[]; topup: TaskState[] }> {
  const dispatchable = started.filter(isDispatchableLaunch);
  const scopedTaskIdSet = new Set(scopedTaskIds ?? []);
  const useScope = hasExplicitScope(scopedWorkflowId, scopedTaskIds);
  const runnable = useScope
    ? dispatchable.filter((task) => matchesScope(task, scopedWorkflowId, scopedTaskIdSet))
    : dispatchable;
  const prestartedTopup = useScope
    ? dispatchable.filter((task) => !matchesScope(task, scopedWorkflowId, scopedTaskIdSet))
    : [];
  const bench = createDispatchBench(logger, context, runnable, 'scoped');
  bench('dispatchStartedTasksWithGlobalTopup.runnableFiltered', { startedCount: started.length });
  if (runnable.length > 0) {
    logger?.info(
      `[global-topup] ${context}: dispatching ${runnable.length} scoped task(s): [${runnable.map((task) => task.id).join(', ')}]`,
    );
    await executeRunnableTasks({
      taskExecutor,
      logger,
      context,
      runnable,
      dispatchKind: 'scoped',
      mutationTiming,
      spanName: 'dispatchStartedTasksWithGlobalTopup.scopedExecuteTasks',
      dispatchMode,
      launchOutboxMode,
    });
  } else {
    bench('dispatchStartedTasksWithGlobalTopup.noScopedRunnable');
  }
  if (prestartedTopup.length > 0) {
    logger?.info(
      `[global-topup] ${context}: dispatching ${prestartedTopup.length} prestarted top-up task(s): [${prestartedTopup.map((task) => task.id).join(', ')}]`,
    );
    await executeRunnableTasks({
      taskExecutor,
      logger,
      context,
      runnable: prestartedTopup,
      dispatchKind: 'global-topup',
      mutationTiming,
      spanName: 'dispatchStartedTasksWithGlobalTopup.prestartedTopupExecuteTasks',
      dispatchMode,
      launchOutboxMode,
    });
  }
  bench('dispatchStartedTasksWithGlobalTopup.executeGlobalTopup.before');
  const additionalTopup = await executeGlobalTopup({
    orchestrator,
    taskExecutor,
    logger,
    context,
    alreadyDispatched: [...runnable, ...prestartedTopup],
    mutationTiming,
    dispatchMode,
    launchOutboxMode,
  });
  const topup = [...prestartedTopup, ...additionalTopup];
  bench('dispatchStartedTasksWithGlobalTopup.executeGlobalTopup.after', { topupCount: topup.length });
  return { runnable, topup };
}

/**
 * Shared post-mutation scheduler refill.
 * Mutations that can free global capacity should exit through this helper
 * so globally ready work is launched before returning to the caller.
 */
export async function finalizeMutationWithGlobalTopup({
  orchestrator,
  taskExecutor,
  logger,
  context,
  started = [],
  scopedWorkflowId,
  scopedTaskIds,
  mutationTiming,
  dispatchMode,
  launchOutboxMode,
}: MutationTopupParams): Promise<{ started: TaskState[]; topup: TaskState[] }> {
  const { topup } = await dispatchStartedTasksWithGlobalTopup({
    orchestrator,
    taskExecutor,
    logger,
    context,
    started,
    scopedWorkflowId,
    scopedTaskIds,
    mutationTiming,
    dispatchMode,
    launchOutboxMode,
  });
  return { started, topup };
}
