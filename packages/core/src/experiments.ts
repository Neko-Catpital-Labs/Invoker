/**
 * ExperimentManager — Pure logic for experiment lifecycle.
 *
 * Manages experiment groups: pivot tasks spawn N experiments,
 * a reconciliation task is created to collect results,
 * and downstream tasks are rewired to depend on reconciliation.
 *
 * No graph writes, no I/O. Returns structured plans that the
 * Orchestrator executes via DB writes.
 */

import type {
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

export interface PlannedTask {
  id: string;
  description: string;
  dependencies: string[];
  parentTask?: string;
  experimentPrompt?: string;
  prompt?: string;
  command?: string;
  repoUrl?: string;
  familiarType?: string;
  isReconciliation?: boolean;
  requiresManualApproval?: boolean;
}

export interface DependencyRewrite {
  fromDep: string;
  toDep: string;
}

export interface ExperimentGroupPlan {
  experimentTasks: PlannedTask[];
  reconciliationTask: PlannedTask;
  rewrites: DependencyRewrite[];
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
   * Plan an experiment group from a pivot task.
   *
   * Returns task definitions and dependency rewrites — does NOT
   * write to any graph or DB. The Orchestrator is responsible for
   * persisting these via createAndSync / writeAndSync.
   *
   * @param parentTaskId     ID of the completed pivot task
   * @param variants         Experiment variant definitions
   * @param parentRepoUrl    repoUrl inherited from the parent task (optional)
   * @param parentFamiliarType familiarType inherited from the parent task (optional)
   * @param previousResults  Results from earlier experiment rounds (optional)
   */
  planExperimentGroup(
    parentTaskId: string,
    variants: ExperimentVariantInput[],
    parentRepoUrl?: string,
    parentFamiliarType?: string,
    previousResults?: ExperimentResultEntry[],
  ): ExperimentGroupPlan {
    const experimentIds = variants.map((v) => v.id);

    const suffix = previousResults ? `-${Date.now()}` : '';
    const reconciliationTaskId = `${parentTaskId}-reconciliation${suffix}`;

    const experimentTasks: PlannedTask[] = variants.map((v) => ({
      id: v.id,
      description: v.description,
      dependencies: [parentTaskId],
      parentTask: parentTaskId,
      experimentPrompt: v.prompt,
      prompt: v.prompt,
      command: v.command,
      repoUrl: parentRepoUrl,
      familiarType: parentFamiliarType,
    }));

    const reconciliationTask: PlannedTask = {
      id: reconciliationTaskId,
      description: `Review and select winning experiment for ${parentTaskId}`,
      dependencies: experimentIds,
      parentTask: parentTaskId,
      isReconciliation: true,
      requiresManualApproval: true,
    };

    const rewrites: DependencyRewrite[] = [{
      fromDep: parentTaskId,
      toDep: reconciliationTaskId,
    }];

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

    if (previousResults) {
      for (const r of previousResults) {
        group.completedExperiments.set(r.id, r);
      }
    }

    this.groups.set(reconciliationTaskId, group);

    return {
      experimentTasks,
      reconciliationTask,
      rewrites,
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

    return null;
  }

  getGroup(reconciliationTaskId: string): ExperimentGroup | undefined {
    return this.groups.get(reconciliationTaskId);
  }

  getAllGroups(): ExperimentGroup[] {
    return Array.from(this.groups.values());
  }

  clear(): void {
    this.groups.clear();
  }
}
