import type { Orchestrator, TaskState } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';
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
import { autoFixOnReviewGateFailure } from '../workflow-actions.js';

export type TaskHandleMap = Map<string, { handle: ExecutorHandle; executor: Executor }>;

export interface TaskRunnerWiringDeps {
  orchestrator: Orchestrator;
  persistence: SQLiteAdapter;
  executorRegistry: ExecutorRegistry;
  executionAgentRegistry?: AgentRegistry;
  repoRoot: string;
  invokerConfig: InvokerConfig;
  logger: Logger;
  taskHandles: TaskHandleMap;
  enqueueTaskOutput: (taskId: string, data: string) => void;
  flushTaskOutput: (taskId: string) => void;
  assertFatalExecutionCapacity: (label: string) => void;
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

const STARTUP_DIAGNOSTIC_TAIL_CHARS = 4_000;

function compactDiagnosticValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= STARTUP_DIAGNOSTIC_TAIL_CHARS) return trimmed;
  return `...${trimmed.slice(trimmed.length - STARTUP_DIAGNOSTIC_TAIL_CHARS)}`;
}

function startupFailureDetail(error: Error, key: 'stderr' | 'stdout'): string | undefined {
  const direct = compactDiagnosticValue((error as unknown as Record<string, unknown>)[key]);
  if (direct) return direct;
  const cause = error.cause as Record<string, unknown> | undefined;
  return compactDiagnosticValue(cause?.[key]);
}

function appendStartupFailureDiagnostic(
  taskId: string,
  error: Error,
  executor: Executor,
  persistence: SQLiteAdapter,
): void {
  const parts = [
    '\n[Startup Diagnostic]',
    `executor=${executor.type}`,
    `message=${error.message}`,
  ];
  const stderr = startupFailureDetail(error, 'stderr');
  const stdout = startupFailureDetail(error, 'stdout');
  if (stderr) parts.push(`--- startup stderr ---\n${stderr}`);
  if (stdout) parts.push(`--- startup stdout ---\n${stdout}`);
  parts.push('--- end startup diagnostic ---\n');
  persistence.appendTaskOutput(taskId, parts.join('\n'));
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
    onReviewGateCiFailure: deps.invokerConfig.autoFixCi
      ? async (trigger) => {
          const currentTaskExecutor = deps.getTaskRunner();
          if (!currentTaskExecutor) {
            throw new Error('Task executor is not initialized for review-gate CI auto-fix');
          }
          await autoFixOnReviewGateFailure(trigger, {
            orchestrator: deps.orchestrator,
            persistence: deps.persistence,
            taskExecutor: currentTaskExecutor,
            getAutoFixAgent: () => loadConfig().autoFixAgent,
            getAutoApproveAIFixes: () => loadConfig().autoApproveAIFixes,
          });
        }
      : undefined,
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
        try {
          appendStartupFailureDiagnostic(taskId, error, executor, deps.persistence);
        } catch {
          // Best-effort: preserve the original startup failure flow.
        }
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
