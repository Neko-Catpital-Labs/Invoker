import type { Logger } from '@invoker/contracts';
import type { Orchestrator, TaskState } from '@invoker/workflow-core';
import type { TaskRunner } from '@invoker/execution-engine';
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
      .filter((task) => task.status === 'running')
      .map((task) => runningExecutionKey(task)),
  );
  const started = orchestrator.startExecution();
  const runnable = started
    .filter((task) => task.status === 'running')
    .filter((task) => !dedupeKeys.has(runningExecutionKey(task)));

  if (runnable.length === 0) {
    logger?.info(`[global-topup] ${context}: no additional globally ready tasks`);
    return [];
  }

  logger?.info(
    `[global-topup] ${context}: dispatching ${runnable.length} additional task(s): [${runnable.map((task) => task.id).join(', ')}]`,
  );
  if (mutationTiming) {
    await mutationTiming.span(
      'executeGlobalTopup.taskExecutor.executeTasks',
      { context, runnableCount: runnable.length },
      () => taskExecutor.executeTasks(runnable),
    );
  } else {
    await taskExecutor.executeTasks(runnable);
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
  const runnable = started.filter((task) => task.status === 'running');
  if (runnable.length > 0) {
    logger?.info(
      `[global-topup] ${context}: dispatching ${runnable.length} scoped task(s): [${runnable.map((task) => task.id).join(', ')}]`,
    );
    if (mutationTiming) {
      await mutationTiming.span(
        'dispatchStartedTasksWithGlobalTopup.scopedExecuteTasks',
        { context, runnableCount: runnable.length },
        () => taskExecutor.executeTasks(runnable),
      );
    } else {
      await taskExecutor.executeTasks(runnable);
    }
  }
  const topup = await executeGlobalTopup({
    orchestrator,
    taskExecutor,
    logger,
    context,
    alreadyDispatched: runnable,
    mutationTiming,
  });
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
