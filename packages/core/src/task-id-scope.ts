/**
 * Workflow-scoped task ids — plan-local ids become globally unique at runtime.
 *
 * Format: `${workflowId}/${planLocalId}`. Merge nodes keep `__merge__${workflowId}` and are not passed through here.
 */

export function scopePlanTaskId(workflowId: string, planLocalId: string): string {
  if (planLocalId.startsWith('__merge__')) {
    return planLocalId;
  }
  return `${workflowId}/${planLocalId}`;
}

export function buildPlanLocalToScopedIdMap(
  workflowId: string,
  planTasks: ReadonlyArray<{ id: string }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const t of planTasks) {
    if (map.has(t.id)) {
      throw new Error(`Duplicate task id "${t.id}" in plan`);
    }
    map.set(t.id, scopePlanTaskId(workflowId, t.id));
  }
  return map;
}
