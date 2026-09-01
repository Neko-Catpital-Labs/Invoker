/**
 * Repro: Cyclic task deps accepted; merge gate review_ready while cycle pending
 *
 * Symptom: Plan with tasks a↔b (cyclic dependency) is loaded without error.
 * Tasks stay `pending` forever. `__merge__` becomes `review_ready` with deps: [].
 * Rollup `review_ready` with 2 tasks still pending.
 *
 * Fix applied:
 * - parsePlan now detects cycles using Kahn's algorithm
 * - loadPlan also detects cycles before any state mutation
 * - Cyclic plans are rejected with a clear error message
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { TaskState } from '@invoker/workflow-graph';
import { Orchestrator, type OrchestratorPersistence, type PlanDefinition } from '../orchestrator.js';
import { parsePlan, PlanParseError } from '../plan-parser.js';

class InMemoryPersistence implements OrchestratorPersistence {
  private workflows = new Map<string, any>();
  private tasks = new Map<string, TaskState>();
  private attempts = new Map<string, any[]>();

  saveWorkflow(workflow: any): void {
    this.workflows.set(workflow.id, workflow);
  }
  updateWorkflow(id: string, updates: any): void {
    const wf = this.workflows.get(id);
    if (wf) Object.assign(wf, updates);
  }
  loadWorkflow(id: string): any {
    return this.workflows.get(id);
  }
  listWorkflows(): any[] {
    return Array.from(this.workflows.values());
  }
  saveTask(task: TaskState): void {
    this.tasks.set(task.id, task);
  }
  updateTask(id: string, updates: Partial<TaskState>): void {
    const t = this.tasks.get(id);
    if (t) Object.assign(t, updates);
  }
  loadTask(id: string): TaskState | undefined {
    return this.tasks.get(id);
  }
  loadTasks(workflowId?: string): TaskState[] {
    const all = Array.from(this.tasks.values());
    return workflowId ? all.filter((t) => t.config.workflowId === workflowId) : all;
  }
  loadAllTasks(): TaskState[] {
    return Array.from(this.tasks.values());
  }
  deleteTask(id: string): void {
    this.tasks.delete(id);
  }
  deleteWorkflow(id: string): void {
    this.workflows.delete(id);
    for (const [taskId, task] of this.tasks) {
      if (task.config.workflowId === id) this.tasks.delete(taskId);
    }
  }
  getTaskAttempts(taskId: string): any[] {
    return this.attempts.get(taskId) ?? [];
  }
  saveTaskAttempt(attempt: any): void {
    const list = this.attempts.get(attempt.nodeId) ?? [];
    list.push(attempt);
    this.attempts.set(attempt.nodeId, list);
  }
  updateTaskAttempt(attemptId: string, updates: any): void {
    for (const list of this.attempts.values()) {
      const att = list.find((a: any) => a.id === attemptId);
      if (att) Object.assign(att, updates);
    }
  }
  loadAllCompletedTasks(): TaskState[] {
    return [];
  }
  logEvent(): void {}
}

function createOrchestrator(): Orchestrator {
  const persistence = new InMemoryPersistence();
  const messageBus = {
    publish: () => {},
    subscribe: () => () => {},
  };
  return new Orchestrator({
    persistence,
    messageBus,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    maxConcurrentTasks: 5,
  });
}

describe('cyclic dependency detection', () => {
  let orchestrator: Orchestrator;

  beforeEach(() => {
    orchestrator = createOrchestrator();
  });

  const cyclicPlanYaml = `
name: Cyclic deps
repoUrl: git@github.com:example/repo.git
tasks:
  - id: task-a
    description: Task A depends on B
    command: echo a
    dependencies: [task-b]
  - id: task-b
    description: Task B depends on A
    command: echo b
    dependencies: [task-a]
`;

  it('parsePlan should reject cyclic dependencies', () => {
    expect(() => parsePlan(cyclicPlanYaml)).toThrow(PlanParseError);
  });

  it('loadPlan should reject cyclic dependencies', () => {
    const plan: PlanDefinition = {
      name: 'Cyclic deps',
      repoUrl: 'git@github.com:example/repo.git',
      tasks: [
        { id: 'task-a', description: 'Task A', command: 'echo a', dependencies: ['task-b'] },
        { id: 'task-b', description: 'Task B', command: 'echo b', dependencies: ['task-a'] },
      ],
    };

    expect(() => orchestrator.loadPlan(plan)).toThrow(/cycle/i);
  });

  it('loadPlan should reject self-referential dependencies', () => {
    const plan: PlanDefinition = {
      name: 'Self-referential',
      repoUrl: 'git@github.com:example/repo.git',
      tasks: [
        { id: 'task-a', description: 'Task A', command: 'echo a', dependencies: ['task-a'] },
      ],
    };

    expect(() => orchestrator.loadPlan(plan)).toThrow(/cycle/i);
  });

  it('loadPlan should reject transitive cycles (a->b->c->a)', () => {
    const plan: PlanDefinition = {
      name: 'Transitive cycle',
      repoUrl: 'git@github.com:example/repo.git',
      tasks: [
        { id: 'a', description: 'A', command: 'echo a', dependencies: ['c'] },
        { id: 'b', description: 'B', command: 'echo b', dependencies: ['a'] },
        { id: 'c', description: 'C', command: 'echo c', dependencies: ['b'] },
      ],
    };

    expect(() => orchestrator.loadPlan(plan)).toThrow(/cycle/i);
  });

  it('loadPlan should accept valid DAG (no cycles)', () => {
    const plan: PlanDefinition = {
      name: 'Valid DAG',
      repoUrl: 'git@github.com:example/repo.git',
      tasks: [
        { id: 'a', description: 'A', command: 'echo a' },
        { id: 'b', description: 'B', command: 'echo b', dependencies: ['a'] },
        { id: 'c', description: 'C', command: 'echo c', dependencies: ['a', 'b'] },
      ],
    };

    expect(() => orchestrator.loadPlan(plan)).not.toThrow();
    
    const tasks = orchestrator.getAllTasks();
    expect(tasks.some((t) => t.id.includes('a'))).toBe(true);
    expect(tasks.some((t) => t.id.includes('b'))).toBe(true);
    expect(tasks.some((t) => t.id.includes('c'))).toBe(true);
  });
});
