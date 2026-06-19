import type { Orchestrator, TaskState } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';
import { Channels, type MessageBus } from '@invoker/transport';
import {
  GitHubMergeGateProvider,
  ReviewProviderRegistry,
  TaskRunner,
  type AgentRegistry,
  type Executor,
  type ExecutorHandle,
  type ExecutorRegistry,
} from '@invoker/execution-engine';
import type { Logger } from '@invoker/contracts';
import { loadConfig, resolveSecretsFilePath, type InvokerConfig } from '../config.js';
import { buildReviewGateCiFailedLifecycleEvent } from '../lifecycle-events.js';

export type TaskHandleMap = Map<string, { handle: ExecutorHandle; executor: Executor }>;

export interface TaskRunnerWiringDeps {
  orchestrator: Orchestrator;
  persistence: SQLiteAdapter;
  messageBus: MessageBus;
  executorRegistry: ExecutorRegistry;
  executionAgentRegistry?: AgentRegistry;
  repoRoot: string;
  invokerConfig: InvokerConfig;
  logger: Logger;
  taskHandles: TaskHandleMap;
  enqueueTaskOutput: (taskId: string, data: string) => void;
  flushTaskOutput: (taskId: string) => void;
  assertFatalExecutionCapacity: (label: string) => void;
  wakeLaunchDispatcher?: (reason: string) => void;
  getTaskRunner: () => TaskRunner | null;
  setTaskRunner: (taskRunner: TaskRunner) => void;
  setLatestTaskExecutor: (taskRunner: TaskRunner) => void;
}

export function requireWiredTaskRunner(getTaskRunner: () => TaskRunner | null): TaskRunner {
  const taskRunner = getTaskRunner();
  if (!taskRunner) {
    throw new Error('Mutation execution is unavailable in read-only follower mode');
  }
  return taskRunner;
}

export async function killRunningTaskExecution(deps: Pick<
  TaskRunnerWiringDeps,
  'getTaskRunner' | 'logger' | 'taskHandles'
>, taskId: string): Promise<void> {
  const taskRunner = deps.getTaskRunner();
  const killedByTaskRunner = taskRunner
    ? await taskRunner.killActiveExecution(taskId)
    : false;
  const entry = deps.taskHandles.get(taskId);
  if (!killedByTaskRunner && !entry) return;
  deps.logger.info(`Killing running task "${taskId}" before restart`, { module: 'kill' });
  if (!killedByTaskRunner && entry) {
    try {
      await entry.executor.kill(entry.handle);
    } catch {
      /* process may already have exited */
    }
  }
  deps.taskHandles.delete(taskId);
}

export function wireTaskRunnerApproveHook(deps: Pick<
  TaskRunnerWiringDeps,
  'orchestrator' | 'persistence' | 'getTaskRunner'
>): void {
  deps.orchestrator.setBeforeApproveHook(async (task: TaskState) => {
    if (task.config.isMergeNode && task.config.workflowId && task.execution.pendingFixError === undefined) {
      const workflow = deps.persistence.loadWorkflow(task.config.workflowId);
      if (workflow?.mergeMode === 'external_review') return;
      await requireWiredTaskRunner(deps.getTaskRunner).approveMerge(task.config.workflowId);
    }
  });
}

export function rebuildTaskRunner(deps: TaskRunnerWiringDeps): TaskRunner {
  const taskRunner = new TaskRunner({
    orchestrator: deps.orchestrator,
    persistence: deps.persistence,
    executorRegistry: deps.executorRegistry,
    executionAgentRegistry: deps.executionAgentRegistry,
    cwd: deps.repoRoot,
    defaultBranch: deps.invokerConfig.defaultBranch,
    dockerConfig: {
      imageName: deps.invokerConfig.docker?.imageName,
      secretsFile: resolveSecretsFilePath(deps.invokerConfig),
    },
    remoteTargetsProvider: () => loadConfig().remoteTargets ?? {},
    executionPoolsProvider: () => loadConfig().executionPools ?? {},
    onReviewGateCiFailure: async (trigger) => {
      const task = deps.orchestrator.getTask(trigger.taskId);
      deps.messageBus.publish(Channels.WORKFLOW_LIFECYCLE, buildReviewGateCiFailedLifecycleEvent({
        workflowId: trigger.workflowId,
        taskId: trigger.taskId,
        status: task?.status ?? 'review_ready',
        taskStateVersion: trigger.taskStateVersion ?? task?.taskStateVersion ?? 0,
        reviewId: trigger.reviewId,
        reviewUrl: trigger.reviewUrl,
        headSha: trigger.headSha,
        headRef: trigger.headRef,
        branch: trigger.branch,
        generation: trigger.generation,
        attemptId: trigger.selectedAttemptId,
        failedChecks: trigger.failedChecks,
        statusText: trigger.statusText,
      }));
    },
    mergeGateProvider: new GitHubMergeGateProvider(),
    reviewProviderRegistry: (() => {
      const registry = new ReviewProviderRegistry();
      registry.register(new GitHubMergeGateProvider());
      return registry;
    })(),
    callbacks: {
      onOutput: (taskId, data) => {
        deps.enqueueTaskOutput(taskId, data);
      },
      onLaunchFailed: (taskId, error, executor) => {
        deps.assertFatalExecutionCapacity(`launch failed ${taskId}`);
        deps.logger.error(
          `Task "${taskId}" launch failed before spawn (executor: ${executor.type}): ${error.message}`,
          { module: 'exec' },
        );
      },
      onSpawned: (taskId, handle, executor) => {
        deps.flushTaskOutput(taskId);
        deps.logger.info(
          `Task "${taskId}" spawned (handle: ${handle.executionId}, executor: ${executor.type}, workspace: ${handle.workspacePath ?? 'none'}, branch: ${handle.branch ?? 'none'})`,
          { module: 'exec' },
        );
        deps.taskHandles.set(taskId, { handle, executor });
        deps.assertFatalExecutionCapacity(`spawned ${taskId}`);
      },
      onComplete: (taskId, response) => {
        deps.flushTaskOutput(taskId);
        deps.taskHandles.delete(taskId);
        deps.assertFatalExecutionCapacity(`complete ${taskId}`);
        deps.logger.info(
          `Task "${taskId}" completion callback received (status: ${response.status}, generation: ${response.executionGeneration}, exitCode: ${response.outputs.exitCode ?? 'none'})`,
          { module: 'exec' },
        );
        deps.wakeLaunchDispatcher?.(`complete ${taskId}`);
      },
      onHeartbeat: (taskId, event) => {
        const now = event.at;
        const task = deps.orchestrator.getTask(taskId);
        const previousHeartbeat = task?.execution.lastHeartbeatAt instanceof Date
          ? task.execution.lastHeartbeatAt
          : task?.execution.lastHeartbeatAt
            ? new Date(task.execution.lastHeartbeatAt)
            : undefined;
        const heartbeatGapMs = previousHeartbeat ? now.getTime() - previousHeartbeat.getTime() : undefined;
        deps.orchestrator.recordTaskHeartbeat(taskId, { at: now, source: event.source });
        deps.logger.info(
          `Heartbeat for "${taskId}" (status: ${task?.status ?? 'unknown'}, generation: ${task?.execution.generation ?? 'unknown'}, gapMs: ${heartbeatGapMs ?? 'first'})`,
          { module: 'heartbeat' },
        );
      },
    },
  });
  deps.setTaskRunner(taskRunner);
  deps.setLatestTaskExecutor(taskRunner);
  wireTaskRunnerApproveHook(deps);
  return taskRunner;
}
