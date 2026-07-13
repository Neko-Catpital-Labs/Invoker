/**
 * Finalize phase — wires task completion back to the orchestrator.
 *
 * Registers the executor `onComplete` handler that normalizes the
 * {@link WorkResponse}, releases the execution lease, routes the response
 * through the orchestrator (serialized via `runSerializedCompletion`), fires
 * the `onComplete` observer callback, launches any newly-ready tasks, and
 * cleans up the per-task Docker executor. Returns the completion promise and
 * acknowledges the launch-dispatch row.
 *
 * Callback payload shapes and orchestrator response routing are preserved
 * exactly as they were inline in `executeTaskInner`.
 */

import type { TaskState } from '@invoker/workflow-core';
import type { WorkResponse } from '@invoker/contracts';

import type { Executor, ExecutorHandle } from './executor.js';
import { RESTART_TO_BRANCH_TRACE, traceExecution } from './exec-trace.js';
import type { LaunchDispatchOptions } from './task-runner.js';
import type { TaskRunnerPhaseHost } from './task-runner-phase-host.js';

export function wireCompletion(
  host: TaskRunnerPhaseHost,
  args: {
    task: TaskState;
    attemptId: string;
    executor: Executor;
    handle: ExecutorHandle;
    dispatchOpts?: LaunchDispatchOptions;
  },
): Promise<void> {
  const { task, attemptId, executor, handle, dispatchOpts } = args;

  // Wait for completion and feed response to orchestrator.
  // The callback is serialized through completionChain so that concurrent
  // onComplete firings never overlap inside orchestrator mutations.
  const completionPromise = new Promise<void>((resolvePromise) => {
    executor.onComplete(handle, async (response: WorkResponse) => {
      const work = async () => {
        const normalizedResponse = response.attemptId ? response : { ...response, attemptId };
        const activeExecution = host.activeExecutions.get(normalizedResponse.attemptId ?? attemptId);
        if (activeExecution?.leaseResourceKey && activeExecution.leaseHolderId) {
          host.persistence.releaseExecutionResourceLease?.(activeExecution.leaseResourceKey, activeExecution.leaseHolderId);
        }
        host.activeExecutions.delete(normalizedResponse.attemptId ?? attemptId);
        host.logger.info(
          `[TaskRunner] completion callback task=${task.id} attempt=${normalizedResponse.attemptId ?? attemptId} ` +
            `status=${normalizedResponse.status} exitCode=${normalizedResponse.outputs.exitCode ?? 'none'} ` +
            `executionId=${handle.executionId} activeExecutions=${host.activeExecutions.size}`,
        );
        let newlyStarted: TaskState[] = [];
        try {
          try {
            traceExecution(
              `[task-runner] onComplete taskId=${task.id} responseStatus=${response.status} ` +
                `responseAttemptId=${normalizedResponse.attemptId ?? attemptId} responseGeneration=${response.executionGeneration} executionId=${handle.executionId}`,
            );
            traceExecution(
              `${RESTART_TO_BRANCH_TRACE} resolvePromise | task.config.isMergeNode = ${task.config.isMergeNode}`,
            );
            if (host.isLaunchStale(task.id, attemptId, task.execution.generation ?? 0)) {
              host.logger.warn(
                `[TaskRunner] suppressing stale completion response for task=${task.id} attemptId=${attemptId}`,
              );
              return;
            }
            newlyStarted = host.orchestrator.handleWorkerResponse(normalizedResponse) ?? [];
          } catch (err) {
            host.logger.error(`[TaskRunner] worker response handling failed for task=${task.id}`, { err });
            if (host.isLaunchStale(task.id, attemptId, task.execution.generation ?? 0)) {
              host.logger.warn(
                `[TaskRunner] suppressing fallback failure response for stale completion task=${task.id} attemptId=${attemptId}`,
              );
              return;
            }
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
            try {
              host.orchestrator.handleWorkerResponse(errResponse);
            } catch (fallbackErr) {
              host.logger.error(`[TaskRunner] fallback failure response handling failed for task=${task.id}`, { err: fallbackErr });
            }
            try {
              host.callbacks.onComplete?.(task.id, errResponse);
            } catch (callbackErr) {
              host.logger.error(`[TaskRunner] completion callback observer failed for task=${task.id}`, { err: callbackErr });
            }
            return;
          }

          try {
            host.callbacks.onComplete?.(task.id, normalizedResponse);
          } catch (err) {
            host.logger.error(`[TaskRunner] completion callback observer failed for task=${task.id}`, { err });
          }

          host.executeNewlyStartedTasks(newlyStarted, dispatchOpts);
        } finally {
          // Clean up per-task Docker executor to avoid resource leaks
          try {
            await host.cleanupPerTaskDockerExecutor(task);
          } catch (cleanupErr) {
            host.logger.warn(`[TaskRunner] completion cleanup failed for task=${task.id}`, { err: cleanupErr });
          }
        }
      };

      await host.runSerializedCompletion(work);
      resolvePromise();
    });
  });
  if (dispatchOpts) {
    dispatchOpts.launchOutbox.completeDispatch(dispatchOpts.dispatchId);
  }
  return completionPromise;
}
