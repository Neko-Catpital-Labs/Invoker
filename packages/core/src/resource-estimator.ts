/**
 * Config-driven utilization estimator for task scheduling.
 *
 * Resolves a task's utilization (0-100 or UTILIZATION_MAX) using:
 *   1. Per-task config.utilization (set in plan YAML)
 *   2. Pattern rules from ~/.invoker/config.json or <repo>/.invoker.json
 *   3. Built-in defaults (merge/reconciliation = 0, else = defaultUtilization)
 */

import type { TaskState } from '@invoker/graph';
import { UTILIZATION_MAX } from '@invoker/graph';

export { UTILIZATION_MAX };

export interface UtilizationRule {
  pattern: string;
  utilization: number;
}

export class ResourceEstimator {
  private readonly rules: UtilizationRule[];
  private readonly defaultUtilization: number;

  constructor(rules: UtilizationRule[] = [], defaultUtilization: number = 50) {
    this.rules = rules;
    this.defaultUtilization = defaultUtilization;
  }

  estimateUtilization(task: TaskState): number {
    if (task.config.utilization !== undefined) {
      return task.config.utilization;
    }

    if (task.config.isMergeNode || task.config.isReconciliation) {
      return 0;
    }

    const cmd = task.config.command;
    if (cmd) {
      for (const rule of this.rules) {
        if (cmd.includes(rule.pattern)) {
          return rule.utilization;
        }
      }
    }

    return this.defaultUtilization;
  }

  /**
   * Adjust utilization for a specific execution pool.
   * Stub for now -- returns utilization unchanged.
   * Future: remote pools may reduce UTILIZATION_MAX to 0, etc.
   */
  adjustForPool(utilization: number, _poolId: string): number {
    return utilization;
  }
}
