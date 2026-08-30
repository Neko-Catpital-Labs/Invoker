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
    if (depId === experimentId) return dep;
    if (depId.endsWith(`-exp-${experimentId}`)) return dep;
    const slash = depId.lastIndexOf('/');
    const local = slash >= 0 ? depId.slice(slash + 1) : depId;
    if (local === experimentId || local.endsWith(`-exp-${experimentId}`)) {
      return dep;
    }
  }
  return undefined;
}
