import type { TaskState } from './types.js';

/** Plan YAML pivot + experimentVariants: executor never runs familiar on this node — no Claude session to resume. */
export function isExperimentSpawnPivotTask(task: TaskState): boolean {
  const v = task.config.experimentVariants;
  return Boolean(task.config.pivot && v && v.length > 0);
}

export const EXPERIMENT_SPAWN_PIVOT_OPEN_TERMINAL_MESSAGE =
  'This task only spawns experiment branches from the plan (pivot + experimentVariants). It has no Claude session. Open Terminal on an experiment node (…-exp-…) to resume Claude in its worktree.';
