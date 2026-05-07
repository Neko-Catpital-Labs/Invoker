import { describe, expect, it } from 'vitest';
import type { TaskDelta, TaskState } from '../types.js';
import { applyDelta } from '../lib/delta.js';

type DeleteHistoryDataset = {
  tasks: Map<string, TaskState>;
  removeDeltas: TaskDelta[];
  workflowCount: number;
  taskCount: number;
};

function makeTask(taskId: string, workflowId: string, dependencies: string[]): TaskState {
  return {
    id: taskId,
    description: `Task ${taskId}`,
    status: 'completed',
    dependencies,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: {
      workflowId,
      parentTask: dependencies[0],
    },
    execution: {
      completedAt: new Date('2026-01-01T00:01:00.000Z'),
      branch: `feature/${taskId}`,
      commit: 'deadbeef',
    },
  };
}

function buildDeleteHistoryDataset(workflowCount: number, tasksPerWorkflow: number): DeleteHistoryDataset {
  const tasks = new Map<string, TaskState>();
  const removeDeltas: TaskDelta[] = [];
  let previousWorkflowMergeId: string | undefined;

  for (let workflowIndex = 0; workflowIndex < workflowCount; workflowIndex += 1) {
    const workflowId = `wf-${String(workflowIndex + 1).padStart(3, '0')}`;
    let previousTaskId: string | undefined = previousWorkflowMergeId;

    for (let taskIndex = 0; taskIndex < tasksPerWorkflow; taskIndex += 1) {
      const taskId = `${workflowId}/task-${String(taskIndex + 1).padStart(3, '0')}`;
      const dependencies = previousTaskId ? [previousTaskId] : [];
      tasks.set(taskId, makeTask(taskId, workflowId, dependencies));
      previousTaskId = taskId;
    }

    const mergeId = `__merge__${workflowId}`;
    tasks.set(
      mergeId,
      makeTask(
        mergeId,
        workflowId,
        previousTaskId ? [previousTaskId] : [],
      ),
    );
    previousWorkflowMergeId = mergeId;
  }

  for (const taskId of tasks.keys()) {
    removeDeltas.push({ type: 'removed', taskId });
  }

  return {
    tasks,
    removeDeltas,
    workflowCount,
    taskCount: tasks.size,
  };
}

function applyDeleteBatchUsingCurrentPath(
  initialTasks: Map<string, TaskState>,
  removeDeltas: TaskDelta[],
): { finalTasks: Map<string, TaskState>; mapCopyWork: number } {
  let next = initialTasks;
  let mapCopyWork = 0;

  for (const delta of removeDeltas) {
    // `applyDelta` starts with `new Map(tasks)`, so this is the amount of
    // map entries copied on this iteration.
    mapCopyWork += next.size;
    next = applyDelta(next, delta);
  }

  return { finalTasks: next, mapCopyWork };
}

function applyDeleteBatchWithSingleCopy(
  initialTasks: Map<string, TaskState>,
  removeDeltas: TaskDelta[],
): { finalTasks: Map<string, TaskState>; mapCopyWork: number } {
  const next = new Map(initialTasks);
  for (const delta of removeDeltas) {
    if (delta.type === 'removed') {
      next.delete(delta.taskId);
    }
  }
  return {
    finalTasks: next,
    mapCopyWork: initialTasks.size,
  };
}

describe('delete workflow history repro (ui delta path)', () => {
  it('reproduces high-cost remove batch with 50 stacked workflows and 250+ nodes', () => {
    const dataset = buildDeleteHistoryDataset(50, 5);
    expect(dataset.workflowCount).toBe(50);
    expect(dataset.taskCount).toBeGreaterThanOrEqual(250);

    const current = applyDeleteBatchUsingCurrentPath(dataset.tasks, dataset.removeDeltas);
    const optimized = applyDeleteBatchWithSingleCopy(dataset.tasks, dataset.removeDeltas);

    expect(current.finalTasks.size).toBe(0);
    expect(optimized.finalTasks.size).toBe(0);

    // For N removals, current path does N map clones and copies
    // N + (N - 1) + ... + 1 entries.
    const expectedQuadraticCopies = (dataset.taskCount * (dataset.taskCount + 1)) / 2;
    expect(current.mapCopyWork).toBe(expectedQuadraticCopies);

    // Root-cause proof: we do ~N/2 more map-copy work than a single-copy batch path.
    const workMultiplier = current.mapCopyWork / optimized.mapCopyWork;
    console.info(
      `[delete-history-repro] workflows=${dataset.workflowCount} tasks=${dataset.taskCount} ` +
      `currentMapCopyWork=${current.mapCopyWork} optimizedMapCopyWork=${optimized.mapCopyWork} ` +
      `workMultiplier=${workMultiplier.toFixed(2)}x`,
    );
    expect(workMultiplier).toBeGreaterThan(100);
  });
});
