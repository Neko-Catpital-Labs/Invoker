import type { Logger } from '@invoker/contracts';
import type { Orchestrator, TaskState } from '@invoker/workflow-core';
import type { TaskRunner } from '@invoker/execution-engine';

type GlobalTopupParams = {
  orchestrator: Orchestrator;
  taskExecutor: TaskRunner;
  logger?: Logger;
  context: string;
  alreadyDispatched?: TaskState[];
};

type MutationTopupParams = {
  orchestrator: Orchestrator;
  taskExecutor: TaskRunner;
  logger?: Logger;
  context: string;
  started?: TaskState[];
};

type DispatchIfNeededParams = {
  orchestrator: Orchestrator & { hasTaskDispatcher?: () => boolean };
  taskExecutor: TaskRunner;
  tasks: TaskState[];
  logger?: Logger;
  context: string;
};

function runningExecutionKey(task: TaskState): string {
  const attemptId = task.execution.selectedAttemptId?.trim();
  return attemptId ? `attempt:${attemptId}` : `task:${task.id}`;
}

export async function dispatchTasksIfNeeded({
  orchestrator,
  taskExecutor,
  tasks,
  logger,
  context,
}: DispatchIfNeededParams): Promise<TaskState[]> {
  const runnable = tasks.filter((task) => task.status === 'running');
  if (runnable.length === 0) {
    return [];
  }
  if (orchestrator.hasTaskDispatcher?.()) {
    logger?.info(`[dispatch] ${context}: relying on orchestrator taskDispatcher for ${runnable.length} task(s)`);
    return runnable;
  }
  await taskExecutor.executeTasks(runnable);
  return runnable;
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
  await dispatchTasksIfNeeded({
    orchestrator,
    taskExecutor,
    tasks: runnable,
    logger,
    context: `${context}.topup`,
  });
  return runnable;
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
}: MutationTopupParams): Promise<{ started: TaskState[]; topup: TaskState[] }> {
  const runnable = started.filter((task) => task.status === 'running');
  const topup = await executeGlobalTopup({
    orchestrator,
    taskExecutor,
    logger,
    context,
    alreadyDispatched: runnable,
  });
  return { started, topup };
}
