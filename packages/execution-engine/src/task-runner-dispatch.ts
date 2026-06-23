/**
 * Dispatch phase — selects an executor and starts the task.
 *
 * Runs the executor-selection retry loop (with SSH transport-failure failover
 * and pre-start heartbeats), persists start metadata, registers the in-flight
 * execution, fires the spawn callback, and wires the output/heartbeat streams.
 *
 * Returns the live `{ executor, handle }` on success, or `undefined` when the
 * launch was rejected as stale/non-executable after start (the caller then
 * returns without finalizing). Startup failures throw, exactly as before.
 */

import type { TaskState, RunnerKind } from '@invoker/workflow-core';
import type { WorkRequest } from '@invoker/contracts';

import type { Executor, ExecutorHandle } from './executor.js';
import { RESTART_TO_BRANCH_TRACE, traceExecution } from './exec-trace.js';
import { DEFAULT_EXECUTION_AGENT } from './agent.js';
import {
  PRE_START_HEARTBEAT_INTERVAL_MS,
  getExecutorStartTimeoutMs,
  isRetryableSshStartupTransportError,
  nextLeaseExpiry,
  type StartupFailureMetadata,
} from './task-runner-launch-support.js';
import type { ActiveExecutionHandle, LaunchDispatchOptions } from './task-runner.js';
import type { TaskRunnerPhaseHost } from './task-runner-phase-host.js';

export async function dispatchExecutor(
  host: TaskRunnerPhaseHost,
  args: {
    task: TaskState;
    attemptId: string;
    request: WorkRequest;
    bench: (phase: string, metadata?: Record<string, unknown>) => void;
    dispatchOpts?: LaunchDispatchOptions;
  },
): Promise<{ executor: Executor; handle: ExecutorHandle } | undefined> {
  const { task, attemptId, request, bench, dispatchOpts } = args;
  const startGeneration = task.execution.generation ?? 0;
  const actionType = host.determineActionType(task);
  const executionAgent = task.config.executionAgent?.trim() || DEFAULT_EXECUTION_AGENT;

  const startT0 = Date.now();
  const attemptedPoolMemberKeys = new Set<string>();
  let executor!: Executor;
  let handle!: ExecutorHandle;
  while (true) {
    bench('selectExecutor.start');
    executor = host.selectExecutor(task, attemptedPoolMemberKeys);
    const poolSelectionForStart = host.pendingPoolSelections.get(task.id);
    if (!host.acquirePoolSelectionLease(task, attemptId, poolSelectionForStart)) {
      if (poolSelectionForStart) {
        attemptedPoolMemberKeys.add(poolSelectionForStart.memberKey);
        host.pendingPoolSelections.delete(task.id);
      }
      continue;
    }
    bench('selectExecutor.end', {
      executorType: executor.type,
    });
    traceExecution(
      `${RESTART_TO_BRANCH_TRACE} executeTaskInner taskId=${task.id} selectExecutor → type=${executor.type} calling executor.start()`,
    );
    traceExecution(`[trace] TaskRunner: task=${task.id} calling executor.start() type=${executor.type}`);
    host.logger.info(
      `[TaskRunner] executor.start begin task=${task.id} attempt=${attemptId} executor=${executor.type} ` +
        `generation=${task.execution.generation ?? 0}`,
    );
    host.persistence.logEvent?.(task.id, 'task.executor.start_begin', {
      dispatchId: dispatchOpts?.dispatchId,
      attemptId,
      executorType: executor.type,
      poolId: poolSelectionForStart?.poolId,
      poolMemberId: poolSelectionForStart?.member.id,
    });
    bench('onLaunchStart.before', {
      executorType: executor.type,
    });
    host.callbacks.onLaunchStart?.(task.id, executor);
    bench('executor.start.before', {
      executorType: executor.type,
    });
    const startTimeoutMs = getExecutorStartTimeoutMs();
    const preStartHeartbeatTimer = setInterval(() => {
      const now = new Date();
      host.renewPoolSelectionLease(poolSelectionForStart);
      host.persistence.updateAttempt?.(attemptId, {
        lastHeartbeatAt: now,
        leaseExpiresAt: nextLeaseExpiry(now),
      } as any);
      host.callbacks.onHeartbeat?.(task.id, { at: now, source: 'executor' });
    }, PRE_START_HEARTBEAT_INTERVAL_MS);
    let preStartTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      handle = await Promise.race<ExecutorHandle>([
        executor.start(request),
        new Promise<ExecutorHandle>((_resolve, reject) => {
          preStartTimeout = setTimeout(() => {
            reject(new Error(`Executor startup timed out after ${startTimeoutMs}ms (${executor.type})`));
          }, startTimeoutMs);
        }),
      ]);
      break;
    } catch (err) {
      const meta = err as StartupFailureMetadata;
      if (
        executor.type === 'ssh'
        && poolSelectionForStart?.member.type === 'ssh'
        && !meta.workspacePath
        && !meta.branch
        && isRetryableSshStartupTransportError(err)
      ) {
        attemptedPoolMemberKeys.add(poolSelectionForStart.memberKey);
        const pool = host.getExecutionPools()[poolSelectionForStart.poolId];
        const hasAnotherSshMember = pool?.members.some((member) =>
          member.type === 'ssh' && !attemptedPoolMemberKeys.has(host.poolMemberKey(member)),
        ) ?? false;
        if (hasAnotherSshMember) {
          const retryMessage =
            `Executor startup failed (${executor.type}) on pool member ${poolSelectionForStart.member.id}; ` +
            `retrying another SSH pool member: ${err instanceof Error ? err.message : String(err)}\n`;
          host.callbacks.onOutput?.(task.id, retryMessage);
          try {
            host.persistence.appendTaskOutput(task.id, retryMessage);
          } catch {
            // Preserve the original startup failure if output persistence also fails.
          }
          host.persistence.logEvent?.(task.id, 'task.executor.startup-retry', {
            runnerKind: executor.type,
            poolId: poolSelectionForStart.poolId,
            poolMemberId: poolSelectionForStart.member.id,
            reason: 'ssh-startup-transport-failure',
            error: err instanceof Error ? err.message : String(err),
          });
          host.pendingPoolSelections.delete(task.id);
          host.releasePoolSelectionLease(poolSelectionForStart);
          continue;
        }
      }
      const startupErrorMessage = `Executor startup failed (${executor.type}): ${err instanceof Error ? err.message : String(err)}\n`;
      host.callbacks.onOutput?.(task.id, startupErrorMessage);
      try {
        host.persistence.appendTaskOutput(task.id, startupErrorMessage);
      } catch {
        // Preserve the original startup failure if output persistence also fails.
      }
      const launchStale = host.isLaunchStale(task.id, attemptId, startGeneration);
      // Only persist startup-failure metadata when the launch is still
      // current.  If the task has moved to a newer attempt or generation
      // (e.g. via recreate-task), writing old workspace/branch metadata
      // would corrupt the live attempt's state.
      if (
        (meta.workspacePath || meta.branch || meta.agentSessionId || meta.containerId)
        && !launchStale
      ) {
        const execution: Record<string, string> = {};
        if (meta.workspacePath) execution.workspacePath = meta.workspacePath;
        if (meta.branch) execution.branch = meta.branch;
        if (meta.agentSessionId) {
          execution.agentSessionId = meta.agentSessionId;
          execution.lastAgentSessionId = meta.agentSessionId;
        }
        if (meta.containerId) execution.containerId = meta.containerId;
        const poolSelection = host.pendingPoolSelections.get(task.id);
        const selectedSshTargetId = executor.type === 'ssh'
          ? host.selectedRemoteTargetId(task, poolSelection)
          : undefined;
        host.persistence.updateTask(task.id, {
          config: {
            runnerKind: executor.type as RunnerKind,
            ...(selectedSshTargetId ? { poolMemberId: selectedSshTargetId } : {}),
          },
          execution: execution as any,
        });
      }
      if (launchStale) {
        host.persistence.logEvent?.(task.id, 'task.executor.stale_startup_failure', {
          attemptId,
          executorType: executor.type,
          error: err instanceof Error ? err.message : String(err),
          workspacePath: meta.workspacePath,
          branch: meta.branch,
          hasAgentSessionId: Boolean(meta.agentSessionId),
          hasContainerId: Boolean(meta.containerId),
        });
      }
      host.pendingPoolSelections.delete(task.id);
      host.releasePoolSelectionLease(poolSelectionForStart);
      const wrapped = new Error(
        `Executor startup failed (${executor.type}): ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
      if (!launchStale) {
        host.callbacks.onLaunchFailed?.(task.id, wrapped, executor);
      }
      throw wrapped;
    } finally {
      clearInterval(preStartHeartbeatTimer);
      if (preStartTimeout) clearTimeout(preStartTimeout);
    }
  }
  traceExecution(`[trace] TaskRunner: task=${task.id} executor.start() returned after ${Date.now() - startT0}ms executor=${executor.type} sessionId=${handle.agentSessionId ?? 'none'} workspace=${handle.workspacePath ?? 'default'}`);
  host.logger.info(
    `[TaskRunner] executor.start returned task=${task.id} attempt=${attemptId} executor=${executor.type} ` +
      `elapsedMs=${Date.now() - startT0} executionId=${handle.executionId} ` +
      `workspace=${handle.workspacePath ?? 'none'} branch=${handle.branch ?? 'none'} ` +
      `agentSessionId=${handle.agentSessionId ?? 'none'}`,
  );
  bench('executor.start.after', {
    executorType: executor.type,
    executorStartMs: Date.now() - startT0,
    hasWorkspacePath: Boolean(handle.workspacePath),
    hasAgentSessionId: Boolean(handle.agentSessionId),
  });
  const launchAccepted =
    host.orchestrator.markTaskRunningAfterLaunch?.(task.id, attemptId) ?? true;
  if (!launchAccepted) {
    host.logger.warn(
      `[TaskRunner] launch rejected as stale/non-executable for task=${task.id} attemptId=${attemptId}; killing spawned process`,
    );
    try {
      await executor.kill(handle);
    } catch (killErr) {
      host.logger.warn(`[TaskRunner] failed to kill rejected launch for task=${task.id}`, { killErr });
    }
    host.releasePoolSelectionLease(host.pendingPoolSelections.get(task.id));
    host.pendingPoolSelections.delete(task.id);
    await host.cleanupPerTaskDockerExecutor(task);
    if (dispatchOpts) {
      dispatchOpts.launchOutbox.failDispatch(
        dispatchOpts.dispatchId,
        new Error('Launch rejected as stale or non-executable after executor start'),
      );
    }
    bench('markTaskRunningAfterLaunch.rejected');
    return undefined;
  }
  bench('markTaskRunningAfterLaunch.accepted');

  // Persist execution metadata immediately at task start — all fields explicit
  {
    // Fail-fast: workspacePath must be provided by all executors
    if (!handle.workspacePath) {
      host.releasePoolSelectionLease(host.pendingPoolSelections.get(task.id));
      throw new Error(
        `Executor "${executor.type}" did not provide workspacePath for task "${task.id}". ` +
        `All executors must set workspacePath; refusing to fall back to host repo.`,
      );
    }

    host.logExecutorSelected(
      task,
      executor,
      handle,
      attemptId,
      host.pendingPoolSelections.get(task.id),
    );

    const poolSelection = host.pendingPoolSelections.get(task.id);
    const selectedSshTargetId = executor.type === 'ssh'
      ? host.selectedRemoteTargetId(task, poolSelection)
      : undefined;
    const changes = {
      config: {
        runnerKind: executor.type as RunnerKind,
        ...(selectedSshTargetId ? { poolMemberId: selectedSshTargetId } : {}),
      },
      execution: {
        workspacePath: handle.workspacePath,
        branch: handle.branch ?? undefined,  // Explicit undefined when branch is not applicable (e.g., BYO mode)
        agentSessionId: handle.agentSessionId ?? undefined,
        lastAgentSessionId: handle.agentSessionId ?? undefined,
        agentName: actionType === 'ai_task' ? executionAgent : undefined,
        lastAgentName: actionType === 'ai_task' ? executionAgent : undefined,
        containerId: handle.containerId ?? undefined,
      },
    };
    host.persistence.updateTask(task.id, changes);
    // Mirror branch + workspacePath onto the attempt row so reconciliation
    // and post-mortem flows can recover provenance from the attempt without
    // joining back to the task. Pairs with the early `onBranchResolved`
    // persistence; this is the authoritative success-path write.
    try {
      host.persistence.updateAttempt?.(attemptId, {
        branch: handle.branch ?? undefined,
        workspacePath: handle.workspacePath,
      } as any);
    } catch (err) {
      traceExecution(
        `${RESTART_TO_BRANCH_TRACE} task=${task.id} attempt=${attemptId} post-start attempt persist failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    traceExecution(
      `[agent-session-trace] TaskRunner.persistStartMetadata task=${task.id} agentSessionId=${handle.agentSessionId ?? 'null'}`,
    );
    if (task.config.isMergeNode) {
      traceExecution(
        `[merge-gate-workspace] persistStartMetadata mergeNode=${task.id} ` +
          `executor workspacePath=${changes.execution.workspacePath} ` +
          '(gate clone path is written later in executeMergeNode)',
      );
    }
    traceExecution(`[trace] TaskRunner: persisted metadata for task=${task.id} workspacePath=${handle.workspacePath} branch=${handle.branch ?? 'null'}`);
    bench('persistStartMetadata.end', {
      workspacePath: handle.workspacePath,
      branch: handle.branch ?? undefined,
    });
  }

  // Notify consumer about the spawned handle
  const activeHandle = handle as ActiveExecutionHandle;
  activeHandle.attemptId = attemptId;
  const poolSelection = host.pendingPoolSelections.get(task.id);
  host.pendingPoolSelections.delete(task.id);
  host.activeExecutions.set(attemptId, {
    handle: activeHandle,
    executor,
    taskId: task.id,
    poolId: poolSelection?.poolId,
    poolMemberKey: poolSelection?.memberKey,
    leaseResourceKey: poolSelection?.leaseResourceKey,
    leaseHolderId: poolSelection?.leaseHolderId,
  });
  host.logger.info(
    `[TaskRunner] active execution registered task=${task.id} attempt=${attemptId} ` +
      `executor=${executor.type} executionId=${handle.executionId} activeExecutions=${host.activeExecutions.size}`,
  );
  bench('onSpawned.before');
  host.callbacks.onSpawned?.(task.id, handle, executor);
  bench('onSpawned.after');

  // Wire output
  executor.onOutput(handle, (data) => {
    host.callbacks.onOutput?.(task.id, data);
  });

  // Wire heartbeat
  executor.onHeartbeat(handle, () => {
    const now = new Date();
    const isRemoteWorkloadHeartbeat = executor.type === 'ssh';
    if (isRemoteWorkloadHeartbeat) {
      host.logger.info(
        `[TaskRunner] ssh heartbeat received task=${task.id} attempt=${attemptId} executionId=${handle.executionId} ` +
          `at=${now.toISOString()}`,
      );
    }
    const activeLease = host.activeExecutions.get(attemptId);
    if (activeLease?.leaseResourceKey && activeLease.leaseHolderId) {
      host.persistence.renewExecutionResourceLease?.(activeLease.leaseResourceKey, activeLease.leaseHolderId);
    }
    host.persistence.updateAttempt?.(attemptId, {
      lastHeartbeatAt: now,
      leaseExpiresAt: nextLeaseExpiry(now),
    } as any);
    host.callbacks.onHeartbeat?.(task.id, {
      at: now,
      source: isRemoteWorkloadHeartbeat ? 'remote_workload' : 'executor',
    });
  });

  return { executor, handle };
}
