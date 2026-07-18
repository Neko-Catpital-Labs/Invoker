/**
 * Post-mutation scheduler refill helpers.
 *
 * The durable launch outbox is now the only task launch path. These
 * helpers still call `orchestrator.startExecution()` so ready tasks are
 * claimed and written to `task_launch_dispatch`; the LaunchDispatcher
 * poll loop owns the actual `TaskRunner.executeTask(...)` handoff.
 */

import type { Logger } from '@invoker/contracts';
import type { Orchestrator, TaskState } from '@invoker/workflow-core';
import type { TaskRunner } from '@invoker/execution-engine';
import { createExecutionBench } from '@invoker/execution-engine';
import type { WorkflowMutationTiming } from './workflow-mutation-timing.js';


type GlobalTopupParams = {
  orchestrator: Orchestrator;
  taskExecutor: TaskRunner;
  logger?: Logger;
  context: string;
  alreadyDispatched?: TaskState[];
  mutationTiming?: WorkflowMutationTiming;
  dispatchMode?: 'await' | 'fire-and-forget';
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
  logger,
  context,
  runnable,
  bench,
  beforeMark,
  afterMark,
}: {
  logger?: Logger;
  context: string;
  runnable: TaskState[];
  bench: (phase: string, metadata?: Record<string, unknown>) => void;
  beforeMark: string;
  afterMark: string;
}): Promise<void> {
  bench(beforeMark);
  // The durable launch outbox owns dispatch. The orchestrator has
  // already enqueued each runnable task into task_launch_dispatch.
  // Calling taskExecutor.executeTasks(runnable) here would race the
  // dispatcher.
  logger?.debug?.(
    `[global-topup] ${context}: launch outbox owns launch (skipping in-process executeTasks)`,
  );
  bench(`${afterMark}.skippedForOutbox`, { runnableCount: runnable.length });
  return Promise.resolve();
}

function executeRunnableTasks({
  logger,
  context,
  runnable,
  dispatchKind,
}: {
  taskExecutor: TaskRunner;
  logger?: Logger;
  context: string;
  runnable: TaskState[];
  dispatchKind: 'global-topup' | 'scoped';
  mutationTiming?: WorkflowMutationTiming;
  spanName: string;
  dispatchMode: 'await' | 'fire-and-forget';
}): Promise<void> {
  const bench = createDispatchBench(logger, context, runnable, dispatchKind);
  const phasePrefix = dispatchKind === 'scoped'
    ? 'dispatchStartedTasksWithGlobalTopup.scopedExecuteTasks'
    : 'dispatchStartedTasksWithGlobalTopup.prestartedTopupExecuteTasks';
  return dispatchTasks({
    logger,
    context,
    runnable,
    bench,
    beforeMark: `${phasePrefix}.before`,
    afterMark: `${phasePrefix}.after`,
  });
}

export function isDispatchableLaunch(task: TaskState): boolean {
  return task.status === 'running'
    || (
      (task.status === 'pending' || (task.status as string) === 'queued')
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
    logger,
    context,
    runnable,
    bench,
    beforeMark: 'executeGlobalTopup.taskExecutor.executeTasks.before',
    afterMark: 'executeGlobalTopup.taskExecutor.executeTasks.after',
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
  });
  return { started, topup };
}
