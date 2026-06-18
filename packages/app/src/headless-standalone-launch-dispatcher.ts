import type { TaskRunner } from '@invoker/execution-engine';
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
): StandaloneLaunchDispatcherController | null {
  const { headlessDeps, ownerId, createTaskExecutor, setLatestTaskExecutor } = options;
  if (headlessDeps.invokerConfig.launchOutboxMode !== 'active') return null;

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
    mode: 'active',
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
