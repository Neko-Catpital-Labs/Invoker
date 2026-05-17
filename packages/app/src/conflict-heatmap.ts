import type { TaskState } from '@invoker/workflow-core';

export interface ConflictHeatmapRow {
  file: string;
  count: number;
  workflowIds: string[];
  taskIds: string[];
  latestTaskId: string;
}

export interface ConflictHeatmapWorkflow {
  id: string;
}

export interface ConflictHeatmapPersistence {
  listWorkflows(): ConflictHeatmapWorkflow[];
  loadTasks(workflowId: string): TaskState[];
}

export function buildConflictHeatmap(persistence: ConflictHeatmapPersistence): ConflictHeatmapRow[] {
  const rows = new Map<string, {
    count: number;
    workflowIds: Set<string>;
    taskIds: Set<string>;
    latestTaskId: string;
    latestTime: number;
  }>();

  for (const workflow of persistence.listWorkflows()) {
    for (const task of persistence.loadTasks(workflow.id)) {
      const mergeConflict = task.execution.mergeConflict;
      if (!mergeConflict) continue;

      const completedAt = task.execution.completedAt;
      const startedAt = task.execution.startedAt;
      const timestamp = completedAt instanceof Date
        ? completedAt.getTime()
        : typeof completedAt === 'string'
          ? Date.parse(completedAt)
          : startedAt instanceof Date
            ? startedAt.getTime()
            : typeof startedAt === 'string'
              ? Date.parse(startedAt)
              : task.createdAt instanceof Date
                ? task.createdAt.getTime()
                : Date.parse(String(task.createdAt));
      const effectiveTime = Number.isFinite(timestamp) ? timestamp : 0;

      for (const file of mergeConflict.conflictFiles) {
        const existing = rows.get(file) ?? {
          count: 0,
          workflowIds: new Set<string>(),
          taskIds: new Set<string>(),
          latestTaskId: task.id,
          latestTime: effectiveTime,
        };
        existing.count += 1;
        existing.workflowIds.add(workflow.id);
        existing.taskIds.add(task.id);
        if (effectiveTime >= existing.latestTime) {
          existing.latestTime = effectiveTime;
          existing.latestTaskId = task.id;
        }
        rows.set(file, existing);
      }
    }
  }

  return [...rows.entries()]
    .map(([file, row]) => ({
      file,
      count: row.count,
      workflowIds: [...row.workflowIds].sort(),
      taskIds: [...row.taskIds].sort(),
      latestTaskId: row.latestTaskId,
    }))
    .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
}
