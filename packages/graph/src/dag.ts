/**
 * Pure DAG operations for task dependency graphs.
 *
 * No I/O, no side effects, no EventEmitter.
 * All functions take immutable data and return new values.
 */

import type { TaskState } from './types.js';

// ── topologicalSort ──────────────────────────────────────────

/**
 * Returns tasks in dependency order using Kahn's algorithm.
 * Throws if the graph contains a cycle.
 */
export function topologicalSort(tasks: TaskState[]): TaskState[] {
  if (tasks.length === 0) return [];

  const taskMap = new Map<string, TaskState>();
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const task of tasks) {
    taskMap.set(task.id, task);
    inDegree.set(task.id, 0);
    adjacency.set(task.id, []);
  }

  // Build edges: for each dependency, add an edge from dep -> task
  for (const task of tasks) {
    for (const dep of task.dependencies) {
      if (taskMap.has(dep)) {
        adjacency.get(dep)!.push(task.id);
        inDegree.set(task.id, inDegree.get(task.id)! + 1);
      }
    }
  }

  // Seed queue with zero in-degree nodes
  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) {
      queue.push(id);
    }
  }

  const sorted: TaskState[] = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    sorted.push(taskMap.get(id)!);

    for (const neighbor of adjacency.get(id)!) {
      const newDegree = inDegree.get(neighbor)! - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  if (sorted.length !== tasks.length) {
    throw new Error(
      `Cycle detected in task graph. ${tasks.length - sorted.length} task(s) involved in cycle.`,
    );
  }

  return sorted;
}

// ── getTransitiveDependents ──────────────────────────────────

/**
 * BFS to find all downstream tasks that transitively depend on taskId.
 * Returns an array of task IDs (not including taskId itself).
 */
export function getTransitiveDependents(
  taskId: string,
  taskMap: ReadonlyMap<string, TaskState>,
  skipPredicate?: (task: TaskState) => boolean,
): string[] {
  // Build reverse adjacency: for each task, which tasks depend on it?
  const reverseDeps = new Map<string, string[]>();
  for (const [id] of taskMap) {
    reverseDeps.set(id, []);
  }
  for (const [id, task] of taskMap) {
    for (const dep of task.dependencies) {
      if (reverseDeps.has(dep)) {
        reverseDeps.get(dep)!.push(id);
      }
    }
  }

  // BFS from taskId
  const visited = new Set<string>();
  const queue: string[] = [];

  const directDependents = reverseDeps.get(taskId) ?? [];
  for (const dep of directDependents) {
    if (!visited.has(dep)) {
      const task = taskMap.get(dep);
      if (task && skipPredicate?.(task)) continue;
      visited.add(dep);
      queue.push(dep);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbors = reverseDeps.get(current) ?? [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        const task = taskMap.get(neighbor);
        if (task && skipPredicate?.(task)) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  return [...visited];
}

// ── validateDAG ──────────────────────────────────────────────

/**
 * Detects cycles and missing dependency references.
 * Returns { valid, errors } without throwing.
 */
export function validateDAG(tasks: TaskState[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const knownIds = new Set(tasks.map((t) => t.id));

  // Check for missing dependency references
  for (const task of tasks) {
    for (const dep of task.dependencies) {
      if (!knownIds.has(dep)) {
        errors.push(
          `Task "${task.id}" depends on "${dep}" which does not exist.`,
        );
      }
    }
  }

  // Check for cycles using Kahn's algorithm
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const task of tasks) {
    inDegree.set(task.id, 0);
    adjacency.set(task.id, []);
  }

  for (const task of tasks) {
    for (const dep of task.dependencies) {
      if (knownIds.has(dep)) {
        adjacency.get(dep)!.push(task.id);
        inDegree.set(task.id, inDegree.get(task.id)! + 1);
      }
    }
  }

  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) {
      queue.push(id);
    }
  }

  let processed = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    processed++;
    for (const neighbor of adjacency.get(id)!) {
      const newDegree = inDegree.get(neighbor)! - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  if (processed < tasks.length) {
    const cycleNodes = tasks
      .filter((t) => inDegree.get(t.id)! > 0)
      .map((t) => t.id);
    errors.push(
      `Cycle detected involving task(s): ${cycleNodes.join(', ')}.`,
    );
  }

  return { valid: errors.length === 0, errors };
}

// ── computeLevels ────────────────────────────────────────────

/**
 * Assigns a depth level to each task.
 * Tasks with no dependencies are level 0.
 * A task's level = max(levels of dependencies) + 1.
 *
 * Assumes a valid DAG (no cycles). Use validateDAG first if unsure.
 */
export function computeLevels(tasks: TaskState[]): Map<string, number> {
  const levels = new Map<string, number>();

  if (tasks.length === 0) return levels;

  // Use topological order to process dependencies before dependents
  const sorted = topologicalSort(tasks);
  for (const task of sorted) {
    if (task.dependencies.length === 0) {
      levels.set(task.id, 0);
    } else {
      let maxDepLevel = -1;
      for (const dep of task.dependencies) {
        const depLevel = levels.get(dep);
        if (depLevel !== undefined && depLevel > maxDepLevel) {
          maxDepLevel = depLevel;
        }
      }
      levels.set(task.id, maxDepLevel + 1);
    }
  }

  return levels;
}

// ── nextVersion ──────────────────────────────────────────────

/**
 * Compute the next version suffix for a task ID.
 * 'task-a' → 'task-a-v2', 'task-a-v2' → 'task-a-v3', etc.
 */
export function nextVersion(taskId: string): string {
  const match = taskId.match(/-v(\d+)$/);
  if (match) {
    const num = parseInt(match[1], 10);
    return taskId.replace(/-v\d+$/, `-v${num + 1}`);
  }
  return `${taskId}-v2`;
}

// ── findLeafTaskIds ──────────────────────────────────────────

/**
 * Returns IDs of leaf tasks — tasks that no other task depends on.
 * Operates on whatever task set is passed in (caller is responsible
 * for pre-filtering by workflow, status, etc.).
 */
export function findLeafTaskIds(tasks: TaskState[]): string[] {
  const dependedOn = new Set<string>();
  for (const task of tasks) {
    for (const dep of task.dependencies) dependedOn.add(dep);
  }
  return tasks.filter((t) => !dependedOn.has(t.id)).map((t) => t.id);
}

// ── getReadyTasks ────────────────────────────────────────────

/**
 * Returns only pending tasks where all dependencies are completed.
 */
export function getReadyTasks(tasks: TaskState[]): TaskState[] {
  if (tasks.length === 0) return [];

  const statusMap = new Map<string, TaskState['status']>();
  for (const task of tasks) {
    statusMap.set(task.id, task.status);
  }

  return tasks.filter((task) => {
    if (task.status !== 'pending') return false;

    return task.dependencies.every((dep) => statusMap.get(dep) === 'completed');
  });
}
