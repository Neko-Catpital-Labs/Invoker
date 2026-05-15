import type { Workflow } from '@invoker/data-store';
import type { TaskDelta, TaskState } from '@invoker/workflow-core';

export interface WorkflowMetadataInvalidatorDeps {
  getCachedTaskSnapshot(taskId: string): string | undefined;
  loadTask(taskId: string): TaskState | undefined;
  listWorkflows(): Workflow[];
  publish(workflows: Workflow[]): void;
  flushMs?: number;
}

function workflowIdFromSnapshot(snapshot: string | undefined): string | undefined {
  if (!snapshot) return undefined;
  try {
    const task = JSON.parse(snapshot) as Pick<TaskState, 'config'>;
    return task.config?.workflowId;
  } catch {
    return undefined;
  }
}

function workflowIdFromLoadedTask(task: TaskState | undefined): string | undefined {
  return task?.config.workflowId;
}

export class WorkflowMetadataInvalidator {
  private readonly dirtyWorkflowIds = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly flushMs: number;

  constructor(private readonly deps: WorkflowMetadataInvalidatorDeps) {
    this.flushMs = deps.flushMs ?? 25;
  }

  markWorkflowDirty(workflowId: string | undefined | null): void {
    if (!workflowId) return;
    this.dirtyWorkflowIds.add(workflowId);
    this.scheduleFlush();
  }

  markFromTaskDelta(delta: TaskDelta): void {
    if (delta.type === 'created') {
      this.markWorkflowDirty(delta.task.config.workflowId);
      return;
    }

    if (delta.type === 'removed') {
      const workflowId =
        workflowIdFromSnapshot(this.deps.getCachedTaskSnapshot(delta.taskId)) ??
        workflowIdFromLoadedTask(this.deps.loadTask(delta.taskId));
      this.markWorkflowDirty(workflowId);
      return;
    }

    const oldWorkflowId =
      workflowIdFromSnapshot(this.deps.getCachedTaskSnapshot(delta.taskId)) ??
      workflowIdFromLoadedTask(this.deps.loadTask(delta.taskId));
    const newWorkflowId = delta.changes.config?.workflowId;
    this.markWorkflowDirty(oldWorkflowId);
    if (newWorkflowId !== oldWorkflowId) {
      this.markWorkflowDirty(newWorkflowId);
    }
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.dirtyWorkflowIds.size === 0) return;
    this.dirtyWorkflowIds.clear();
    this.deps.publish(this.deps.listWorkflows());
  }

  dispose(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.dirtyWorkflowIds.clear();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), this.flushMs);
    this.flushTimer.unref?.();
  }
}
