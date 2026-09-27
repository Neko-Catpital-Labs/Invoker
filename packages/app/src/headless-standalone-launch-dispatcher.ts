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
  topUpReadyLaunchesEnabled?: () => boolean;
  deferFirstPollUntil?: Promise<unknown>;
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
    orchestrator: headlessDeps.orchestrator,
    taskRunnerProvider: () => executor,
    ownerId,
    logger: headlessDeps.logger,
    topUpReadyLaunchesEnabled: options.topUpReadyLaunchesEnabled,
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

  let pollInterval: ReturnType<typeof setInterval> | undefined;
  const startPolling = (): void => {
    poll();
    pollInterval = setInterval(poll, 2_000);
    pollInterval.unref?.();
  };

  if (options.deferFirstPollUntil) {
    void options.deferFirstPollUntil.then(startPolling).catch(() => startPolling());
  } else {
    startPolling();
  }

  return {
    stop(): void {
      if (pollInterval) clearInterval(pollInterval);
      headlessDeps.ownerTaskRunnerProvider = originalProvider;
    },
  };
}
