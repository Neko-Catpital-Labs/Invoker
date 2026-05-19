// REGRESSION: recreateWorkflow must clear config.poolMemberId so an
// auto-selected SSH host does not become a permanent pin across
// generations.
//
// Audit-log evidence from the 2026-05-19 incident: 10 tasks failed in an
// 8-second window with task.executor.selected reason="explicitPoolMemberId"
// and poolMemberId="remote_digital_ocean_1" for every one — i.e. a prior
// leastLoaded pick had been promoted to config and replayed by recreate
// without rebalancing, so a rebase-storm of 37 workflows piled all
// re-runs onto one host. host saturated, heartbeats stopped, executing-
// stall guard fired the batch at +180s.
//
// Mocks are copied from cancel-task.test.ts to stay consistent with the
// rest of the orchestrator test suite.

import { describe, it, expect, beforeEach } from 'vitest';
import { Orchestrator } from '../orchestrator.js';
import type {
  PlanDefinition,
  OrchestratorPersistence,
  OrchestratorMessageBus,
} from '../orchestrator.js';
import { computeWorkflowRollup } from '../task-types.js';
import type { TaskState, TaskStateChanges, Attempt } from '../task-types.js';

class InMemoryPersistence implements OrchestratorPersistence {
  workflows = new Map<string, any>();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();
  private attempts = new Map<string, Attempt[]>();
  events: Array<{ taskId: string; eventType: string; payload?: unknown }> = [];

  saveWorkflow(workflow: any): void {
    const now = new Date().toISOString();
    this.workflows.set(workflow.id, {
      ...workflow,
      createdAt: workflow.createdAt ?? now,
      updatedAt: workflow.updatedAt ?? now,
    });
  }
  updateWorkflow(): void {}
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
      config: { ...entry.task.config, ...(changes.config ?? {}) },
      execution: { ...entry.task.execution, ...(changes.execution ?? {}) },
    } as TaskState;
  }
  listWorkflows(): any[] {
    return Array.from(this.workflows.values()).map((wf) => {
      const tasks = this.loadTasks(wf.id);
      if (tasks.length === 0) return wf;
      const rollup = computeWorkflowRollup(tasks);
      return { ...wf, status: rollup.status, rollup };
    });
  }
  loadWorkflow(id: string): any { return this.workflows.get(id); }
  loadTasks(workflowId: string): TaskState[] {
    return Array.from(this.tasks.values())
      .filter((e) => e.workflowId === workflowId)
      .map((e) => e.task);
  }
  saveAttempt(a: Attempt): void {
    const list = this.attempts.get(a.nodeId) ?? [];
    list.push(a);
    this.attempts.set(a.nodeId, list);
  }
  loadAttempts(nodeId: string): Attempt[] { return this.attempts.get(nodeId) ?? []; }
  loadAttempt(id: string): Attempt | undefined {
    for (const list of this.attempts.values()) {
      const a = list.find((x) => x.id === id);
      if (a) return a;
    }
    return undefined;
  }
  updateAttempt(id: string, changes: Partial<Attempt>): void {
    for (const list of this.attempts.values()) {
      const i = list.findIndex((x) => x.id === id);
      if (i >= 0) list[i] = { ...list[i], ...changes };
    }
  }
  logEvent(taskId: string, eventType: string, payload?: unknown): void {
    this.events.push({ taskId, eventType, payload });
  }
}

class InMemoryBus implements OrchestratorMessageBus {
  private handlers = new Map<string, Set<(m: unknown) => void>>();
  publish<T>(channel: string, message: T): void {
    const set = this.handlers.get(channel);
    if (set) for (const h of set) h(message);
  }
  subscribe(channel: string, h: (m: unknown) => void): () => void {
    if (!this.handlers.has(channel)) this.handlers.set(channel, new Set());
    this.handlers.get(channel)!.add(h);
    return () => this.handlers.get(channel)?.delete(h);
  }
}

function plan11Tasks(): PlanDefinition {
  return {
    name: 'pin-storm',
    repoUrl: 'git@example.test:/repo.git',
    tasks: Array.from({ length: 11 }, (_, i) => ({
      id: `t${i}`,
      description: `Task ${i}`,
      command: `echo ${i}`,
      dependencies: [],
      poolId: 'mixed-local-ssh',
    })),
  } as any;
}

describe('regression: recreateWorkflow clears config.poolMemberId on SSH tasks', () => {
  let orchestrator: Orchestrator;
  let persistence: InMemoryPersistence;

  beforeEach(() => {
    persistence = new InMemoryPersistence();
    orchestrator = new Orchestrator({
      persistence,
      messageBus: new InMemoryBus(),
      maxConcurrency: 12,
      availablePoolIds: new Set(['mixed-local-ssh']),
    } as any);
  });

  it('rebase-recreate of 11 host-pinned tasks releases the pin (no replay)', () => {
    orchestrator.loadPlan(plan11Tasks());

    // Identify the workflow the loadPlan created.
    const workflows = persistence.listWorkflows();
    expect(workflows).toHaveLength(1);
    const wfId = workflows[0].id;
    // loadPlan auto-adds a merge node; exclude it for the pin-storm simulation.
    const workTasks = persistence.loadTasks(wfId).filter((t) => !t.config.isMergeNode);
    expect(workTasks).toHaveLength(11);

    // Simulate the post-prior-run state: every task pre-pinned to one host
    // (mirrors what happens after a prior leastLoaded run that picked
    // remote_digital_ocean_1 for each task).
    for (const t of workTasks) {
      persistence.updateTask(t.id, {
        config: { poolMemberId: 'remote_digital_ocean_1' } as any,
      });
    }
    // Pre-condition: every (non-merge) task pinned to host 1.
    const beforePins = persistence
      .loadTasks(wfId)
      .filter((t) => !t.config.isMergeNode)
      .map((t) => (t.config as any).poolMemberId);
    expect(beforePins).toEqual(Array(11).fill('remote_digital_ocean_1'));

    // The mutation under test — same one the rebase-storm fires per workflow.
    orchestrator.recreateWorkflow(wfId);

    const after = persistence.loadTasks(wfId).filter((t) => !t.config.isMergeNode);

    // Fix contract: poolMemberId is cleared so the next launch goes back
    // through pool selection. No task carries the old pin into the next
    // generation.
    const afterPins = after.map((t) => (t.config as any).poolMemberId);
    expect(afterPins).toEqual(Array(11).fill(undefined));

    // Execution-side fields cleared as before.
    expect(
      after.every(
        (t) => t.execution.branch === undefined && t.execution.workspacePath === undefined,
      ),
    ).toBe(true);

    // Generation bumped — proving recreate actually ran, not a no-op.
    expect(after.every((t) => (t.execution.generation ?? 0) >= 1)).toBe(true);
  });
});
