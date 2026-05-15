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
};

type MutationTopupParams = {
  orchestrator: Orchestrator;
  taskExecutor: TaskRunner;
  logger?: Logger;
  context: string;
  started?: TaskState[];
  mutationTiming?: WorkflowMutationTiming;
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
  if (mutationTiming) {
    bench('executeGlobalTopup.taskExecutor.executeTasks.before');
    await mutationTiming.span(
      'executeGlobalTopup.taskExecutor.executeTasks',
      { context, runnableCount: runnable.length },
      () => taskExecutor.executeTasks(runnable),
    );
    bench('executeGlobalTopup.taskExecutor.executeTasks.after');
  } else {
    bench('executeGlobalTopup.taskExecutor.executeTasks.before');
    await taskExecutor.executeTasks(runnable);
    bench('executeGlobalTopup.taskExecutor.executeTasks.after');
  }
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
  mutationTiming,
}: MutationTopupParams): Promise<{ runnable: TaskState[]; topup: TaskState[] }> {
  const runnable = started.filter(isDispatchableLaunch);
  const bench = createDispatchBench(logger, context, runnable, 'scoped');
  bench('dispatchStartedTasksWithGlobalTopup.runnableFiltered', { startedCount: started.length });
  if (runnable.length > 0) {
    logger?.info(
      `[global-topup] ${context}: dispatching ${runnable.length} scoped task(s): [${runnable.map((task) => task.id).join(', ')}]`,
    );
    if (mutationTiming) {
      bench('dispatchStartedTasksWithGlobalTopup.scopedExecuteTasks.before');
      await mutationTiming.span(
        'dispatchStartedTasksWithGlobalTopup.scopedExecuteTasks',
        { context, runnableCount: runnable.length },
        () => taskExecutor.executeTasks(runnable),
      );
      bench('dispatchStartedTasksWithGlobalTopup.scopedExecuteTasks.after');
    } else {
      bench('dispatchStartedTasksWithGlobalTopup.scopedExecuteTasks.before');
      await taskExecutor.executeTasks(runnable);
      bench('dispatchStartedTasksWithGlobalTopup.scopedExecuteTasks.after');
    }
  } else {
    bench('dispatchStartedTasksWithGlobalTopup.noScopedRunnable');
  }
  bench('dispatchStartedTasksWithGlobalTopup.executeGlobalTopup.before');
  const topup = await executeGlobalTopup({
    orchestrator,
    taskExecutor,
    logger,
    context,
    alreadyDispatched: runnable,
    mutationTiming,
  });
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
  mutationTiming,
}: MutationTopupParams): Promise<{ started: TaskState[]; topup: TaskState[] }> {
  const { topup } = await dispatchStartedTasksWithGlobalTopup({
    orchestrator,
    taskExecutor,
    logger,
    context,
    started,
    mutationTiming,
  });
  return { started, topup };
}
