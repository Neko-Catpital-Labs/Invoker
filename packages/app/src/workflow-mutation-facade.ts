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
import type { Orchestrator, ExternalGatePolicyUpdate, TaskState } from '@invoker/workflow-core';
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
  recreateWorkflowFromFreshBase as sharedRecreateWorkflowFromFreshBase,
  recreateWithRebase as sharedRecreateWithRebase,
  rebaseAndRetry as sharedRebaseAndRetry,
  cancelWorkflow as sharedCancelWorkflow,
  forkWorkflow as sharedForkWorkflow,
  editTaskCommand as sharedEditTaskCommand,
  editTaskPrompt as sharedEditTaskPrompt,
  editTaskType as sharedEditTaskType,
  editTaskAgent as sharedEditTaskAgent,
  setTaskExternalGatePolicies as sharedSetTaskExternalGatePolicies,
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
} from './global-topup.js';

// ── Result types ─────────────────────────────────────────────

export interface MutationResult {
  started: TaskState[];
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

// ── Facade deps ──────────────────────────────────────────────

export interface WorkflowMutationFacadeDeps {
  logger?: Logger;
  orchestrator: Orchestrator;
  persistence: SQLiteAdapter;
  taskExecutor: TaskRunner;
  dispatchMode?: 'await' | 'fire-and-forget';
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
    const started = sharedRetryTask(taskId, { orchestrator: this.deps.orchestrator });
    return this.finalizeWithTopup(started, 'facade.retry-task');
  }

  async recreateTask(taskId: string): Promise<MutationResult> {
    const started = sharedRecreateTask(taskId, {
      orchestrator: this.deps.orchestrator,
      persistence: this.deps.persistence,
    });
    return this.finalizeWithTopup(started, 'facade.recreate-task');
  }

  async selectExperiment(taskId: string, experimentId: string): Promise<MutationResult> {
    const started = sharedSelectExperiment(taskId, experimentId, {
      orchestrator: this.deps.orchestrator,
    });
    return this.finalizeWithTopup(started, 'facade.select-experiment');
  }

  async selectExperiments(taskId: string, experimentIds: string[]): Promise<MutationResult> {
    const started = await sharedSelectExperiments(taskId, experimentIds, {
      orchestrator: this.deps.orchestrator,
      taskExecutor: this.deps.taskExecutor,
    });
    return this.finalizeWithTopup(started, 'facade.select-experiments');
  }

  async editTaskCommand(taskId: string, newCommand: string): Promise<MutationResult> {
    const started = sharedEditTaskCommand(taskId, newCommand, {
      orchestrator: this.deps.orchestrator,
    });
    return this.finalizeWithTopup(started, 'facade.edit-task-command');
  }

  async editTaskPrompt(taskId: string, newPrompt: string): Promise<MutationResult> {
    const started = sharedEditTaskPrompt(taskId, newPrompt, {
      orchestrator: this.deps.orchestrator,
    });
    return this.finalizeWithTopup(started, 'facade.edit-task-prompt');
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
    return this.finalizeWithTopup(started, 'facade.edit-task-type');
  }

  async editTaskAgent(taskId: string, agentName: string): Promise<MutationResult> {
    const started = sharedEditTaskAgent(taskId, agentName, {
      orchestrator: this.deps.orchestrator,
    });
    return this.finalizeWithTopup(started, 'facade.edit-task-agent');
  }

  async setTaskExternalGatePolicies(
    taskId: string,
    updates: ExternalGatePolicyUpdate[],
  ): Promise<MutationResult> {
    const started = sharedSetTaskExternalGatePolicies(taskId, updates, {
      orchestrator: this.deps.orchestrator,
    });
    return this.finalizeWithTopup(started, 'facade.set-gate-policy');
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
    const started = sharedRetryWorkflow(workflowId, {
      orchestrator: this.deps.orchestrator,
    });
    return this.finalizeWithTopup(started, 'facade.retry-workflow');
  }

  async recreateWorkflow(workflowId: string): Promise<MutationResult> {
    const started = sharedRecreateWorkflow(workflowId, {
      logger: this.deps.logger,
      persistence: this.deps.persistence,
      orchestrator: this.deps.orchestrator,
    });
    return this.finalizeWithTopup(started, 'facade.recreate-workflow');
  }

  async recreateWorkflowFromFreshBase(workflowId: string): Promise<MutationResult> {
    const started = await sharedRecreateWorkflowFromFreshBase(workflowId, this.actionDeps());
    return this.finalizeWithTopup(started, 'facade.recreate-from-fresh-base');
  }

  async recreateWithRebase(workflowId: string): Promise<MutationResult> {
    const started = await sharedRecreateWithRebase(workflowId, this.actionDeps());
    return this.finalizeWithTopup(started, 'facade.recreate-with-rebase');
  }

  async rebaseAndRetry(taskId: string): Promise<MutationResult> {
    const started = await sharedRebaseAndRetry(taskId, this.actionDeps());
    return this.finalizeWithTopup(started, 'facade.rebase-and-retry');
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
    await this.deps.taskExecutor.executeTasks(runnable);
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
  ): Promise<{ runnable: TaskState[]; topup: TaskState[] }> {
    return dispatchStartedTasksWithGlobalTopup({
      orchestrator: this.deps.orchestrator,
      taskExecutor: this.deps.taskExecutor,
      logger: this.deps.logger,
      context,
      started,
      dispatchMode: this.deps.dispatchMode,
    });
  }

  private async finalizeWithTopup(
    started: TaskState[],
    context: string,
  ): Promise<MutationResult> {
    const { runnable, topup } = await this.dispatchWithTopup(started, context);
    return { started, runnable, topup };
  }

  private async topupOnly(context: string): Promise<TaskState[]> {
    return executeGlobalTopup({
      orchestrator: this.deps.orchestrator,
      taskExecutor: this.deps.taskExecutor,
      logger: this.deps.logger,
      context,
      dispatchMode: this.deps.dispatchMode,
    });
  }
}
