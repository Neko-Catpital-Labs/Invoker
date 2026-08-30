import { describe, it, expect, vi, afterEach } from 'vitest';
import { Orchestrator, type OrchestratorPersistence } from '../orchestrator.js';
import type { TaskState, TaskStateChanges, Attempt } from '@invoker/workflow-graph';
import { computeWorkflowRollup } from '@invoker/workflow-graph';
import { InMemoryBus } from './helpers/cross-workflow-cascade-helpers.js';

/**
 * Regression test: lifecycle mutations (retryTask, recreateTask, etc.) should
 * NOT reload the entire database on every call. They should scope their refresh
 * to the workflow(s) they actually operate on.
 *
 * Before the fix: retryTaskImpl, recreateTaskImpl, and siblings called
 * `host.refreshFromDb()` which reloads ALL tasks from ALL active workflows.
 * With 687 workflows and 2702 tasks, each retryTask call took 15–45s.
 *
 * After the fix: these functions use `host.refreshWorkflowFromDb(workflowId)`
 * to reload only the affected workflow's tasks.
 */

const WORKFLOW_COUNT = 90;
const TASKS_PER_WORKFLOW = 30;

interface TestWorkflow {
  id: string;
  name: string;
  status?: string;
  createdAt: string;
  updatedAt: string;
  repoUrl?: string;
}

class TestPersistence implements OrchestratorPersistence {
  workflows = new Map<string, TestWorkflow>();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();
  private attempts = new Map<string, Attempt[]>();
  loadTasksForWorkflowsCalls: string[][] = [];

  saveWorkflow(workflow: { id: string; name: string; repoUrl?: string }): void {
    const now = new Date().toISOString();
    this.workflows.set(workflow.id, {
      ...workflow,
      status: 'pending',
      repoUrl: workflow.repoUrl ?? 'memory://test-repo',
      createdAt: now,
      updatedAt: now,
    });
  }

  updateWorkflow(workflowId: string, changes: Partial<TestWorkflow>): void {
    const existing = this.workflows.get(workflowId);
    if (!existing) return;
    this.workflows.set(workflowId, { ...existing, ...changes });
  }

  loadWorkflow(workflowId: string): TestWorkflow | undefined {
    return this.workflows.get(workflowId);
  }

  saveTask(workflowId: string, task: TaskState): void {
    this.tasks.set(task.id, { workflowId, task });
  }

  updateTask(taskId: string, changes: TaskStateChanges): void {
    const entry = this.tasks.get(taskId);
    if (!entry) return;
    entry.task = {
      ...entry.task,
      ...(changes.status !== undefined ? { status: changes.status } : {}),
      ...(changes.dependencies !== undefined ? { dependencies: changes.dependencies } : {}),
      config: { ...entry.task.config, ...changes.config },
      execution: { ...entry.task.execution, ...changes.execution },
    } as TaskState;
  }

  listWorkflows() {
    return Array.from(this.workflows.values()).map((workflow) => ({
      ...workflow,
      status: computeWorkflowRollup(this.loadTasks(workflow.id)).status,
    }));
  }

  loadTasks(workflowId: string): TaskState[] {
    return Array.from(this.tasks.values())
      .filter((e) => e.workflowId === workflowId)
      .map((e) => e.task);
  }

  loadTasksForWorkflows(workflowIds: string[]): TaskState[] {
    this.loadTasksForWorkflowsCalls.push([...workflowIds]);
    const wfSet = new Set(workflowIds);
    return Array.from(this.tasks.values())
      .filter((e) => wfSet.has(e.workflowId))
      .map((e) => e.task);
  }

  loadWorkflowTaskSnapshot() {
    const tasksByWorkflowId = new Map<string, TaskState[]>();
    for (const entry of this.tasks.values()) {
      const arr = tasksByWorkflowId.get(entry.workflowId) ?? [];
      arr.push(entry.task);
      tasksByWorkflowId.set(entry.workflowId, arr);
    }
    return {
      workflows: Array.from(this.workflows.values()),
      tasks: Array.from(this.tasks.values()).map((e) => e.task),
      tasksByWorkflowId,
    };
  }

  logEvent(_taskId: string, _eventType: string, _payload?: unknown): void {}

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
      const found = list.find((a) => a.id === attemptId);
      if (found) return found;
    }
    return undefined;
  }

  updateAttempt(attemptId: string, changes: Partial<Attempt>): void {
    for (const list of this.attempts.values()) {
      const idx = list.findIndex((a) => a.id === attemptId);
      if (idx !== -1) {
        list[idx] = { ...list[idx], ...changes } as Attempt;
        return;
      }
    }
  }

  deleteAllWorkflows(): void {
    this.workflows.clear();
    this.tasks.clear();
  }
}

function seedLargeDatabase(persistence: TestPersistence): void {
  const nowIso = new Date().toISOString();
  for (let w = 0; w < WORKFLOW_COUNT; w++) {
    const wfId = `wf-${w}`;
    persistence.saveWorkflow({
      id: wfId,
      name: `Workflow ${w}`,
      repoUrl: 'memory://test-repo',
    });

    for (let t = 0; t < TASKS_PER_WORKFLOW; t++) {
      const taskId = `${wfId}/task-${t}`;
      const deps = t > 0 ? [`${wfId}/task-${t - 1}`] : [];
      const task: TaskState = {
        id: taskId,
        description: `Task ${t} in workflow ${w}`,
        status: t === TASKS_PER_WORKFLOW - 1 ? 'failed' : 'completed',
        dependencies: deps,
        createdAt: new Date(),
        config: {
          workflowId: wfId,
          runnerKind: 'command',
          command: 'echo test',
        },
        execution: t === TASKS_PER_WORKFLOW - 1 ? { exitCode: 1 } : { exitCode: 0 },
        taskStateVersion: 1,
      } as TaskState;
      persistence.saveTask(wfId, task);
    }
  }
}

describe('lifecycle full-reload regression', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retryTask should NOT call loadTasksForWorkflows for all workflows', async () => {
    const persistence = new TestPersistence();
    seedLargeDatabase(persistence);

    const orchestrator = new Orchestrator({
      persistence: persistence as OrchestratorPersistence,
      messageBus: new InMemoryBus(),
      maxConcurrency: 10,
    });

    orchestrator.syncAllFromDb();
    persistence.loadTasksForWorkflowsCalls = [];

    const targetTaskId = 'wf-0/task-29';
    const targetTask = orchestrator.getTask(targetTaskId);
    expect(targetTask).toBeDefined();
    expect(targetTask?.status).toBe('failed');

    const t0 = performance.now();
    orchestrator.retryTask(targetTaskId);
    const elapsed = performance.now() - t0;

    expect(
      persistence.loadTasksForWorkflowsCalls.length,
      `retryTask should NOT call loadTasksForWorkflows (full-reload), got ${persistence.loadTasksForWorkflowsCalls.length} calls`,
    ).toBe(0);

    expect(elapsed, `retryTask took ${elapsed.toFixed(0)}ms, budget is 100ms`).toBeLessThan(100);
  });

  it('draining 90 retry-task calls should complete within 10s', async () => {
    const persistence = new TestPersistence();
    seedLargeDatabase(persistence);

    const orchestrator = new Orchestrator({
      persistence: persistence as OrchestratorPersistence,
      messageBus: new InMemoryBus(),
      maxConcurrency: 10,
    });

    orchestrator.syncAllFromDb();

    const failedTasks = orchestrator.getAllTasks().filter((t) => t.status === 'failed');
    expect(failedTasks.length).toBe(WORKFLOW_COUNT);

    const t0 = performance.now();
    for (const task of failedTasks) {
      orchestrator.retryTask(task.id);
    }
    const elapsed = performance.now() - t0;

    expect(
      elapsed,
      `Draining ${WORKFLOW_COUNT} retry-task calls took ${elapsed.toFixed(0)}ms, budget is 10000ms`,
    ).toBeLessThan(10_000);
  });

  it('recreateTask should scope refresh to the target workflow only', async () => {
    const persistence = new TestPersistence();
    seedLargeDatabase(persistence);

    const orchestrator = new Orchestrator({
      persistence: persistence as OrchestratorPersistence,
      messageBus: new InMemoryBus(),
      maxConcurrency: 10,
    });

    orchestrator.syncAllFromDb();
    persistence.loadTasksForWorkflowsCalls = [];

    const targetTaskId = 'wf-5/task-29';
    const t0 = performance.now();
    orchestrator.recreateTask(targetTaskId);
    const elapsed = performance.now() - t0;

    expect(
      persistence.loadTasksForWorkflowsCalls.length,
      `recreateTask should NOT call loadTasksForWorkflows (full-reload), got ${persistence.loadTasksForWorkflowsCalls.length} calls`,
    ).toBe(0);

    expect(elapsed, `recreateTask took ${elapsed.toFixed(0)}ms, budget is 100ms`).toBeLessThan(100);
  });
});
