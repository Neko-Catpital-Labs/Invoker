/**
 * ResponseHandler — Routes WorkResponse messages to state machine transitions.
 *
 * Pure logic: takes a StateMachine and ExperimentManager via DI,
 * returns structured results instead of emitting events.
 */

import type { WorkResponse } from '@invoker/protocol';
import { validateWorkResponse } from '@invoker/protocol';
import type { TaskStateMachine } from './state-machine.js';
import type { ExperimentManager } from './experiments.js';
import type { TaskDelta, SideEffect } from './task-types.js';

// ── Types ───────────────────────────────────────────────────

export interface HandleResponseResult {
  success: boolean;
  error?: string;
  readyTasks?: string[];
  blockedTasks?: string[];
  deltas?: TaskDelta[];
}

export interface ResponseHandlerDeps {
  stateMachine: TaskStateMachine;
  experimentManager: ExperimentManager;
}

// ── Handler ─────────────────────────────────────────────────

export class ResponseHandler {
  private stateMachine: TaskStateMachine;
  private experimentManager: ExperimentManager;

  constructor(deps: ResponseHandlerDeps) {
    this.stateMachine = deps.stateMachine;
    this.experimentManager = deps.experimentManager;
  }

  /**
   * Handle a WorkResponse from an executor.
   * Routes to the correct handler based on response status.
   */
  handleResponse(response: WorkResponse): HandleResponseResult {
    const validation = validateWorkResponse(response);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    const { actionId, status, outputs, dagMutation } = response;

    switch (status) {
      case 'completed':
        return this.handleCompleted(actionId, outputs);

      case 'failed':
        return this.handleFailed(actionId, outputs);

      case 'needs_input':
        return this.handleNeedsInput(actionId, outputs);

      case 'spawn_experiments':
        if (!dagMutation?.spawnExperiments) {
          return { success: false, error: 'spawn_experiments requires dagMutation.spawnExperiments' };
        }
        return this.handleSpawnExperiments(actionId, dagMutation.spawnExperiments);

      case 'select_experiment':
        if (!dagMutation?.selectExperiment) {
          return { success: false, error: 'select_experiment requires dagMutation.selectExperiment' };
        }
        return this.handleSelectExperiment(actionId, dagMutation.selectExperiment.experimentId);

      default:
        return { success: false, error: `Unknown response status: ${status}` };
    }
  }

  private handleCompleted(
    actionId: string,
    outputs: WorkResponse['outputs'],
  ): HandleResponseResult {
    const result = this.stateMachine.completeTask(actionId, outputs.exitCode ?? 0, outputs.summary, outputs.commitHash, outputs.claudeSessionId);
    if ('error' in result) {
      return { success: false, error: result.error };
    }

    const readyTasks = this.extractReadyTasks(result.sideEffects);
    return {
      success: true,
      readyTasks,
      deltas: [result.delta],
    };
  }

  private handleFailed(
    actionId: string,
    outputs: WorkResponse['outputs'],
  ): HandleResponseResult {
    const result = this.stateMachine.failTask(actionId, outputs.exitCode ?? 1, outputs.error);
    if ('error' in result) {
      return { success: false, error: result.error };
    }

    const blockedTasks = this.extractBlockedTasks(result.sideEffects);
    return {
      success: true,
      blockedTasks,
      deltas: [result.delta],
    };
  }

  private handleNeedsInput(
    actionId: string,
    outputs: WorkResponse['outputs'],
  ): HandleResponseResult {
    const prompt = outputs.summary ?? 'Task requires input';
    const result = this.stateMachine.pauseForInput(actionId, prompt);
    if ('error' in result) {
      return { success: false, error: result.error };
    }

    return {
      success: true,
      deltas: [result.delta],
    };
  }

  private handleSpawnExperiments(
    actionId: string,
    spawnRequest: NonNullable<WorkResponse['dagMutation']>['spawnExperiments'],
  ): HandleResponseResult {
    if (!spawnRequest) {
      return { success: false, error: 'No spawn request' };
    }

    const task = this.stateMachine.getTask(actionId);
    if (!task) {
      return { success: false, error: `Task ${actionId} not found` };
    }

    const variants = spawnRequest.variants.map((v) => ({
      id: `${actionId}-exp-${v.id}`,
      description: v.description ?? `Experiment: ${v.id}`,
      prompt: v.prompt,
      command: v.command,
    }));

    const groupResult = this.experimentManager.createExperimentGroup(
      actionId,
      variants,
      this.stateMachine,
      task.isReconciliation ? (task.experimentResults as any[]) : undefined,
    );

    // Complete the parent task if it's still running
    if (task.status === 'running') {
      const completeResult = this.stateMachine.completeTask(actionId, 0);
      if (!('error' in completeResult)) {
        groupResult.deltas.unshift(completeResult.delta);
      }
    }

    return {
      success: true,
      readyTasks: groupResult.experiments
        .filter((e) => e.status === 'pending')
        .map((e) => e.id),
      deltas: groupResult.deltas,
    };
  }

  private handleSelectExperiment(
    actionId: string,
    experimentId: string,
  ): HandleResponseResult {
    const result = this.stateMachine.completeReconciliation(actionId, experimentId);
    if ('error' in result) {
      return { success: false, error: result.error };
    }

    const readyTasks = this.extractReadyTasks(result.sideEffects);
    return {
      success: true,
      readyTasks,
      deltas: [result.delta],
    };
  }

  // ── Helpers ─────────────────────────────────────────────

  private extractReadyTasks(effects: readonly SideEffect[]): string[] {
    const ready: string[] = [];
    for (const e of effects) {
      if (e.type === 'tasks_ready') {
        ready.push(...e.taskIds);
      }
    }
    return ready;
  }

  private extractBlockedTasks(effects: readonly SideEffect[]): string[] {
    const blocked: string[] = [];
    for (const e of effects) {
      if (e.type === 'tasks_blocked') {
        blocked.push(...e.taskIds);
      }
    }
    return blocked;
  }
}
