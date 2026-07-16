/**
 * plan-summary — Distill a YAML plan into a short, ordered, human summary.
 *
 * Parses an Invoker plan YAML, validates its shape, orders the tasks in
 * execution order (topological sort over `dependencies`), and renders one
 * short step line per task. Never throws: invalid input returns null.
 */

import { parse as parseYaml } from 'yaml';

// ── Types ───────────────────────────────────────────────────

export interface PlanSummaryTaskGroup {
  workflow: string | null;
  tasks: string[];
}

export interface PlanSummary {
  name: string;
  steps: string[];
  taskCount: number;
  workflowCount?: number;
  taskGroups: PlanSummaryTaskGroup[];
}

interface PlanTask {
  id: string;
  description: string;
  dependencies: string[];
}

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

  const rawWorkflows = parsed.workflows;
  if (Array.isArray(rawWorkflows)) {
    if (rawWorkflows.length === 0) return null;
    const workflowNames: string[] = [];
    const taskGroups: PlanSummaryTaskGroup[] = [];
    let taskCount = 0;
    for (const rawWorkflow of rawWorkflows) {
      if (!isRecord(rawWorkflow)) return null;
      const workflowName = rawWorkflow.name;
      if (typeof workflowName !== 'string' || workflowName.trim().length === 0) return null;
      const workflowTasks = parseTasks(rawWorkflow.tasks);
      if (!workflowTasks) return null;
      const label = summarizeDescription(workflowName);
      workflowNames.push(label);
      taskGroups.push({
        workflow: label,
        tasks: topoSort(workflowTasks).map((t) => summarizeDescription(t.description)),
      });
      taskCount += workflowTasks.length;
    }
    return { name, steps: workflowNames, taskCount, workflowCount: rawWorkflows.length, taskGroups };
  }

  const tasks = parseTasks(parsed.tasks);
  if (!tasks) return null;

  const ordered = topoSort(tasks);
  const steps = ordered.map((t) => summarizeDescription(t.description));

  return { name, steps, taskCount: tasks.length, taskGroups: [{ workflow: null, tasks: steps }] };
}

/**
 * Deterministic per-task summary lines, grouped by workflow. This is the single
 * source of truth for the plan summary the user reads on every surface, so a
 * cut-off or verbose planner reply can never change what tasks are shown.
 */
export function formatPlanSummaryLines(summary: PlanSummary): string[] {
  const lines: string[] = [];
  const flat = summary.taskGroups.length === 1 && summary.taskGroups[0].workflow === null;
  for (const group of summary.taskGroups) {
    if (group.workflow && !flat) lines.push(group.workflow);
    for (const task of group.tasks) {
      lines.push(flat ? `• ${task}` : `   • ${task}`);
    }
  }
  return lines;
}

// ── Internals ───────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTasks(rawTasks: unknown): PlanTask[] | null {
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

  return tasks;
}

/**
 * Kahn's algorithm — stable topological sort preserving original listed order
 * when several tasks are ready. Falls back to the original order on a cycle or
 * an unknown dependency id.
 */
function topoSort(tasks: PlanTask[]): PlanTask[] {
  const byId = new Map<string, PlanTask>();
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const t of tasks) {
    byId.set(t.id, t);
    indegree.set(t.id, 0);
    outgoing.set(t.id, []);
  }

  for (const t of tasks) {
    for (const dep of t.dependencies) {
      if (!byId.has(dep)) {
        return tasks; // unknown dep: preserve listed order
      }
      indegree.set(t.id, (indegree.get(t.id) ?? 0) + 1);
      outgoing.get(dep)!.push(t.id);
    }
  }

  const queue: string[] = tasks.filter((t) => (indegree.get(t.id) ?? 0) === 0).map((t) => t.id);
  const ordered: PlanTask[] = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    const task = byId.get(id)!;
    ordered.push(task);

    for (const nextId of outgoing.get(id) ?? []) {
      const next = (indegree.get(nextId) ?? 0) - 1;
      indegree.set(nextId, next);
      if (next === 0) queue.push(nextId);
    }
  }

  if (ordered.length !== tasks.length) {
    return tasks; // cycle: preserve listed order
  }

  return ordered;
}

function summarizeDescription(description: string): string {
  return description.replace(/\s+/g, ' ').trim();
}
