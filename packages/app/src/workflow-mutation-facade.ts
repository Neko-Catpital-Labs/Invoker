/**
 * WorkflowMutationFacade — Single entry point for mutation + dispatch + topup.
 *
 * Each entrypoint (api-server, headless, main) duplicates the same
 * post-mutation lifecycle:
 *
 *   1. Call a shared action (workflow-actions.ts)
 *   2. Filter runnable tasks from `started`
 *   3. Execute runnable tasks via taskExecutor
 *   4. Run global topup to fill scheduler capacity
 *
 * This facade encapsulates that lifecycle. Callers invoke a single
 * method and receive a structured result. The facade does NOT own
 * request parsing, error mapping, or response formatting — those
 * remain in the entrypoint layer.
 */

import type { Logger } from '@invoker/contracts';
import { makeEnvelope } from '@invoker/contracts';
import { OrchestratorError, OrchestratorErrorCode } from '@invoker/workflow-core';
import type { CommandService, Orchestrator, ExternalGatePolicyUpdate, TaskState } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { TaskRunner } from '@invoker/execution-engine';
import {
  approveTask as sharedApproveTask,
  rejectTask as sharedRejectTask,
  provideInput as sharedProvideInput,
  retryTask as sharedRetryTask,
  retryWorkflow as sharedRetryWorkflow,
  recreateWorkflow as sharedRecreateWorkflow,
  recreateTask as sharedRecreateTask,
  recreateDownstream as sharedRecreateDownstream,
  recreateWorkflowFromFreshBase as sharedRecreateWorkflowFromFreshBase,
  rebaseRetry as sharedRebaseRetry,
  rebaseRecreate as sharedRebaseRecreate,
  resolveWorkflowIdForRebaseTarget,
  cancelWorkflow as sharedCancelWorkflow,
  forkWorkflow as sharedForkWorkflow,
  editTaskCommand as sharedEditTaskCommand,
  editTaskPrompt as sharedEditTaskPrompt,
  editTaskType as sharedEditTaskType,
  editTaskAgent as sharedEditTaskAgent,
  setTaskExternalGatePolicies as sharedSetTaskExternalGatePolicies,
  setWorkflowExternalGatePolicies as sharedSetWorkflowExternalGatePolicies,
  setWorkflowMergeMode as sharedSetWorkflowMergeMode,
  selectExperiment as sharedSelectExperiment,
  selectExperiments as sharedSelectExperiments,
  resolveConflictAction as sharedResolveConflictAction,
  fixWithAgentAction as sharedFixWithAgentAction,
  deleteAllWorkflows as sharedDeleteAllWorkflows,
  type FailureRecoveryRoute,
  type FixWithAgentActionResult,
  type ActionDeps,
} from './workflow-actions.js';
import {
  dispatchStartedTasksWithGlobalTopup,
  executeGlobalTopup,
  isDispatchableLaunch,
  type LaunchOutboxMode,
} from './global-topup.js';
import {
  setTaskMetadata as sharedSetTaskMetadata,
  setWorkflowMetadata as sharedSetWorkflowMetadata,
  type MetadataSetResult,
} from './metadata-setter.js';

// ── Result types ─────────────────────────────────────────────

export interface MutationResult {
  started: TaskState[];
  /** Mutation-primary runnable tasks after facade scope filtering. */
  runnable: TaskState[];
  topup: TaskState[];
}

export interface ApproveMutationResult extends MutationResult {
  approvedTask?: TaskState;
  fixedTask: boolean;
}

export interface CancelMutationResult {
  cancelled: string[];
  runningCancelled: string[];
  topup: TaskState[];
}

export interface ForkMutationResult extends MutationResult {
  forkedWorkflowId: string;
  sourceWorkflowId: string;
}

export interface DeleteAllResult {
  snapshotPath: string | null;
}

export interface FixMutationResult extends MutationResult {
  detail: FixWithAgentActionResult;
}

export interface ResolveConflictMutationResult extends MutationResult {
  autoApproved: boolean;
}

type DispatchScope = {
  scopedWorkflowId?: string;
  scopedTaskIds?: string[];
};

// ── Facade deps ──────────────────────────────────────────────

export interface WorkflowMutationFacadeDeps {
  logger?: Logger;
  orchestrator: Orchestrator;
  persistence: SQLiteAdapter;
  commandService?: CommandService;
  taskExecutor: TaskRunner;
  dispatchMode?: 'await' | 'fire-and-forget';
  launchOutboxMode?: LaunchOutboxMode;
  autoApproveAIFixes?: boolean;
  /** Optional pre-kill hook for active task executions. */
  killRunningTask?: (taskId: string) => Promise<void>;
}

// ── Facade ───────────────────────────────────────────────────

/**
 * Encapsulates the "mutate → filter runnable → execute → topup"
 * lifecycle shared by all entrypoints.
 */
export class WorkflowMutationFacade {
  constructor(private readonly deps: WorkflowMutationFacadeDeps) {}

  // ── Task-scoped mutations ────────────────────────────────

  async approveTask(taskId: string): Promise<ApproveMutationResult> {
    const { orchestrator, taskExecutor } = this.deps;
    const result = await sharedApproveTask(taskId, { orchestrator, taskExecutor });
    const { runnable, topup } = await this.dispatchWithTopup(
      result.started,
      'facade.approve-task',
      { scopedTaskIds: [taskId] },
    );
    return {
      approvedTask: result.approvedTask,
      fixedTask: result.fixedTask,
      started: result.started,
      runnable,
      topup,
    };
  }

  rejectTask(taskId: string, reason?: string): void {
    sharedRejectTask(taskId, { orchestrator: this.deps.orchestrator }, reason);
  }

  provideInput(taskId: string, text: string): void {
    sharedProvideInput(taskId, text, { orchestrator: this.deps.orchestrator });
  }

  async retryTask(taskId: string): Promise<MutationResult> {
    const started = await this.runViaCommandService(
      'task',
      taskId,
      (cs) => cs.retryTask(makeEnvelope('facade.retry-task', 'surface', 'task', { taskId })),
      () => sharedRetryTask(taskId, { orchestrator: this.deps.orchestrator }),
    );
    return this.finalizeWithTopup(started, 'facade.retry-task', { scopedTaskIds: [taskId] });
  }

  async recreateTask(taskId: string): Promise<MutationResult> {
    const started = await this.runViaCommandService(
      'task',
      taskId,
      (cs) => cs.recreateTask(makeEnvelope('facade.recreate-task', 'surface', 'task', { taskId })),
      () => sharedRecreateTask(taskId, {
        orchestrator: this.deps.orchestrator,
        persistence: this.deps.persistence,
      }),
    );
    return this.finalizeWithTopup(started, 'facade.recreate-task', { scopedTaskIds: [taskId] });
  }

  async recreateDownstream(taskId: string): Promise<MutationResult> {
    const started = await this.runViaCommandService(
      'task',
      taskId,
      (cs) => cs.recreateDownstream(makeEnvelope('facade.recreate-downstream', 'surface', 'task', { taskId })),
      () => sharedRecreateDownstream(taskId, { orchestrator: this.deps.orchestrator }),
    );
    // `started` contains only descendants (the target is preserved), so a
    // [taskId] dispatch scope would filter every launch out.
    const scopedTaskIds = started.map((task) => task.id);
    return this.finalizeWithTopup(started, 'facade.recreate-downstream', { scopedTaskIds });
  }

  async selectExperiment(taskId: string, experimentId: string): Promise<MutationResult> {
    const started = sharedSelectExperiment(taskId, experimentId, {
      orchestrator: this.deps.orchestrator,
    });
    return this.finalizeWithTopup(started, 'facade.select-experiment', { scopedTaskIds: [taskId] });
  }

  async selectExperiments(taskId: string, experimentIds: string[]): Promise<MutationResult> {
    const started = await sharedSelectExperiments(taskId, experimentIds, {
      orchestrator: this.deps.orchestrator,
      taskExecutor: this.deps.taskExecutor,
    });
    return this.finalizeWithTopup(started, 'facade.select-experiments', { scopedTaskIds: [taskId] });
  }

  async editTaskCommand(taskId: string, newCommand: string): Promise<MutationResult> {
    const started = sharedEditTaskCommand(taskId, newCommand, {
      orchestrator: this.deps.orchestrator,
    });
    return this.finalizeWithTopup(started, 'facade.edit-task-command', { scopedTaskIds: [taskId] });
  }

  async editTaskPrompt(taskId: string, newPrompt: string): Promise<MutationResult> {
    const started = sharedEditTaskPrompt(taskId, newPrompt, {
      orchestrator: this.deps.orchestrator,
    });
    return this.finalizeWithTopup(started, 'facade.edit-task-prompt', { scopedTaskIds: [taskId] });
  }

  async editTaskType(
    taskId: string,
    runnerKind: string,
    poolMemberId?: string,
  ): Promise<MutationResult> {
    const started = sharedEditTaskType(
      taskId,
      runnerKind,
      { orchestrator: this.deps.orchestrator },
      poolMemberId,
    );
    return this.finalizeWithTopup(started, 'facade.edit-task-type', { scopedTaskIds: [taskId] });
  }

  async editTaskAgent(taskId: string, agentName: string): Promise<MutationResult> {
    const started = sharedEditTaskAgent(taskId, agentName, {
      orchestrator: this.deps.orchestrator,
    });
    return this.finalizeWithTopup(started, 'facade.edit-task-agent', { scopedTaskIds: [taskId] });
  }

  async setTaskExternalGatePolicies(
    taskId: string,
    updates: ExternalGatePolicyUpdate[],
  ): Promise<MutationResult> {
    const started = sharedSetTaskExternalGatePolicies(taskId, updates, {
      orchestrator: this.deps.orchestrator,
    });
    return this.finalizeWithTopup(started, 'facade.set-gate-policy', { scopedTaskIds: [taskId] });
  }

  async setWorkflowExternalGatePolicies(
    workflowId: string,
    updates: ExternalGatePolicyUpdate[],
  ): Promise<MutationResult> {
    const started = sharedSetWorkflowExternalGatePolicies(workflowId, updates, {
      orchestrator: this.deps.orchestrator,
    });
    return this.finalizeWithTopup(started, 'facade.set-workflow-gate-policy', { scopedWorkflowId: workflowId });
  }

  async setTaskMetadata(
    taskId: string,
    fieldPath: string,
    value: unknown,
    options: { raw?: boolean } = {},
  ): Promise<MetadataSetResult> {
    if (!this.deps.commandService) throw new Error('Metadata updates require CommandService serialization.');
    return sharedSetTaskMetadata({
      commandService: this.deps.commandService,
      orchestrator: this.deps.orchestrator,
      persistence: this.deps.persistence,
    }, taskId, fieldPath, value, options);
  }

  async cancelTask(taskId: string): Promise<CancelMutationResult> {
    const result = this.deps.orchestrator.cancelTask(taskId);
    if (this.deps.killRunningTask) {
      for (const id of result.runningCancelled) {
        await this.deps.killRunningTask(id);
      }
    }
    const topup = await this.topupOnly('facade.cancel-task');
    return { ...result, topup };
  }

  // ── Workflow-scoped mutations ────────────────────────────

  async retryWorkflow(workflowId: string): Promise<MutationResult> {
    const started = await this.runViaCommandService(
      'workflow',
      workflowId,
      (cs) => cs.retryWorkflow(makeEnvelope('facade.retry-workflow', 'surface', 'workflow', { workflowId })),
      () => sharedRetryWorkflow(workflowId, { orchestrator: this.deps.orchestrator }),
    );
    return this.finalizeWithTopup(started, 'facade.retry-workflow', { scopedWorkflowId: workflowId });
  }

  async recreateWorkflow(workflowId: string): Promise<MutationResult> {
    const started = await this.runViaCommandService(
      'workflow',
      workflowId,
      (cs) => cs.recreateWorkflow(makeEnvelope('facade.recreate-workflow', 'surface', 'workflow', { workflowId })),
      () => sharedRecreateWorkflow(workflowId, {
        logger: this.deps.logger,
        persistence: this.deps.persistence,
        orchestrator: this.deps.orchestrator,
      }),
    );
    return this.finalizeWithTopup(started, 'facade.recreate-workflow', { scopedWorkflowId: workflowId });
  }

  async recreateWorkflowFromFreshBase(workflowId: string): Promise<MutationResult> {
    const started = await sharedRecreateWorkflowFromFreshBase(workflowId, this.actionDeps());
    return this.finalizeWithTopup(started, 'facade.recreate-from-fresh-base', { scopedWorkflowId: workflowId });
  }

  async rebaseRetry(target: string): Promise<MutationResult> {
    const workflowId = resolveWorkflowIdForRebaseTarget(target, this.actionDeps());
    const started = await sharedRebaseRetry(target, this.actionDeps());
    return this.finalizeWithTopup(started, 'facade.rebase-retry', { scopedWorkflowId: workflowId });
  }

  async rebaseRecreate(target: string): Promise<MutationResult> {
    const workflowId = resolveWorkflowIdForRebaseTarget(target, this.actionDeps());
    const started = await sharedRebaseRecreate(target, this.actionDeps());
    return this.finalizeWithTopup(started, 'facade.rebase-recreate', { scopedWorkflowId: workflowId });
  }

  async cancelWorkflow(workflowId: string): Promise<CancelMutationResult> {
    const result = sharedCancelWorkflow(workflowId, {
      orchestrator: this.deps.orchestrator,
    });
    if (this.deps.killRunningTask) {
      for (const id of result.runningCancelled) {
        await this.deps.killRunningTask(id);
      }
    }
    const topup = await this.topupOnly('facade.cancel-workflow');
    return { ...result, topup };
  }

  async deleteWorkflow(workflowId: string): Promise<void> {
    // Kill active tasks before delete (process management is outside orchestrator scope)
    if (this.deps.killRunningTask) {
      const allTasks = this.deps.orchestrator.getAllTasks();
      const active = allTasks.filter(
        (t) =>
          t.config.workflowId === workflowId &&
          (t.status === 'running' || t.status === 'fixing_with_ai'),
      );
      for (const task of active) {
        await this.deps.killRunningTask(task.id);
      }
    }
    await this.deps.taskExecutor?.closeWorkflowReview?.(workflowId);
    this.deps.orchestrator.deleteWorkflow(workflowId);
  }

  async deleteAllWorkflows(): Promise<DeleteAllResult> {
    return sharedDeleteAllWorkflows({
      logger: this.deps.logger,
      orchestrator: this.deps.orchestrator,
      taskExecutor: this.deps.taskExecutor,
    });
  }

  async detachWorkflow(workflowId: string, upstreamWorkflowId: string): Promise<void> {
    this.deps.orchestrator.detachWorkflow(workflowId, upstreamWorkflowId);
  }

  async forkWorkflow(workflowId: string): Promise<ForkMutationResult> {
    const result = sharedForkWorkflow(workflowId, {
      orchestrator: this.deps.orchestrator,
      logger: this.deps.logger,
    });
    const runnable = result.started.filter(isDispatchableLaunch);
    if (this.deps.launchOutboxMode !== 'active') {
      await this.deps.taskExecutor.executeTasks(runnable);
    }
    const topup = await this.topupOnly('facade.fork-workflow');
    return {
      forkedWorkflowId: result.forkedWorkflowId,
      sourceWorkflowId: result.sourceWorkflowId,
      started: result.started,
      runnable,
      topup,
    };
  }

  async setWorkflowMergeMode(workflowId: string, mergeMode: string): Promise<void> {
    await sharedSetWorkflowMergeMode(workflowId, mergeMode, {
      orchestrator: this.deps.orchestrator,
      persistence: this.deps.persistence,
      taskExecutor: this.deps.taskExecutor,
    });
  }

  async setWorkflowMetadata(
    workflowId: string,
    fieldPath: string,
    value: unknown,
    options: { raw?: boolean } = {},
  ): Promise<MetadataSetResult> {
    if (!this.deps.commandService) throw new Error('Metadata updates require CommandService serialization.');
    return sharedSetWorkflowMetadata({
      commandService: this.deps.commandService,
      orchestrator: this.deps.orchestrator,
      persistence: this.deps.persistence,
    }, workflowId, fieldPath, value, options);
  }

  // ── AI-driven mutations ──────────────────────────────────

  async resolveConflict(
    taskId: string,
    agentName?: string,
  ): Promise<ResolveConflictMutationResult> {
    const result = await sharedResolveConflictAction(
      taskId,
      {
        orchestrator: this.deps.orchestrator,
        persistence: this.deps.persistence,
        taskExecutor: this.deps.taskExecutor,
        autoApproveAIFixes: this.deps.autoApproveAIFixes,
      },
      agentName,
    );
    const { runnable, topup } = await this.dispatchWithTopup(
      result.started,
      'facade.resolve-conflict',
      { scopedTaskIds: [taskId] },
    );
    return {
      autoApproved: result.autoApproved,
      started: result.started,
      runnable,
      topup,
    };
  }

  async fixWithAgent(
    taskId: string,
    options: {
      agentName?: string;
      recoveryRoute?: FailureRecoveryRoute;
      recreateOutputLabel?: string;
      failureOutputLabel?: string;
    } = {},
  ): Promise<FixMutationResult> {
    const detail = await sharedFixWithAgentAction(
      taskId,
      {
        orchestrator: this.deps.orchestrator,
        persistence: this.deps.persistence,
        taskExecutor: this.deps.taskExecutor,
        autoApproveAIFixes: this.deps.autoApproveAIFixes,
      },
      options,
    );
    const started =
      detail.kind === 'recreateWorkflowFromFreshBase'
        ? detail.started
        : detail.started;
    const { runnable, topup } = await this.dispatchWithTopup(
      started,
      'facade.fix-with-agent',
      detail.kind === 'recreateWorkflowFromFreshBase'
        ? { scopedWorkflowId: detail.workflowId }
        : { scopedTaskIds: [taskId] },
    );
    return { detail, started, runnable, topup };
  }

  // ── Internal helpers ─────────────────────────────────────

  private actionDeps(): ActionDeps {
    return {
      logger: this.deps.logger,
      orchestrator: this.deps.orchestrator,
      persistence: this.deps.persistence,
      taskExecutor: this.deps.taskExecutor,
      autoApproveAIFixes: this.deps.autoApproveAIFixes,
    };
  }

  private async dispatchWithTopup(
    started: TaskState[],
    context: string,
    scope: DispatchScope = {},
  ): Promise<{ runnable: TaskState[]; topup: TaskState[] }> {
    this.assertSingleDispatchScope(scope);
    return dispatchStartedTasksWithGlobalTopup({
      orchestrator: this.deps.orchestrator,
      taskExecutor: this.deps.taskExecutor,
      logger: this.deps.logger,
      context,
      started,
      dispatchMode: this.deps.dispatchMode,
      launchOutboxMode: this.deps.launchOutboxMode,
      ...scope,
    });
  }

  private async finalizeWithTopup(
    started: TaskState[],
    context: string,
    scope: DispatchScope = {},
  ): Promise<MutationResult> {
    const { runnable, topup } = await this.dispatchWithTopup(started, context, scope);
    return { started, runnable, topup };
  }

  /**
   * Route through the production CommandService when available so the
   * mutation gets mutex serialization, executor kill on cancel-in-flight,
   * and the cross-workflow cascade. Falls back to the shared action when
   * no CommandService is wired (legacy entrypoints / tests).
   */
  private async runViaCommandService(
    _scope: 'task' | 'workflow',
    _id: string,
    routed: (cs: CommandService) => Promise<{ ok: true; data: TaskState[] } | { ok: false; error: { code: string; message: string } }>,
    fallback: () => TaskState[] | Promise<TaskState[]>,
  ): Promise<TaskState[]> {
    if (this.deps.commandService) {
      const result = await routed(this.deps.commandService);
      if (!result.ok) {
        // Surface OrchestratorError when CommandService bubbles a known
        // domain code (e.g. WORKFLOW_NOT_FOUND -> HTTP 404). Plain Error
        // is the fallback for unmapped codes.
        const known = (Object.values(OrchestratorErrorCode) as string[]).includes(result.error.code);
        if (known) {
          throw new OrchestratorError(result.error.code as OrchestratorErrorCode, result.error.message);
        }
        throw new Error(result.error.message);
      }
      return result.data;
    }
    return Promise.resolve(fallback());
  }

  private assertSingleDispatchScope(scope: DispatchScope): void {
    if (scope.scopedWorkflowId && scope.scopedTaskIds?.length) {
      throw new Error('WorkflowMutationFacade dispatch scope cannot be both workflow-scoped and task-scoped.');
    }
  }

  private async topupOnly(context: string): Promise<TaskState[]> {
    return executeGlobalTopup({
      orchestrator: this.deps.orchestrator,
      taskExecutor: this.deps.taskExecutor,
      logger: this.deps.logger,
      context,
      dispatchMode: this.deps.dispatchMode,
      launchOutboxMode: this.deps.launchOutboxMode,
    });
  }
}
