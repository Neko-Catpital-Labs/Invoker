import type { TaskState } from './task-types.js';

export function resolveReconciliationExperiment(
  recon: TaskState,
  experimentId: string,
  getTask: (id: string) => TaskState | undefined,
): TaskState | undefined {
  const direct = getTask(experimentId);
  if (direct) return direct;

  for (const depId of recon.dependencies) {
    const dep = getTask(depId);
    if (!dep) continue;
    if (dep.config.variantLocalId === experimentId) return dep;
  }
  return undefined;
}
