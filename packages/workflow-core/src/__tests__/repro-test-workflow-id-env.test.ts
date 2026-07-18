/**
 * Workflow test IDs are gated on INVOKER_TEST_WORKFLOW_IDS=1 so chaos runs can
 * keep NODE_ENV=test without breaking wf-<ms>-<n> extractors.
 */
import { afterEach, describe, expect, it } from 'vitest';
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

function loadOneWorkflowId(): string {
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
  return orchestrator.getWorkflowIds()[0]!;
}

describe('nextWorkflowId INVOKER_TEST_WORKFLOW_IDS gate', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousTestIds = process.env.INVOKER_TEST_WORKFLOW_IDS;

  afterEach(() => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousTestIds === undefined) delete process.env.INVOKER_TEST_WORKFLOW_IDS;
    else process.env.INVOKER_TEST_WORKFLOW_IDS = previousTestIds;
  });

  it('fixed: NODE_ENV=test alone uses production-shaped workflow ids', () => {
    delete process.env.INVOKER_TEST_WORKFLOW_IDS;
    process.env.NODE_ENV = 'test';
    expect(loadOneWorkflowId()).toMatch(/^wf-\d+-\d+$/);
  });

  it('fixed: INVOKER_TEST_WORKFLOW_IDS=1 yields wf-test-* ids', () => {
    process.env.INVOKER_TEST_WORKFLOW_IDS = '1';
    process.env.NODE_ENV = 'production';
    expect(loadOneWorkflowId()).toMatch(/^wf-test-\d+$/);
  });
});
