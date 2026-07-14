/**
 * Repro: NODE_ENV=test alone rewrites workflow IDs to wf-test-N, which breaks
 * chaos/overload extractors that require wf-<digits>-<digits>.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Orchestrator, type OrchestratorPersistence, type PlanDefinition } from '../orchestrator.js';
import type { Attempt, TaskState } from '../task-types.js';

class MiniPersistence implements OrchestratorPersistence {
  workflows = new Map<string, { id: string; name: string; createdAt: string; updatedAt: string }>();
  tasks = new Map<string, TaskState>();
  saveWorkflow(workflow: { id: string; name: string; createdAt: string; updatedAt: string }): void {
    this.workflows.set(workflow.id, workflow);
  }
  listWorkflows() { return Array.from(this.workflows.values()); }
  loadTasks() { return []; }
  saveTask(task: TaskState): void { this.tasks.set(task.id, task); }
  updateTask(): void {}
  logEvent(): void {}
  getAttempts(): Attempt[] { return []; }
  saveAttempt(): void {}
  updateAttempt(): void {}
}

const bus = {
  publish() {},
  subscribe() { return () => {}; },
  request() { return Promise.resolve(undefined); },
  disconnect() {},
};

describe('nextWorkflowId NODE_ENV=test rewrite (repro)', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousTestIds = process.env.INVOKER_TEST_WORKFLOW_IDS;

  beforeEach(() => {
    delete process.env.INVOKER_TEST_WORKFLOW_IDS;
  });

  afterEach(() => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousTestIds === undefined) delete process.env.INVOKER_TEST_WORKFLOW_IDS;
    else process.env.INVOKER_TEST_WORKFLOW_IDS = previousTestIds;
  });

  it('issue: NODE_ENV=test alone produces wf-test-* workflow ids', () => {
    process.env.NODE_ENV = 'test';

    const orchestrator = new Orchestrator({
      persistence: new MiniPersistence(),
      messageBus: bus as never,
      maxConcurrency: 1,
    });
    const plan: PlanDefinition = {
      name: 'id-shape',
      onFinish: 'none',
      tasks: [{ id: 't1', description: 't', command: 'true' }],
    };
    orchestrator.loadPlan(plan);
    const workflowId = orchestrator.getWorkflowIds()[0];

    expect(workflowId).toMatch(/^wf-test-\d+$/);
  });
});
