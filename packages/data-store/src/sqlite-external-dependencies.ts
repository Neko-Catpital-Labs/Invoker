import type { ExternalDependency, ExternalGatePolicy } from '@invoker/workflow-core';

function normalizeGatePolicy(value: unknown, fallback: ExternalGatePolicy): ExternalGatePolicy {
  if (value === 'completed' || value === 'review_ready' || value === 'ci_failed') return value;
  return fallback;
}

export function normalizeExternalDependencies(raw: unknown): ExternalDependency[] {
  if (!Array.isArray(raw)) return [];
  const normalized: ExternalDependency[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const dep = item as Record<string, unknown>;
    if (typeof dep.workflowId !== 'string' || dep.workflowId.trim() === '') continue;
    const taskId = typeof dep.taskId === 'string' && dep.taskId.trim() !== '' ? dep.taskId.trim() : '__merge__';
    const gatePolicy = normalizeGatePolicy(dep.gatePolicy, 'completed');
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
    const depGatePolicy = dep.gatePolicy === undefined ? undefined : normalizeGatePolicy(dep.gatePolicy, 'review_ready');
    const gatePolicy =
      previous?.gatePolicy === 'completed' || depGatePolicy === 'completed'
        ? 'completed'
        : depGatePolicy ?? previous?.gatePolicy ?? 'review_ready';
    byKey.set(key, {
      workflowId: dep.workflowId,
      taskId,
      requiredStatus: 'completed',
      gatePolicy,
    });
  }
  return Array.from(byKey.values());
}
