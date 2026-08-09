import { makeEnvelope, type Logger } from '@invoker/contracts';
import { RESTART_TO_BRANCH_TRACE, type TaskRunner } from '@invoker/execution-engine';
import type { CommandService, Orchestrator } from '@invoker/workflow-core';

import {
  dispatchStartedTasksWithGlobalTopup,
  isDispatchableLaunch,
} from './global-topup.js';
import type { WorkflowMutationTiming } from './workflow-mutation-timing.js';

export interface StandaloneRetryTaskMutationDeps {
  commandService: CommandService;
  orchestrator: Orchestrator;
  taskExecutor: TaskRunner;
  logger: Logger;
  context: string;
  mutationTiming?: WorkflowMutationTiming;
}

export async function executeStandaloneRetryTaskMutation(
  taskIdArg: unknown,
  deps: StandaloneRetryTaskMutationDeps,
): Promise<void> {
  const taskId = String(taskIdArg);
  deps.logger.info(`retry-task: "${taskId}"`, { module: 'ipc' });
  try {
    const envelope = makeEnvelope('retry-task', 'ui', 'task', { taskId });
    const result = await deps.commandService.retryTask(envelope);
    if (!result.ok) throw new Error(result.error.message);
    const started = result.data;
    deps.logger.info(
      `${RESTART_TO_BRANCH_TRACE} ipc invoker:retry-task after commandService.retryTask: count=${started.length} [${started.map((t) => `${t.id}(${t.status})`).join(', ')}]`,
      { module: 'ipc' },
    );
    const runnable = started.filter(isDispatchableLaunch);
    deps.logger.info(
      `${RESTART_TO_BRANCH_TRACE} ipc invoker:retry-task runnable=${runnable.length} [${runnable.map((t) => t.id).join(', ') || '(none)'}] -> taskExecutor.executeTasks`,
      { module: 'ipc' },
    );
    await dispatchStartedTasksWithGlobalTopup({
      orchestrator: deps.orchestrator,
      taskExecutor: deps.taskExecutor,
      logger: deps.logger,
      context: deps.context,
      started,
      scopedTaskIds: [taskId],
      mutationTiming: deps.mutationTiming,
    });
  } catch (err) {
    deps.logger.error(`retry-task failed: ${err}`, { module: 'ipc' });
    throw err;
  }
}
