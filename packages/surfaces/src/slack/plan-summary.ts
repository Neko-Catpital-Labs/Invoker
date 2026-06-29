/**
 * plan-summary — Distill a YAML plan into a short, ordered, human summary.
 *
 * Parses an Invoker plan YAML, validates its shape, orders the tasks in
 * execution order (topological sort over `dependencies`), and renders one
 * short step line per task. Never throws: invalid input returns null.
 */

import { parse as parseYaml } from 'yaml';

// ── Types ───────────────────────────────────────────────────

export interface PlanSummary {
  name: string;
  steps: string[];
  taskCount: number;
}

interface PlanTask {
  id: string;
  description: string;
  dependencies: string[];
}

const MAX_WORDS = 30;

// ── Public API ──────────────────────────────────────────────

export function summarizePlanText(planText: string): PlanSummary | null {
  let parsed: unknown;
  try {
    parsed = parseYaml(planText);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;

  const name = parsed.name;
  if (typeof name !== 'string' || name.trim().length === 0) return null;

  const rawTasks = parsed.tasks;
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) return null;

  const tasks: PlanTask[] = [];
  for (const raw of rawTasks) {
    if (!isRecord(raw)) return null;
    const id = raw.id;
    const description = raw.description;
    if (typeof id !== 'string' || id.trim().length === 0) return null;
    if (typeof description !== 'string' || description.trim().length === 0) return null;
    const dependencies = Array.isArray(raw.dependencies)
      ? raw.dependencies.filter((d): d is string => typeof d === 'string')
      : [];
    tasks.push({ id, description, dependencies });
  }

  const ordered = topoSort(tasks);
  const steps = ordered.map((t) => summarizeDescription(t.description));

  return { name, steps, taskCount: tasks.length };
}

// ── Internals ───────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Kahn's algorithm — stable topological sort preserving original listed order
 * when several tasks are ready. Falls back to the original order on a cycle or
 * an unknown dependency id.
 */
function topoSort(tasks: PlanTask[]): PlanTask[] {
  const byId = new Map<string, PlanTask>();
  for (const task of tasks) byId.set(task.id, task);

  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    indegree.set(task.id, 0);
    dependents.set(task.id, []);
  }

  for (const task of tasks) {
    for (const dep of task.dependencies) {
      if (!byId.has(dep)) return tasks; // unknown dependency → original order
      indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1);
      dependents.get(dep)!.push(task.id);
    }
  }

  // Ready queue, seeded in original listed order for stability.
  const ready: string[] = [];
  for (const task of tasks) {
    if ((indegree.get(task.id) ?? 0) === 0) ready.push(task.id);
  }

  const result: PlanTask[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    result.push(byId.get(id)!);
    for (const next of dependents.get(id)!) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
  }

  if (result.length !== tasks.length) return tasks; // cycle → original order
  return result;
}

function summarizeDescription(description: string): string {
  const normalized = description.replace(/\s+/g, ' ').trim();
  const words = normalized.split(' ');
  if (words.length <= MAX_WORDS) return normalized;
  return words.slice(0, MAX_WORDS).join(' ') + ' …';
}
