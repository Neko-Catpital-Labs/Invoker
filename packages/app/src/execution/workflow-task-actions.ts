import { OrchestratorErrorCode } from '@invoker/workflow-core';
import type { CommandService, Orchestrator, TaskState } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';
import { CommandError, makeEnvelope } from '@invoker/contracts';
import type { Logger } from '@invoker/contracts';
import { DEFAULT_EXECUTION_AGENT, remoteFetchForPool, type TaskRunner } from '@invoker/execution-engine';
import { loadConfig, type InvokerConfig } from '../config.js';
import { assertExecutionCapacityInvariant, shouldFatalOnExecutionCapacityOvercommit } from '../execution-capacity.js';
import {
  approveTask as sharedApproveTask,
  fixWithAgentAction,
  selectFailureRecoveryRoute,
  StaleLineageError,
} from '../workflow-actions.js';
import { dispatchStartedTasksWithGlobalTopup } from '../global-topup.js';
import type { WorkflowCancelResult } from '../workflow-preemption.js';
import { listOpenFixIntentsForTask, type ReviewGateCiContext } from '../auto-fix-intents.js';
import {
  buildRecoveryWorkerAuditPayload,
  classifyAutoFixRecoveryPhase,
  recoveryWorkerEventType,
} from '../recovery-worker-observability.js';
import type { WorkflowMutationPriority } from '../workflow-mutation-coordinator.js';
import type {
  PersistedWorkflowMutationCoordinator,
  WorkflowMutationContext,
} from '../persisted-workflow-mutation-coordinator.js';
import type { TaskHandleMap } from './task-runner-wiring.js';

export interface WorkflowTaskActionsDeps {
  getOrchestrator: () => Orchestrator;
  getPersistence: () => SQLiteAdapter;
  getCommandService: () => CommandService;
  getActiveMutationContext: () => WorkflowMutationContext | undefined;
  getWorkflowMutationCoordinator: () => PersistedWorkflowMutationCoordinator | null;
  getLogger: () => Logger;
  invokerConfig: InvokerConfig;
  taskHandles: TaskHandleMap;
  workflowMutationDispatcher: Map<string, (...args: unknown[]) => Promise<unknown>>;
  killRunningTask: (taskId: string) => Promise<void>;
  cancelDeferredWorkflowLaunch: (workflowId: string, reason: string) => void;
  requireTaskExecutor: () => TaskRunner;
  requestWorkflowMetadataPublish: (reason: string) => void;
  workflowIdForTaskArg: (taskIdArg: unknown) => string | undefined;
  runWorkflowMutation: <T>(
    workflowId: string | undefined,
    priority: WorkflowMutationPriority,
    channel: string,
    args: unknown[],
    op: () => Promise<T>,
  ) => Promise<T>;
}

export function parseExecutionDate(value: unknown): Date | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function createWorkflowTaskActions(deps: WorkflowTaskActionsDeps) {
  const {
    getOrchestrator,
    getPersistence,
    getCommandService,
    getActiveMutationContext,
    getWorkflowMutationCoordinator,
    getLogger,
    invokerConfig,
    taskHandles,
    workflowMutationDispatcher,
    killRunningTask,
    requireTaskExecutor,
    requestWorkflowMetadataPublish,
    workflowIdForTaskArg,
    runWorkflowMutation,
  } = deps;

  const buildAutoFixQueueSnapshot = (taskId: string): Record<string, unknown> => {
    const workflowId = workflowIdForTaskArg(taskId);
    if (!workflowId) {
      return {
        workflowId: null,
        openIntentCountForWorkflow: 0,
        openFixIntentCountForWorkflow: 0,
        openFixIntentCountForTask: 0,
        openFixIntentForTask: false,
        openFixIntentHead: null,
        openFixIntentPreview: [],
      };
    }
    const openIntents = getPersistence().listWorkflowMutationIntents(workflowId, ['queued', 'running']);
    const openFixIntents = openIntents.filter((intent) => (
      intent.channel === 'invoker:fix-with-agent' || intent.channel === 'headless.exec'
    ));
    const openTaskFixIntents = listOpenFixIntentsForTask(openIntents, taskId);
    return {
      workflowId,
      openIntentCountForWorkflow: openIntents.length,
      openFixIntentCountForWorkflow: openFixIntents.length,
      openFixIntentCountForTask: openTaskFixIntents.length,
      openFixIntentForTask: openTaskFixIntents.length > 0,
      openFixIntentHead: openTaskFixIntents[0]
        ? {
          id: openTaskFixIntents[0].id,
          status: openTaskFixIntents[0].status,
          channel: openTaskFixIntents[0].channel,
        }
        : null,
      openFixIntentPreview: openTaskFixIntents.slice(0, 5).map((intent) => ({
        id: intent.id,
        status: intent.status,
        channel: intent.channel,
      })),
    };
  };

  const logAutoFixDebug = (
    taskId: string,
    phase: string,
    details: Record<string, unknown> = {},
  ): void => {
    const task = getOrchestrator().getTask(taskId);
    const payload = {
      phase,
      status: task?.status ?? 'missing',
      ...buildAutoFixQueueSnapshot(taskId),
      ...details,
    };
    getPersistence().logEvent?.(taskId, 'debug.auto-fix', payload);
    const recoveryAction = classifyAutoFixRecoveryPhase(phase, payload);
    if (recoveryAction) {
      getPersistence().logEvent?.(
        taskId,
        recoveryWorkerEventType(recoveryAction),
        buildRecoveryWorkerAuditPayload(recoveryAction, phase, payload),
      );
    }
    getLogger().info(
      `[auto-fix-debug] task="${taskId}" phase=${phase} payload=${JSON.stringify(payload)}`,
      { module: 'auto-fix' },
    );
  };

  const executeFixWithAgentMutation = async (
    taskId: string,
    agentName?: string,
    source: 'ipc' | 'auto-fix' = 'ipc',
    reviewGateContext?: ReviewGateCiContext,
  ): Promise<TaskState[]> => {
    const task = getOrchestrator().getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    const savedError = task.execution.error ?? '';
    const recoveryRoute = selectFailureRecoveryRoute(task, savedError);
    getLogger().info(
      `fix-with-agent: "${taskId}" agent=${agentName ?? DEFAULT_EXECUTION_AGENT} source=${source} route=${recoveryRoute.kind}`,
      { module: 'ipc' },
    );

    const result = await fixWithAgentAction(
      taskId,
      {
        logger: getLogger(),
        orchestrator: getOrchestrator(),
        persistence: getPersistence(),
        commandService: getCommandService(),
        taskExecutor: requireTaskExecutor(),
        mutationTiming: getActiveMutationContext()?.mutationTiming,
        autoApproveAIFixes: invokerConfig.autoApproveAIFixes,
      },
      {
        agentName,
        recoveryRoute,
        recreateOutputLabel: source === 'auto-fix' ? 'Auto-fix' : 'Fix with AI',
        failureOutputLabel: source === 'auto-fix' ? 'Auto-fix' : `Fix with ${agentName ?? 'Codex'}`,
        reviewGateContext,
        signal: getActiveMutationContext()?.signal,
      },
    );
    return result.started;
  };

  const scheduleAutoFix = (taskId: string): void => {
    logAutoFixDebug(taskId, 'schedule-enter');
    if (!getWorkflowMutationCoordinator()) {
      logAutoFixDebug(taskId, 'schedule-skip', { reason: 'no-workflow-mutation-coordinator' });
      return;
    }
    if (!workflowMutationDispatcher.has('invoker:fix-with-agent')) {
      logAutoFixDebug(taskId, 'schedule-skip', { reason: 'fix-handler-not-ready' });
      return;
    }
    const workflowId = workflowIdForTaskArg(taskId);
    if (!workflowId) {
      logAutoFixDebug(taskId, 'schedule-skip', { reason: 'workflow-not-found' });
      return;
    }
    const shouldAutoFixNow = getOrchestrator().shouldAutoFix(taskId);
    if (!shouldAutoFixNow) {
      logAutoFixDebug(taskId, 'schedule-skip', {
        reason: 'shouldAutoFix-false',
        shouldAutoFix: shouldAutoFixNow,
      });
      return;
    }
    const openIntents = getPersistence().listWorkflowMutationIntents(workflowId, ['queued', 'running']);
    const openTaskFixIntents = listOpenFixIntentsForTask(openIntents, taskId);
    if (openTaskFixIntents.length > 0) {
      logAutoFixDebug(taskId, 'schedule-skip', {
        reason: 'already-queued-intent',
        existingIntentIds: openTaskFixIntents.map((intent) => intent.id),
      });
      return;
    }
    const configuredAgent = loadConfig().autoFixAgent?.trim();
    const selectedAgent = configuredAgent && configuredAgent.length > 0 ? configuredAgent : undefined;
    logAutoFixDebug(taskId, 'schedule-enqueue');
    logAutoFixDebug(taskId, 'schedule-enqueued');
    void runWorkflowMutation(
      workflowId,
      'normal',
      'invoker:fix-with-agent',
      [taskId, selectedAgent],
      async () => executeFixWithAgentMutation(taskId, selectedAgent, 'auto-fix'),
    )
      .then(() => {
        logAutoFixDebug(taskId, 'schedule-dispatch-finished');
      })
      .catch((err) => {
        if (err instanceof StaleLineageError) {
          getLogger().info(`auto-fix discarded stale result for "${taskId}": ${err.message}`, { module: 'auto-fix' });
          return;
        }
        logAutoFixDebug(taskId, 'schedule-dispatch-error', {
          error: err instanceof Error ? err.stack ?? err.message : String(err),
        });
      });
  };

  function assertFatalExecutionCapacity(label: string): void {
    if (!shouldFatalOnExecutionCapacityOvercommit()) return;
    try {
      assertExecutionCapacityInvariant({
        config: loadConfig(),
        activeExecutions: taskHandles.size,
        label,
      });
    } catch (err) {
      getLogger().error(err instanceof Error ? err.stack ?? err.message : String(err), { module: 'exec' });
      setImmediate(() => {
        throw err;
      });
      throw err;
    }
  }

  async function performCancelTask(taskId: string): Promise<{ cancelled: string[]; runningCancelled: string[] }> {
    const envelope = makeEnvelope('cancel-task', 'ui', 'task', { taskId });
    const cmdResult = await getCommandService().cancelTask(envelope);
    if (!cmdResult.ok) throw CommandError.fromResult(cmdResult.error);
    for (const id of cmdResult.data.runningCancelled) {
      await killRunningTask(id);
    }
    return cmdResult.data;
  }

  async function performDeleteTask(taskId: string): Promise<void> {
    getLogger().info(`performDeleteTask begin task="${taskId}"`, { module: 'kill' });
    const task = getOrchestrator().getTask(taskId);
    const workflowId = task?.config.workflowId;
    if (task && (task.status === 'running' || task.status === 'fixing_with_ai')) {
      await killRunningTask(task.id);
    }
    if (workflowId) {
      await requireTaskExecutor().closeWorkflowReview(workflowId);
    }
    const envelope = makeEnvelope('delete-task', 'ui', 'task', { taskId });
    const result = await getCommandService().deleteTask(envelope);
    if (!result.ok) throw CommandError.fromResult(result.error);
    remoteFetchForPool.enabled = false;
    try {
      await dispatchStartedTasksWithGlobalTopup({
        orchestrator: getOrchestrator(),
        taskExecutor: requireTaskExecutor(),
        logger: getLogger(),
        context: 'ipc.delete-task',
        started: result.data,
        scopedTaskIds: result.data.map((startedTask) => startedTask.id),
        mutationTiming: getActiveMutationContext()?.mutationTiming,
      });
    } finally {
      remoteFetchForPool.enabled = true;
    }
    requestWorkflowMetadataPublish('delete-task');
    getLogger().info(`performDeleteTask end task="${taskId}"`, { module: 'kill' });
  }

  async function performCancelWorkflow(workflowId: string): Promise<{ cancelled: string[]; runningCancelled: string[] }> {
    getLogger().info(`performCancelWorkflow begin workflow="${workflowId}"`, { module: 'kill' });
    const envelope = makeEnvelope('cancel-workflow', 'ui', 'workflow', { workflowId });
    const cmdResult = await getCommandService().cancelWorkflow(envelope);
    if (!cmdResult.ok) throw CommandError.fromResult(cmdResult.error);
    getLogger().info(
      `performCancelWorkflow commandService complete workflow="${workflowId}" cancelled=${cmdResult.data.cancelled.length} runningCancelled=${cmdResult.data.runningCancelled.length}`,
      { module: 'kill' },
    );
    for (const id of cmdResult.data.runningCancelled) {
      getLogger().info(`performCancelWorkflow killing running task "${id}"`, { module: 'kill' });
      await killRunningTask(id);
    }
    getLogger().info(`performCancelWorkflow end workflow="${workflowId}"`, { module: 'kill' });
    return cmdResult.data;
  }

  async function performDeleteWorkflow(workflowId: string): Promise<void> {
    getLogger().info(`performDeleteWorkflow begin workflow="${workflowId}"`, { module: 'kill' });
    const allTasks = getOrchestrator().getAllTasks();
    const workflowTasks = allTasks.filter(
      (t) =>
        t.config.workflowId === workflowId &&
        (t.status === 'running' || t.status === 'fixing_with_ai'),
    );
    for (const task of workflowTasks) {
      await killRunningTask(task.id);
    }
    await requireTaskExecutor().closeWorkflowReview(workflowId);
    const envelope = makeEnvelope('delete-workflow', 'ui', 'workflow', { workflowId });
    const result = await getCommandService().deleteWorkflow(envelope);
    if (!result.ok) throw new Error(result.error.message);
    requestWorkflowMetadataPublish('delete-workflow');
    getLogger().info(`performDeleteWorkflow end workflow="${workflowId}"`, { module: 'kill' });
  }

  async function performDetachWorkflow(workflowId: string, upstreamWorkflowId: string): Promise<void> {
    getLogger().info(`performDetachWorkflow begin workflow="${workflowId}" upstream="${upstreamWorkflowId}"`, { module: 'kill' });
    const envelope = makeEnvelope('detach-workflow', 'ui', 'workflow', { workflowId, upstreamWorkflowId });
    const result = await getCommandService().detachWorkflow(envelope);
    if (!result.ok) throw new Error(result.error.message);
    getLogger().info(`performDetachWorkflow end workflow="${workflowId}" upstream="${upstreamWorkflowId}"`, { module: 'kill' });
    requestWorkflowMetadataPublish('detach-workflow');
  }

  const preemptSkipCodes: Record<string, true> = {
    [OrchestratorErrorCode.TASK_NOT_FOUND]: true,
    [OrchestratorErrorCode.TASK_ALREADY_TERMINAL]: true,
    [OrchestratorErrorCode.WORKFLOW_NOT_FOUND]: true,
  };

  async function preemptTaskSubgraph(taskId: string): Promise<void> {
    try {
      await performCancelTask(taskId);
    } catch (err) {
      if (err instanceof CommandError && preemptSkipCodes[err.code] === true) {
        getLogger().info(`preemptTaskSubgraph skipped for "${taskId}": ${err.message}`, { module: 'ipc' });
        return;
      }
      throw err;
    }
  }

  async function preemptWorkflowExecution(workflowId: string): Promise<WorkflowCancelResult> {
    try {
      getLogger().info(`preemptWorkflowExecution begin for "${workflowId}"`, { module: 'ipc' });
      const result = await performCancelWorkflow(workflowId);
      getLogger().info(`preemptWorkflowExecution end for "${workflowId}"`, { module: 'ipc' });
      return result;
    } catch (err) {
      if (err instanceof CommandError && preemptSkipCodes[err.code] === true) {
        getLogger().info(`preemptWorkflowExecution skipped for "${workflowId}": ${err.message}`, { module: 'ipc' });
        return { cancelled: [], runningCancelled: [] };
      }
      throw err;
    }
  }

  async function performSharedApproveTask(
    taskId: string,
    source: 'ui' | 'surface' | 'api',
    scope: 'task' | 'workflow' = 'task',
  ): Promise<{ started: TaskState[] }> {
    const envelope = makeEnvelope('approve', source === 'api' ? 'surface' : source, scope, { taskId });
    return sharedApproveTask(taskId, {
      orchestrator: getOrchestrator(),
      taskExecutor: requireTaskExecutor(),
      approve: async (approvedTaskId) => {
        const result = await getCommandService().approve({ ...envelope, payload: { taskId: approvedTaskId } });
        if (!result.ok) throw new Error(result.error.message);
        return result.data;
      },
      resumeAfterFixApproval: async (approvedTaskId) => {
        const result = await getCommandService().resumeTaskAfterFixApproval({ ...envelope, payload: { taskId: approvedTaskId } });
        if (!result.ok) throw new Error(result.error.message);
        return result.data;
      },
    });
  }

  return {
    logAutoFixDebug,
    scheduleAutoFix,
    executeFixWithAgentMutation,
    assertFatalExecutionCapacity,
    performCancelTask,
    performDeleteTask,
    performCancelWorkflow,
    performDeleteWorkflow,
    performDetachWorkflow,
    preemptTaskSubgraph,
    preemptWorkflowExecution,
    performSharedApproveTask,
  };
}
