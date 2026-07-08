import type { ExternalDependency } from '@invoker/workflow-core';

export function normalizeExternalDependencies(raw: unknown): ExternalDependency[] {
  if (!Array.isArray(raw)) return [];
  const normalized: ExternalDependency[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const dep = item as Record<string, unknown>;
    if (typeof dep.workflowId !== 'string' || dep.workflowId.trim() === '') continue;
    const taskId = typeof dep.taskId === 'string' && dep.taskId.trim() !== '' ? dep.taskId.trim() : '__merge__';
    const gatePolicy = dep.gatePolicy === 'review_ready' ? 'review_ready' : 'completed';
    normalized.push({
      workflowId: dep.workflowId.trim(),
      taskId,
      requiredStatus: 'completed',
      gatePolicy,
    });
  }
  return normalized;
}

export function mergeExternalDependencySets(existing: ExternalDependency[], incoming: ExternalDependency[]): ExternalDependency[] {
  const byKey = new Map<string, ExternalDependency>();
  for (const dep of [...existing, ...incoming]) {
    const taskId = dep.taskId?.trim() || '__merge__';
    const key = `${dep.workflowId}::${taskId}`;
    const previous = byKey.get(key);
    const gatePolicy =
      previous?.gatePolicy === 'completed' || dep.gatePolicy === 'completed'
        ? 'completed'
        : 'review_ready';
    byKey.set(key, {
      workflowId: dep.workflowId,
      taskId,
      requiredStatus: 'completed',
      gatePolicy,
    });
  }
  return Array.from(byKey.values());
}
