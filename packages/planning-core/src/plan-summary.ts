import { parse as parseYaml } from 'yaml';

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

export function summarizePlanText(planText: string): PlanSummary | null {
  let parsed: unknown;
  try {
    parsed = parseYaml(planText);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.name !== 'string' || !parsed.name.trim()) return null;

  if (Array.isArray(parsed.workflows)) {
    if (!parsed.workflows.length) return null;
    const taskGroups: PlanSummaryTaskGroup[] = [];
    for (const workflow of parsed.workflows) {
      if (!isRecord(workflow) || typeof workflow.name !== 'string' || !workflow.name.trim()) return null;
      const tasks = parseTasks(workflow.tasks);
      if (!tasks) return null;
      taskGroups.push({
        workflow: summarizeDescription(workflow.name),
        tasks: topoSort(tasks).map((task) => task.description.trim()),
      });
    }
    return {
      name: parsed.name,
      steps: taskGroups.map((group) => group.workflow!),
      taskCount: taskGroups.reduce((count, group) => count + group.tasks.length, 0),
      workflowCount: taskGroups.length,
      taskGroups,
    };
  }

  const tasks = parseTasks(parsed.tasks);
  if (!tasks) return null;
  const steps = topoSort(tasks).map((task) => task.description.trim());
  return { name: parsed.name, steps, taskCount: tasks.length, taskGroups: [{ workflow: null, tasks: steps }] };
}

export function formatPlanSummaryLines(summary: PlanSummary): string[] {
  const lines: string[] = [];
  const flat = summary.taskGroups.length === 1 && summary.taskGroups[0].workflow === null;
  for (const group of summary.taskGroups) {
    if (group.workflow && !flat) lines.push(group.workflow);
    for (const task of group.tasks) lines.push(flat ? `• ${task}` : `   • ${task}`);
  }
  return lines;
}

export function formatSlackPlanBrief(summary: PlanSummary): string {
  const slices = dedupe(summary.taskGroups.flatMap((group) => group.tasks)
    .filter((task) => !/\bLayer:\s*app_regression\b|\bGoal:\s*(?:run|verify|build|type-check)\b/i.test(task))
    .map(deliverySlice)
    .filter(Boolean)).slice(0, 6);
  const fallback = summary.steps.map(deliverySlice).filter(Boolean).slice(0, 3);
  const ordered = (slices.length ? slices : fallback).map((slice, index) => `${index + 1}) ${slice}`).join('; ');
  return truncateWords(
    `Drafted *${truncateWords(summary.name, 8)}* (${summary.taskCount} task${summary.taskCount === 1 ? '' : 's'}). Delivery order: ${ordered}. Each slice includes focused verification.`,
    72,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTasks(value: unknown): PlanTask[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const tasks: PlanTask[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id.trim()
      || typeof raw.description !== 'string' || !raw.description.trim()) return null;
    tasks.push({
      id: raw.id,
      description: raw.description,
      dependencies: Array.isArray(raw.dependencies)
        ? raw.dependencies.filter((dependency): dependency is string => typeof dependency === 'string')
        : [],
    });
  }
  return tasks;
}

function topoSort(tasks: PlanTask[]): PlanTask[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const indegree = new Map(tasks.map((task) => [task.id, 0]));
  const outgoing = new Map(tasks.map((task) => [task.id, [] as string[]]));
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!byId.has(dependency)) return tasks;
      indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1);
      outgoing.get(dependency)!.push(task.id);
    }
  }
  const queue = tasks.filter((task) => indegree.get(task.id) === 0).map((task) => task.id);
  const ordered: PlanTask[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    ordered.push(byId.get(id)!);
    for (const next of outgoing.get(id) ?? []) {
      const nextDegree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, nextDegree);
      if (nextDegree === 0) queue.push(next);
    }
  }
  return ordered.length === tasks.length ? ordered : tasks;
}

function summarizeDescription(description: string): string {
  return description.replace(/\s+/g, ' ').trim();
}

function deliverySlice(description: string): string {
  const normalized = summarizeDescription(description);
  const goal = normalized.match(/\bGoal:\s*(.+?)(?=\s+(?:Motivation|Alternative considerations|Implementation details|Acceptance criteria|Non-goals|Layer|Feature state):|$)/i)?.[1]
    ?? normalized.split(/(?<=[.!?])\s+/)[0];
  return truncateWords(goal.replace(/[.:;]+$/, ''), 7);
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function truncateWords(text: string, maxWords: number): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  return words.length <= maxWords ? words.join(' ') : `${words.slice(0, maxWords).join(' ')}…`;
}
