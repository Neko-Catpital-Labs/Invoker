import type { TaskState, TaskStateChanges, OrchestratorPersistence } from '@invoker/core';

/**
 * In-memory implementation of OrchestratorPersistence for testing.
 * Stores workflows and tasks in Maps — no SQLite, no disk I/O.
 */
export class InMemoryPersistence implements OrchestratorPersistence {
  workflows = new Map<string, {
    id: string; name: string; status: string;
    createdAt: string; updatedAt: string;
    onFinish?: string; baseBranch?: string; featureBranch?: string;
    mergeMode?: 'manual' | 'automatic';
    generation?: number;
  }>();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();

  saveWorkflow(workflow: {
    id: string; name: string; status: string;
    createdAt?: string; updatedAt?: string;
    onFinish?: string; baseBranch?: string; featureBranch?: string;
    mergeMode?: 'manual' | 'automatic';
    generation?: number;
  }): void {
    const now = new Date().toISOString();
    this.workflows.set(workflow.id, {
      ...workflow,
      createdAt: workflow.createdAt ?? now,
      updatedAt: workflow.updatedAt ?? now,
    });
  }

  updateWorkflow(workflowId: string, changes: { status?: string; updatedAt?: string; baseBranch?: string; generation?: number }): void {
    const wf = this.workflows.get(workflowId);
    if (wf) {
      if (changes.status) wf.status = changes.status;
      if (changes.updatedAt) wf.updatedAt = changes.updatedAt;
      if (changes.baseBranch !== undefined) wf.baseBranch = changes.baseBranch;
      if (changes.generation !== undefined) wf.generation = changes.generation;
    }
  }

  saveTask(workflowId: string, task: TaskState): void {
    this.tasks.set(task.id, { workflowId, task });
  }

  updateTask(taskId: string, changes: TaskStateChanges): void {
    const entry = this.tasks.get(taskId);
    if (entry) {
      entry.task = {
        ...entry.task,
        ...(changes.status !== undefined ? { status: changes.status } : {}),
        ...(changes.dependencies !== undefined ? { dependencies: changes.dependencies } : {}),
        config: { ...entry.task.config, ...changes.config },
        execution: { ...entry.task.execution, ...changes.execution },
      } as TaskState;
    }
  }

  listWorkflows(): Array<{ id: string; name: string; status: string; createdAt: string; updatedAt: string; baseBranch?: string; onFinish?: string; generation?: number }> {
    return Array.from(this.workflows.values());
  }

  loadTasks(workflowId: string): TaskState[] {
    return Array.from(this.tasks.values())
      .filter((e) => e.workflowId === workflowId)
      .map((e) => e.task);
  }

  loadWorkflow(workflowId: string) {
    return this.workflows.get(workflowId) as any;
  }

  logEvent(): void {}
}
