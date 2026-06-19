import type { TaskRunner, TaskRunnerCallbacks } from '@invoker/execution-engine';
import type { WorkResponse } from '@invoker/contracts';
import type { HeadlessDeps } from './headless.js';
import { LaunchDispatcher } from './launch-dispatcher.js';

export interface StandaloneLaunchDispatcherController {
  stop(): void;
}

interface StandaloneLaunchDispatcherOptions {
  headlessDeps: HeadlessDeps;
  ownerId: string;
  createTaskExecutor: () => TaskRunner;
  setLatestTaskExecutor: (executor: TaskRunner) => void;
}

export function startStandaloneLaunchDispatcher(
  options: StandaloneLaunchDispatcherOptions,
): StandaloneLaunchDispatcherController {
  const { headlessDeps, ownerId, createTaskExecutor, setLatestTaskExecutor } = options;

  const originalProvider = headlessDeps.ownerTaskRunnerProvider;
  headlessDeps.ownerTaskRunnerProvider = undefined;
  let executor: TaskRunner;
  try {
    executor = createTaskExecutor();
  } catch (err) {
    headlessDeps.ownerTaskRunnerProvider = originalProvider;
    throw err;
  }
  headlessDeps.ownerTaskRunnerProvider = () => executor;
  setLatestTaskExecutor(executor);

  const dispatcher = new LaunchDispatcher({
    persistence: headlessDeps.persistence,
    orchestrator: {
      prepareTaskForNewAttempt: (taskId, reason) =>
        headlessDeps.orchestrator.prepareTaskForNewAttempt(taskId, reason),
      syncFromDb: (workflowId) => headlessDeps.orchestrator.syncFromDb(workflowId),
      getTask: (taskId) => headlessDeps.orchestrator.getTask(taskId),
      getTaskLaunchReadiness: (taskId) => headlessDeps.orchestrator.getTaskLaunchReadiness(taskId),
    },
    taskRunnerProvider: () => executor,
    ownerId,
    logger: headlessDeps.logger,
  });

  const poll = (): void => {
    try {
      dispatcher.poll();
    } catch (err) {
      headlessDeps.logger.warn(
        `[launch-dispatcher] standalone poll failed: ${err instanceof Error ? err.message : String(err)}`,
        { module: 'headless' },
      );
    }
  };

  const originalOnComplete: TaskRunnerCallbacks['onComplete'] = executor.callbacks.onComplete;
  executor.callbacks.onComplete = (taskId: string, response: WorkResponse): void => {
    originalOnComplete?.(taskId, response);
    poll();
  };

  poll();
  const pollInterval = setInterval(poll, 2_000);
  pollInterval.unref?.();

  return {
    stop(): void {
      clearInterval(pollInterval);
      headlessDeps.ownerTaskRunnerProvider = originalProvider;
    },
  };
}
