import { computeWorkflowRollup, type TaskDelta, type TaskState } from '@invoker/workflow-core';
import type { WorkflowRollupPatch } from '@invoker/contracts';
type UpdatedTaskDelta = Extract<TaskDelta, { type: 'updated' }>;


export class WorkflowRollupProjection {
  private readonly tasksById = new Map<string, TaskState>();
  private readonly taskIdsByWorkflowId = new Map<string, Set<string>>();

  replaceAll(tasks: readonly TaskState[]): void {
    this.clear();
    for (const task of tasks) {
      this.updateTaskIndexes(task);
    }
  }

  clear(): void {
    this.tasksById.clear();
    this.taskIdsByWorkflowId.clear();
  }

  applyDelta(delta: TaskDelta): WorkflowRollupPatch[] {
    switch (delta.type) {
      case 'created':
        return this.applyCreatedTask(delta.task);
      case 'updated':
        return this.applyUpdatedTask(delta);
      case 'removed':
        return this.applyRemovedTask(delta.taskId);
    }
  }

  private applyCreatedTask(task: TaskState): WorkflowRollupPatch[] {
    this.updateTaskIndexes(task);
    return this.patchWorkflowById(task.config.workflowId);
  }

  private applyUpdatedTask(delta: UpdatedTaskDelta): WorkflowRollupPatch[] {
    const previousTask = this.tasksById.get(delta.taskId);
    if (!previousTask) {
      return [];
    }

    const nextTask = this.mergeUpdatedTask(previousTask, delta);
    this.updateTaskIndexes(nextTask);
    return this.patchWorkflowById(previousTask.config.workflowId, nextTask.config.workflowId);
  }

  private applyRemovedTask(taskId: string): WorkflowRollupPatch[] {
    const previousTask = this.tasksById.get(taskId);
    if (!previousTask) {
      return [];
    }

    this.tasksById.delete(taskId);
    const workflowId = previousTask.config.workflowId;
    if (!workflowId) {
      return [];
    }

    this.removeTaskFromWorkflow(taskId, workflowId);
    return this.patchWorkflowById(workflowId);
  }

  private mergeUpdatedTask(previousTask: TaskState, delta: UpdatedTaskDelta): TaskState {
    const {
      config: configChanges,
      execution: executionChanges,
      ...topLevelChanges
    } = delta.changes;
    return {
      ...previousTask,
      ...topLevelChanges,
      taskStateVersion: delta.taskStateVersion,
      config: { ...previousTask.config, ...configChanges } as TaskState['config'],
      execution: { ...previousTask.execution, ...executionChanges } as TaskState['execution'],
    } as TaskState;
  }

  private patchWorkflowById(...workflowIds: Array<string | undefined>): WorkflowRollupPatch[] {
    const seenWorkflowIds = new Set<string>();
    const patches: WorkflowRollupPatch[] = [];
    for (const workflowId of workflowIds) {
      if (!workflowId || seenWorkflowIds.has(workflowId)) {
        continue;
      }
      seenWorkflowIds.add(workflowId);
      patches.push(this.patchFor(workflowId));
    }
    return patches;
  }

  patchFor(workflowId: string): WorkflowRollupPatch {
    const taskIds = this.taskIdsByWorkflowId.get(workflowId);
    const tasks: TaskState[] = [];
    if (taskIds) {
      for (const taskId of taskIds) {
        const task = this.tasksById.get(taskId);
        if (task) {
          tasks.push(task);
        }
      }
    }
    const rollup = computeWorkflowRollup(tasks);
    return { workflowId, status: rollup.status, rollup };
  }

  private updateTaskIndexes(task: TaskState): void {
    const previous = this.tasksById.get(task.id);
    const previousWorkflowId = previous?.config.workflowId;
    if (previousWorkflowId && previousWorkflowId !== task.config.workflowId) {
      this.removeTaskFromWorkflow(task.id, previousWorkflowId);
    }
    this.tasksById.set(task.id, task);
    const workflowId = task.config.workflowId;
    if (workflowId) {
      this.addTaskToWorkflow(task.id, workflowId);
    }
  }

  private addTaskToWorkflow(taskId: string, workflowId: string): void {
    let taskIds = this.taskIdsByWorkflowId.get(workflowId);
    if (!taskIds) {
      taskIds = new Set<string>();
      this.taskIdsByWorkflowId.set(workflowId, taskIds);
    }
    taskIds.add(taskId);
  }

  private removeTaskFromWorkflow(taskId: string, workflowId: string): void {
    const taskIds = this.taskIdsByWorkflowId.get(workflowId);
    if (!taskIds) {
      return;
    }
    taskIds.delete(taskId);
    if (taskIds.size === 0) {
      this.taskIdsByWorkflowId.delete(workflowId);
    }
  }
}
