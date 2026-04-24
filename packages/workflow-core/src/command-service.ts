/**
 * CommandService — Mutex-serialized orchestrator mutations.
 *
 * All orchestrator-level mutations flow through this service so that
 * concurrent mutations never interleave (promise-chain mutex).
 */

import type { CommandEnvelope, CommandResult } from '@invoker/contracts';
import type { Orchestrator, ExternalGatePolicyUpdate, TaskReplacementDef } from './orchestrator.js';
import type { TaskState } from '@invoker/workflow-graph';

// ── Cancel Result ────────────────────────────────────────────

export type CancelResult = { cancelled: string[]; runningCancelled: string[] };

// ── CommandService ──────────────────────────────────────────

export class CommandService {
  private readonly orchestrator: Orchestrator;

  // Promise-chain mutexes: workflow-local by default, global fallback when no workflow can be resolved.
  private readonly workflowMutexTails = new Map<string, Promise<void>>();
  private globalMutexTail: Promise<void> = Promise.resolve();

  constructor(orchestrator: Orchestrator) {
    this.orchestrator = orchestrator;
  }

  // ── Mutex ────────────────────────────────────────────────

  private async serializeGlobal<T>(fn: () => T | Promise<T>): Promise<T> {
    const prev = this.globalMutexTail;
    let release!: () => void;
    this.globalMutexTail = new Promise<void>(r => { release = r; });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async serializeForWorkflow<T>(
    workflowId: string | undefined,
    fn: () => T | Promise<T>,
  ): Promise<T> {
    if (!workflowId) {
      return this.serializeGlobal(fn);
    }
    const prev = this.workflowMutexTails.get(workflowId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.workflowMutexTails.set(workflowId, current);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.workflowMutexTails.get(workflowId) === current) {
        this.workflowMutexTails.delete(workflowId);
      }
    }
  }

  private workflowIdForTask(taskId: string): string | undefined {
    return this.orchestrator.getTask(taskId)?.config?.workflowId;
  }

  // ── Public Commands ─────────────────────────────────────

  async approve(
    envelope: CommandEnvelope<{ taskId: string }>,
  ): Promise<CommandResult<TaskState[]>> {
    return this.executeCommand<TaskState[]>(
      'APPROVE_FAILED',
      () => this.orchestrator.approve(envelope.payload.taskId),
      this.workflowIdForTask(envelope.payload.taskId),
    );
  }

  async resumeTaskAfterFixApproval(
    envelope: CommandEnvelope<{ taskId: string }>,
  ): Promise<CommandResult<TaskState[]>> {
    return this.executeCommand<TaskState[]>(
      'APPROVE_FAILED',
      () => this.orchestrator.resumeTaskAfterFixApproval(envelope.payload.taskId),
      this.workflowIdForTask(envelope.payload.taskId),
    );
  }

  async reject(
    envelope: CommandEnvelope<{ taskId: string; reason?: string }>,
  ): Promise<CommandResult<void>> {
    return this.executeCommand<void>(
      'REJECT_FAILED',
      () => {
        const task = this.orchestrator.getTask(envelope.payload.taskId);
        if (task?.execution.pendingFixError !== undefined) {
          this.orchestrator.revertConflictResolution(
            envelope.payload.taskId,
            task.execution.pendingFixError,
          );
        } else {
          this.orchestrator.reject(
            envelope.payload.taskId,
            envelope.payload.reason,
          );
        }
      },
      this.workflowIdForTask(envelope.payload.taskId),
    );
  }

  async provideInput(
    envelope: CommandEnvelope<{ taskId: string; input: string }>,
  ): Promise<CommandResult<void>> {
    return this.executeCommand<void>(
      'PROVIDE_INPUT_FAILED',
      () => this.orchestrator.provideInput(envelope.payload.taskId, envelope.payload.input),
      this.workflowIdForTask(envelope.payload.taskId),
    );
  }

  async restartTask(
    envelope: CommandEnvelope<{ taskId: string }>,
  ): Promise<CommandResult<TaskState[]>> {
    return this.executeCommand<TaskState[]>(
      'RESTART_TASK_FAILED',
      () => this.orchestrator.restartTask(envelope.payload.taskId),
      this.workflowIdForTask(envelope.payload.taskId),
    );
  }

  async selectExperiment(
    envelope: CommandEnvelope<{ taskId: string; experimentId: string }>,
  ): Promise<CommandResult<TaskState[]>> {
    return this.executeCommand<TaskState[]>(
      'SELECT_EXPERIMENT_FAILED',
      () => this.orchestrator.selectExperiment(envelope.payload.taskId, envelope.payload.experimentId),
      this.workflowIdForTask(envelope.payload.taskId),
    );
  }

  async editTaskCommand(
    envelope: CommandEnvelope<{ taskId: string; newCommand: string }>,
  ): Promise<CommandResult<TaskState[]>> {
    return this.executeCommand<TaskState[]>(
      'EDIT_TASK_COMMAND_FAILED',
      () => this.orchestrator.editTaskCommand(envelope.payload.taskId, envelope.payload.newCommand),
      this.workflowIdForTask(envelope.payload.taskId),
    );
  }

    async editTaskPrompt(
    envelope: CommandEnvelope<{ taskId: string; newPrompt: string }>,
  ): Promise<CommandResult<TaskState[]>> {
    return this.executeCommand<TaskState[]>(
      'EDIT_TASK_PROMPT_FAILED',
      () => this.orchestrator.editTaskPrompt(envelope.payload.taskId, envelope.payload.newPrompt),
      this.workflowIdForTask(envelope.payload.taskId),
    );
  }

    async editTaskType(
    envelope: CommandEnvelope<{ taskId: string; executorType: string; remoteTargetId?: string }>,
  ): Promise<CommandResult<TaskState[]>> {
    return this.executeCommand<TaskState[]>(
      'EDIT_TASK_TYPE_FAILED',
      () => this.orchestrator.editTaskType(
        envelope.payload.taskId,
        envelope.payload.executorType,
        envelope.payload.remoteTargetId,
      ),
      this.workflowIdForTask(envelope.payload.taskId),
    );
  }

    async editTaskAgent(
    envelope: CommandEnvelope<{ taskId: string; agentName: string }>,
  ): Promise<CommandResult<TaskState[]>> {
    return this.executeCommand<TaskState[]>(
      'EDIT_TASK_AGENT_FAILED',
      () => this.orchestrator.editTaskAgent(envelope.payload.taskId, envelope.payload.agentName),
      this.workflowIdForTask(envelope.payload.taskId),
    );
  }

  /**
   * Edit the merge mode of a workflow's merge node — **retry-class**
   * invalidation route per Step 9 of the task-invalidation roadmap
   * (chart Decision Table row "Change merge mode";
   * `MUTATION_POLICIES.mergeMode` → `retryTask` / task scope, scoped
   * to the merge node). Mirrors the Step 5/7/8 retry-class seams
   * (`editTaskType` / `selectExperiment` / `selectExperiments`) rather
   * than the recreate-class `editTaskCommand` / `editTaskPrompt` /
   * `editTaskAgent` seams: a merge-mode flip changes the merge
   * execution policy but preserves the merge node's branch /
   * workspacePath lineage.
   *
   * The orchestrator method (`Orchestrator.editTaskMergeMode`) is the
   * synchronous cancel-first seam — it owns same-mode no-op detection,
   * cancel-first interruption when the merge node is active
   * (`running` / `fixing_with_ai` / `awaiting_approval` /
   * `review_ready`), the `persistence.updateWorkflow({ mergeMode })`
   * write, and the `restartTask` retry-class reset that bumps the
   * merge node's execution generation exactly once. This service-level
   * entrypoint just serializes the mutation through the workflow mutex
   * so concurrent merge-mode flips never interleave with each other or
   * with other in-workflow mutations, then wraps the result in a
   * `CommandResult`. `taskId` MUST be the merge node id
   * (`__merge__<workflowId>`); the workflow id is read from the merge
   * node's config.
   */
  async editTaskMergeMode(
    envelope: CommandEnvelope<{
      taskId: string;
      mergeMode: 'manual' | 'automatic' | 'external_review';
    }>,
  ): Promise<CommandResult<TaskState[]>> {
    return this.executeCommand<TaskState[]>(
      'EDIT_TASK_MERGE_MODE_FAILED',
      () => this.orchestrator.editTaskMergeMode(
        envelope.payload.taskId,
        envelope.payload.mergeMode,
      ),
      this.workflowIdForTask(envelope.payload.taskId),
    );
  }

  /**
   * Edit a task's fix-session prompt and/or context — **retry-class**
   * invalidation route per Step 10 of the task-invalidation roadmap
   * (chart Decision Table row "Change fix prompt or fix context while
   * `fixing_with_ai`"; `MUTATION_POLICIES.fixContext` → `retryTask` /
   * task scope, scoped to the failed/fixing task). Mirrors the Step
   * 5/7/8/9 retry-class seams (`editTaskType` / `selectExperiment` /
   * `selectExperiments` / `editTaskMergeMode`) rather than the
   * recreate-class `editTaskCommand` / `editTaskPrompt` /
   * `editTaskAgent` seams: a fix prompt/context edit redirects the
   * AI fix attempt without changing the task's execution-defining
   * spec, so the failed task's branch / workspacePath lineage is
   * preserved.
   *
   * The orchestrator method (`Orchestrator.editTaskFixContext`) is
   * the synchronous cancel-first seam — it owns same-content no-op
   * detection, cancel-first interruption when the task is actively
   * running an AI fix (`fixing_with_ai`), the
   * `config.fixPrompt` / `config.fixContext` write, and the
   * `restartTask` retry-class reset that bumps the task's execution
   * generation exactly once and clears volatile fix-attempt state
   * (`agentSessionId`, `containerId`, transient
   * `error`/`exitCode`/timing fields). This service-level entrypoint
   * just serializes the mutation through the workflow mutex so
   * concurrent fix-context edits never interleave with each other or
   * with other in-workflow mutations, then wraps the result in a
   * `CommandResult`.
   *
   * Patch shape: `{ fixPrompt?, fixContext? }`. Either or both keys
   * may be present in `envelope.payload`. The orchestrator method
   * treats omitted keys as "no change" so callers can tweak only one
   * of the two fields without re-supplying the other.
   */
  async editTaskFixContext(
    envelope: CommandEnvelope<{
      taskId: string;
      fixPrompt?: string;
      fixContext?: string;
    }>,
  ): Promise<CommandResult<TaskState[]>> {
    return this.executeCommand<TaskState[]>(
      'EDIT_TASK_FIX_CONTEXT_FAILED',
      () => this.orchestrator.editTaskFixContext(
        envelope.payload.taskId,
        {
          ...('fixPrompt' in envelope.payload
            ? { fixPrompt: envelope.payload.fixPrompt }
            : {}),
          ...('fixContext' in envelope.payload
            ? { fixContext: envelope.payload.fixContext }
            : {}),
        },
      ),
      this.workflowIdForTask(envelope.payload.taskId),
    );
  }
  async setTaskExternalGatePolicies(
    envelope: CommandEnvelope<{ taskId: string; updates: ExternalGatePolicyUpdate[] }>,
  ): Promise<CommandResult<TaskState[]>> {
    return this.executeCommand<TaskState[]>(
      'SET_GATE_POLICIES_FAILED',
      () => this.orchestrator.setTaskExternalGatePolicies(
        envelope.payload.taskId,
        envelope.payload.updates,
      ),
      this.workflowIdForTask(envelope.payload.taskId),
    );
  }

  async replaceTask(
    envelope: CommandEnvelope<{ taskId: string; replacementTasks: TaskReplacementDef[] }>,
  ): Promise<CommandResult<TaskState[]>> {
    return this.executeCommand<TaskState[]>(
      'REPLACE_TASK_FAILED',
      () => this.orchestrator.replaceTask(
        envelope.payload.taskId,
        envelope.payload.replacementTasks,
      ),
      this.workflowIdForTask(envelope.payload.taskId),
    );
  }

  async cancelTask(
    envelope: CommandEnvelope<{ taskId: string }>,
  ): Promise<CommandResult<CancelResult>> {
    return this.executeCommand<CancelResult>(
      'CANCEL_TASK_FAILED',
      () => this.orchestrator.cancelTask(envelope.payload.taskId),
      this.workflowIdForTask(envelope.payload.taskId),
    );
  }

  async cancelWorkflow(
    envelope: CommandEnvelope<{ workflowId: string }>,
  ): Promise<CommandResult<CancelResult>> {
    return this.executeCommand<CancelResult>(
      'CANCEL_WORKFLOW_FAILED',
      () => this.orchestrator.cancelWorkflow(envelope.payload.workflowId),
      envelope.payload.workflowId,
    );
  }

  async deleteWorkflow(
    envelope: CommandEnvelope<{ workflowId: string }>,
  ): Promise<CommandResult<void>> {
    return this.executeCommand<void>(
      'DELETE_WORKFLOW_FAILED',
      () => this.orchestrator.deleteWorkflow(envelope.payload.workflowId),
      envelope.payload.workflowId,
    );
  }

  async retryWorkflow(
    envelope: CommandEnvelope<{ workflowId: string }>,
  ): Promise<CommandResult<TaskState[]>> {
    return this.executeCommand<TaskState[]>(
      'RETRY_WORKFLOW_FAILED',
      () => this.orchestrator.retryWorkflow(envelope.payload.workflowId),
      envelope.payload.workflowId,
    );
  }

  // ── Private Helpers ────────────────────────────────────

  private async executeCommand<T>(
    errorCode: string,
    fn: () => T | Promise<T>,
    workflowId?: string,
  ): Promise<CommandResult<T>> {
    try {
      const data = await this.serializeForWorkflow(workflowId, fn);
      return { ok: true, data };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: errorCode,
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
}
