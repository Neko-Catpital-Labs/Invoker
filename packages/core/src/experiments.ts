/**
 * ExperimentManager — Pure logic for experiment lifecycle.
 *
 * Manages experiment groups: pivot tasks spawn N experiments,
 * a reconciliation task is created to collect results,
 * and downstream tasks are rewired to depend on reconciliation.
 *
 * No EventEmitter, no I/O. Returns structured results.
 */

import { TaskStateMachine, CreateResult } from './state-machine.js';
import type {
  TaskState,
  TaskDelta,
  ExperimentResultEntry,
} from './task-types.js';

// ── Types ───────────────────────────────────────────────────

export interface ExperimentGroup {
  parentTaskId: string;
  reconciliationTaskId: string;
  experimentIds: string[];
  completedExperiments: Map<string, ExperimentResultEntry>;
}

export interface ExperimentVariantInput {
  id: string;
  description: string;
  prompt?: string;
  command?: string;
}

export interface CreateExperimentGroupResult {
  experiments: TaskState[];
  reconciliationTask: TaskState;
  deltas: TaskDelta[];
  group: ExperimentGroup;
}

export interface ExperimentCompletedResult {
  allDone: boolean;
  reconciliationTriggered: boolean;
  group: ExperimentGroup;
}

// ── Manager ─────────────────────────────────────────────────

export class ExperimentManager {
  private groups: Map<string, ExperimentGroup> = new Map();

  /**
   * Create an experiment group from a pivot task.
   *
   * 1. Creates N experiment tasks (depend on parentTaskId)
   * 2. Creates 1 reconciliation task (depends on all experiments)
   * 3. Rewires downstream tasks: depend on reconciliation instead of pivot
   */
  createExperimentGroup(
    parentTaskId: string,
    variants: ExperimentVariantInput[],
    stateMachine: TaskStateMachine,
    previousResults?: ExperimentResultEntry[],
  ): CreateExperimentGroupResult {
    const deltas: TaskDelta[] = [];
    const experimentIds = variants.map((v) => v.id);

    // Unique reconciliation ID
    const suffix = previousResults ? `-${Date.now()}` : '';
    const reconciliationTaskId = `${parentTaskId}-reconciliation${suffix}`;

    // Inherit repoUrl and familiarType from the parent task
    const parentTask = stateMachine.getTask(parentTaskId);
    const inheritedRepoUrl = parentTask?.repoUrl;
    const inheritedFamiliarType = parentTask?.familiarType;

    // Create experiment tasks
    const experiments: TaskState[] = [];
    for (const variant of variants) {
      const { task, delta } = stateMachine.createTask(
        variant.id,
        variant.description,
        [parentTaskId],
        {
          parentTask: parentTaskId,
          experimentPrompt: variant.prompt,
          prompt: variant.prompt,
          command: variant.command,
          repoUrl: inheritedRepoUrl,
          familiarType: inheritedFamiliarType,
        },
      );
      experiments.push(task);
      deltas.push(delta);
    }

    // Create reconciliation task (depends on new experiments)
    const { task: reconTask, delta: reconDelta } = stateMachine.createTask(
      reconciliationTaskId,
      `Review and select winning experiment for ${parentTaskId}`,
      experimentIds,
      {
        parentTask: parentTaskId,
        isReconciliation: true,
        requiresManualApproval: true,
      },
    );
    deltas.push(reconDelta);

    // Rewire downstream tasks: replace parentTaskId with reconciliationTaskId
    const rewriteDeltas = stateMachine.rewriteDependency(parentTaskId, reconciliationTaskId);
    deltas.push(...rewriteDeltas);

    // Track group
    const allExperimentIds = [
      ...(previousResults?.map((r) => r.id) ?? []),
      ...experimentIds,
    ];

    const group: ExperimentGroup = {
      parentTaskId,
      reconciliationTaskId,
      experimentIds: allExperimentIds,
      completedExperiments: new Map(),
    };

    // Pre-populate with previous results
    if (previousResults) {
      for (const r of previousResults) {
        group.completedExperiments.set(r.id, r);
      }
    }

    this.groups.set(reconciliationTaskId, group);

    return {
      experiments,
      reconciliationTask: reconTask,
      deltas,
      group,
    };
  }

  /**
   * Record an experiment completion. Returns whether all experiments
   * are done and whether reconciliation should be triggered.
   */
  onExperimentCompleted(
    experimentId: string,
    result: ExperimentResultEntry,
  ): ExperimentCompletedResult | null {
    for (const [, group] of this.groups) {
      if (!group.experimentIds.includes(experimentId)) continue;

      group.completedExperiments.set(experimentId, result);

      const allDone = group.completedExperiments.size === group.experimentIds.length;

      return {
        allDone,
        reconciliationTriggered: allDone,
        group,
      };
    }

    return null; // Not part of any experiment group
  }

  /**
   * Get an experiment group by reconciliation task ID.
   */
  getGroup(reconciliationTaskId: string): ExperimentGroup | undefined {
    return this.groups.get(reconciliationTaskId);
  }

  /**
   * Get all experiment groups.
   */
  getAllGroups(): ExperimentGroup[] {
    return Array.from(this.groups.values());
  }

  /**
   * Clear all groups.
   */
  clear(): void {
    this.groups.clear();
  }
}
