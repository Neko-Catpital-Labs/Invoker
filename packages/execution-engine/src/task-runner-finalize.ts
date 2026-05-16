import type { TaskState } from '@invoker/workflow-core';
import type { WorkResponse } from '@invoker/contracts';
import type { ExecutorHandle } from './executor.js';
import { RESTART_TO_BRANCH_TRACE, traceExecution } from './exec-trace.js';

type TaskRunnerPhaseHost = any;

export function routeWorkerResponse(
  host: TaskRunnerPhaseHost,
  task: TaskState,
  response: WorkResponse,
  options: { invokeCallback?: boolean } = {},
): TaskState[] {
  if (options.invokeCallback !== false) {
    host.callbacks.onComplete?.(task.id, response);
  }
  const newlyStarted = host.orchestrator.handleWorkerResponse(response) ?? [];
  if (newlyStarted.length > 0) {
    host.executeTasks(newlyStarted);
  }
  return newlyStarted;
}

export async function finalizeExecutorCompletion(
  host: TaskRunnerPhaseHost,
  task: TaskState,
  response: WorkResponse,
  attemptId: string,
  handle: ExecutorHandle,
): Promise<void> {
  const normalizedResponse = response.attemptId ? response : { ...response, attemptId };
  host.activeExecutions.delete(normalizedResponse.attemptId ?? attemptId);
  try {
    traceExecution(
      `[task-runner] onComplete taskId=${task.id} responseStatus=${response.status} ` +
        `responseAttemptId=${normalizedResponse.attemptId ?? attemptId} responseGeneration=${response.executionGeneration} executionId=${handle.executionId}`,
    );
    traceExecution(
      `${RESTART_TO_BRANCH_TRACE} resolvePromise | task.config.isMergeNode = ${task.config.isMergeNode}`,
    );
    routeWorkerResponse(host, task, normalizedResponse);
  } catch (err) {
    host.logger.error(`[TaskRunner] onComplete handler failed for task=${task.id}`, { err });
    const errResponse: WorkResponse = {
      requestId: response.requestId,
      actionId: task.id,
      attemptId,
      executionGeneration: task.execution.generation ?? 0,
      status: 'failed',
      outputs: {
        exitCode: 1,
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      },
    };
    host.callbacks.onComplete?.(task.id, errResponse);
    host.orchestrator.handleWorkerResponse(errResponse);
  } finally {
    await host.cleanupPerTaskDockerExecutor(task);
  }
}

export function createStartupFailureResponse(
  task: TaskState,
  attemptId: string,
  err: unknown,
): WorkResponse {
  return {
    requestId: `err-${task.id}`,
    actionId: task.id,
    attemptId,
    executionGeneration: task.execution.generation ?? 0,
    status: 'failed',
    outputs: {
      exitCode: 1,
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    },
  };
}
