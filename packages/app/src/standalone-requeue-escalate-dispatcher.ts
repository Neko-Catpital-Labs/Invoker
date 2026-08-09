import { makeEnvelope, type Logger } from '@invoker/contracts';
import { parseRequeueEscalateMutationArgs } from '@invoker/execution-engine';
import type { CommandService } from '@invoker/workflow-core';

export interface RequeueEscalateMutationDeps {
  commandService: CommandService;
  logger: Logger;
}

/**
 * Shared `invoker:requeue-escalate` handler for the worker-facing mutation
 * dispatcher (standalone and owner-mode IPC delegation). No `taskExecutor`
 * needed: escalating a stalled task to `needs_input` pauses it for a human,
 * it does not start new task execution.
 */
export async function executeRequeueEscalateMutation(
  args: unknown[],
  deps: RequeueEscalateMutationDeps,
): Promise<void> {
  const { taskId, prompt } = parseRequeueEscalateMutationArgs(args);
  deps.logger.info(`requeue-escalate: "${taskId}"`, { module: 'ipc' });
  try {
    const result = await deps.commandService.escalateStalledToNeedsInput(
      makeEnvelope('escalate-stalled', 'ui', 'task', { taskId, prompt }),
    );
    if (!result.ok) throw new Error(result.error.message);
  } catch (err) {
    deps.logger.error(`requeue-escalate failed: ${err}`, { module: 'ipc' });
    throw err;
  }
}
