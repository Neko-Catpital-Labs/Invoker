import { makeEnvelope, type Logger } from '@invoker/contracts';
import type { TaskRunner } from '@invoker/execution-engine';
import type { CommandService, Orchestrator } from '@invoker/workflow-core';

import { finalizeMutationWithGlobalTopup } from './global-topup.js';
import { approveTask } from './workflow-actions.js';
import type { WorkflowMutationTiming } from './workflow-mutation-timing.js';

export interface ApproveTaskMutationDeps {
  commandService: CommandService;
  orchestrator: Orchestrator;
  taskExecutor: TaskRunner;
  logger: Logger;
  context: string;
  mutationTiming?: WorkflowMutationTiming;
}

/**
 * Shared `invoker:approve` handler for the worker-facing mutation dispatcher
 * (standalone and owner-mode IPC delegation). Mirrors
 * `performSharedApproveTask` in `ipc/gui-mutation-handlers.ts`, which is the
 * GUI's own wrapper around the same `approveTask` action.
 */
export async function executeApproveTaskMutation(
  taskIdArg: unknown,
  deps: ApproveTaskMutationDeps,
): Promise<void> {
  const taskId = String(taskIdArg);
  deps.logger.info(`approve: "${taskId}"`, { module: 'ipc' });
  try {
    const { started } = await approveTask(taskId, {
      orchestrator: deps.orchestrator,
      taskExecutor: deps.taskExecutor,
      approve: async (approvedTaskId) => {
        const result = await deps.commandService.approve(
          makeEnvelope('approve', 'ui', 'task', { taskId: approvedTaskId }),
        );
        if (!result.ok) throw new Error(result.error.message);
        return result.data;
      },
      resumeAfterFixApproval: async (approvedTaskId) => {
        const result = await deps.commandService.resumeTaskAfterFixApproval(
          makeEnvelope('approve', 'ui', 'task', { taskId: approvedTaskId }),
        );
        if (!result.ok) throw new Error(result.error.message);
        return result.data;
      },
    });
    await finalizeMutationWithGlobalTopup({
      orchestrator: deps.orchestrator,
      taskExecutor: deps.taskExecutor,
      logger: deps.logger,
      context: deps.context,
      started,
      scopedTaskIds: [taskId],
      mutationTiming: deps.mutationTiming,
    });
  } catch (err) {
    deps.logger.error(`approve failed: ${err}`, { module: 'ipc' });
    throw err;
  }
}
