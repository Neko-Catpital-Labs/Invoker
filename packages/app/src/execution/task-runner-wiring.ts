import type { Orchestrator } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';
import {
  GitHubMergeGateProvider,
  ReviewProviderRegistry,
  TaskRunner,
  type AgentRegistry,
  type Executor,
  type ExecutorHandle,
  type ExecutorRegistry,
  type TaskRunnerConfig,
} from '@invoker/execution-engine';
import type { WorkResponse } from '@invoker/contracts';

export interface TaskRunnerWiringOptions {
  orchestrator: Orchestrator;
  persistence: SQLiteAdapter;
  executorRegistry: ExecutorRegistry;
  executionAgentRegistry: AgentRegistry;
  cwd: string;
  defaultBranch?: string;
  dockerConfig: {
    imageName?: string;
    secretsFile?: string;
  };
  remoteTargetsProvider: NonNullable<TaskRunnerConfig['remoteTargetsProvider']>;
  executionPoolsProvider: NonNullable<TaskRunnerConfig['executionPoolsProvider']>;
  callbacks: {
    onOutput(taskId: string, data: string): void;
    onLaunchAccepted(taskId: string): void;
    onLaunchStart(taskId: string, executor: Executor): void;
    onLaunchFailed(taskId: string, error: Error, executor: Executor): void;
    onSpawned(taskId: string, handle: ExecutorHandle, executor: Executor): void;
    onComplete(taskId: string, response: WorkResponse): void;
    onHeartbeat(taskId: string): void;
    onLaunchSettled(taskId: string): void;
  };
}

export function createTaskRunner(options: TaskRunnerWiringOptions): TaskRunner {
  const taskRunner = new TaskRunner({
    orchestrator: options.orchestrator,
    persistence: options.persistence,
    executorRegistry: options.executorRegistry,
    executionAgentRegistry: options.executionAgentRegistry,
    cwd: options.cwd,
    defaultBranch: options.defaultBranch,
    dockerConfig: options.dockerConfig,
    remoteTargetsProvider: options.remoteTargetsProvider,
    executionPoolsProvider: options.executionPoolsProvider,
    mergeGateProvider: new GitHubMergeGateProvider(),
    reviewProviderRegistry: createReviewProviderRegistry(),
    callbacks: options.callbacks,
  });

  wireApproveHook({
    orchestrator: options.orchestrator,
    persistence: options.persistence,
    getTaskRunner: () => taskRunner,
  });

  return taskRunner;
}

function createReviewProviderRegistry(): ReviewProviderRegistry {
  const registry = new ReviewProviderRegistry();
  registry.register(new GitHubMergeGateProvider());
  return registry;
}

interface ApproveHookOptions {
  orchestrator: Orchestrator;
  persistence: SQLiteAdapter;
  getTaskRunner(): TaskRunner;
}

function wireApproveHook(options: ApproveHookOptions): void {
  options.orchestrator.setBeforeApproveHook(async (task) => {
    if (task.config.isMergeNode && task.config.workflowId && task.execution.pendingFixError === undefined) {
      const workflow = options.persistence.loadWorkflow(task.config.workflowId);
      if (workflow?.mergeMode === 'external_review') return;
      await options.getTaskRunner().approveMerge(task.config.workflowId);
    }
  });
}
