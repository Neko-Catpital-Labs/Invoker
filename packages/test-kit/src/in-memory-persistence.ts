import { computeWorkflowRollup } from '@invoker/workflow-core';
import type { TaskState, TaskStateChanges, OrchestratorPersistence, Attempt, ExternalDependency, ExternalDependencyChange } from '@invoker/workflow-core';

/**
 * In-memory implementation of OrchestratorPersistence for testing.
 * Stores workflows and tasks in Maps — no SQLite, no disk I/O.
 */
export class InMemoryPersistence implements OrchestratorPersistence {
  workflows = new Map<string, {
    id: string; name: string; status: string;
    createdAt: string; updatedAt: string;
    onFinish?: 'none' | 'merge' | 'pull_request'; baseBranch?: string; featureBranch?: string;
    mergeMode?: 'manual' | 'automatic' | 'external_review';
    externalDependencies?: ExternalDependency[];
    externalDependencyChanges?: ExternalDependencyChange[];
    generation?: number;
  }>();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();
  private attempts = new Map<string, Attempt[]>();

  saveWorkflow(workflow: {
    id: string; name: string;
    createdAt: string; updatedAt: string;
    onFinish?: 'none' | 'merge' | 'pull_request'; baseBranch?: string; featureBranch?: string;
    mergeMode?: 'manual' | 'automatic' | 'external_review';
    externalDependencies?: ExternalDependency[];
    externalDependencyChanges?: ExternalDependencyChange[];
    generation?: number;
  }): void {
    const now = new Date().toISOString();
    this.workflows.set(workflow.id, {
      ...workflow,
      status: 'pending',
      createdAt: workflow.createdAt ?? now,
      updatedAt: workflow.updatedAt ?? now,
    });
  }

  updateWorkflow(workflowId: string, changes: { updatedAt?: string; baseBranch?: string; generation?: number; mergeMode?: 'manual' | 'automatic' | 'external_review'; externalDependencies?: ExternalDependency[]; externalDependencyChanges?: ExternalDependencyChange[] }): void {
    const wf = this.workflows.get(workflowId);
    if (wf) {
      if (changes.updatedAt) wf.updatedAt = changes.updatedAt;
      if (changes.baseBranch !== undefined) wf.baseBranch = changes.baseBranch;
      if (changes.generation !== undefined) wf.generation = changes.generation;
      if (changes.mergeMode !== undefined) wf.mergeMode = changes.mergeMode;
      if ('externalDependencies' in changes) wf.externalDependencies = changes.externalDependencies;
      if ('externalDependencyChanges' in changes) wf.externalDependencyChanges = changes.externalDependencyChanges;
    }
  }

  saveTask(workflowId: string, task: TaskState): void {
    this.tasks.set(task.id, { workflowId, task });
  }

  updateTask(taskId: string, changes: TaskStateChanges): void {
    let resolvedId = taskId;
    let entry = this.tasks.get(resolvedId);
    if (
      !entry &&
      !taskId.includes('/') &&
      !taskId.startsWith('__merge__') &&
      !taskId.endsWith('-reconciliation')
    ) {
      const suffix = `/${taskId}`;
      const matches: string[] = [];
      for (const id of this.tasks.keys()) {
        if (id === taskId || id.endsWith(suffix)) {
          matches.push(id);
        }
      }
      if (matches.length === 1) {
        resolvedId = matches[0]!;
        entry = this.tasks.get(resolvedId);
      }
    }
    if (entry) {
      if (
        changes.execution &&
        'workspacePath' in changes.execution &&
        entry.task.config.isMergeNode
      ) {
        const prev = entry.task.execution.workspacePath ?? null;
        const next = changes.execution.workspacePath ?? null;
        console.log(
          `[merge-gate-workspace] inMemory.updateTask mergeNode task=${taskId} ` +
            `workspacePath ${prev ?? 'NULL'} → ${next ?? 'NULL'}`,
        );
      }
      entry.task = {
        ...entry.task,
        ...(changes.status !== undefined ? { status: changes.status } : {}),
        ...(changes.dependencies !== undefined ? { dependencies: changes.dependencies } : {}),
        config: { ...entry.task.config, ...changes.config },
        execution: { ...entry.task.execution, ...changes.execution },
        taskStateVersion: (entry.task.taskStateVersion ?? 1) + 1,
      } as TaskState;
    }
  }

  listWorkflows(): Array<{ id: string; name: string; status: string; createdAt: string; updatedAt: string; baseBranch?: string; onFinish?: string; mergeMode?: 'manual' | 'automatic' | 'external_review'; generation?: number }> {
    return Array.from(this.workflows.values()).map((workflow) => this.withDerivedStatus(workflow));
  }

  loadTasks(workflowId: string): TaskState[] {
    return Array.from(this.tasks.values())
      .filter((e) => e.workflowId === workflowId)
      .map((e) => e.task);
  }

  loadWorkflow(workflowId: string) {
    const workflow = this.workflows.get(workflowId);
    return workflow ? this.withDerivedStatus(workflow) as any : undefined;
  }

  private withDerivedStatus<T extends { id: string }>(workflow: T): T & { status: string } {
    const tasks = this.loadTasks(workflow.id);
    const rollup = computeWorkflowRollup(tasks);
    return { ...workflow, status: rollup.status, rollup };
  }

  getWorkspacePath(taskId: string): string | null {
    const entry = this.tasks.get(taskId);
    return entry?.task.execution.workspacePath ?? null;
  }

  logEvent(): void {}

  saveAttempt(attempt: Attempt): void {
    const list = this.attempts.get(attempt.nodeId) ?? [];
    list.push(attempt);
    this.attempts.set(attempt.nodeId, list);
  }

  loadAttempts(nodeId: string): Attempt[] {
    return this.attempts.get(nodeId) ?? [];
  }

  loadAttempt(attemptId: string): Attempt | undefined {
    for (const list of this.attempts.values()) {
      const found = list.find(a => a.id === attemptId);
      if (found) return found;
    }
    return undefined;
  }

  updateAttempt(attemptId: string, changes: Partial<Pick<Attempt, 'status' | 'startedAt' | 'completedAt' | 'exitCode' | 'error' | 'lastHeartbeatAt' | 'branch' | 'commit' | 'summary' | 'workspacePath' | 'agentSessionId' | 'containerId' | 'mergeConflict'>>): void {
    for (const list of this.attempts.values()) {
      const idx = list.findIndex(a => a.id === attemptId);
      if (idx !== -1) {
        list[idx] = { ...list[idx], ...changes } as Attempt;
        return;
      }
    }
  }

  deleteWorkflow(workflowId: string): void {
    this.workflows.delete(workflowId);
    for (const [taskId, entry] of this.tasks) {
      if (entry.workflowId === workflowId) this.tasks.delete(taskId);
    }
  }

  deleteAllWorkflows(): void {
    this.workflows.clear();
    this.tasks.clear();
  }
}
