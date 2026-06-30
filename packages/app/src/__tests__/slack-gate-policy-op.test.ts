import { describe, expect, it, vi } from 'vitest';
import {
  createSlackWorkflowOpRunner,
  type SlackWorkflowOp,
  type SlackWorkflowOpRunnerDeps,
} from '../slack-gate-policy-op.js';

function makeDeps() {
  const workflows = [
    {
      id: 'wf-downstream',
      name: 'Downstream',
      status: 'pending' as const,
      createdAt: '2026-06-30T00:00:00.000Z',
      updatedAt: '2026-06-30T00:00:00.000Z',
      externalDependencies: [
        { workflowId: 'wf-upstream', requiredStatus: 'completed' as const, gatePolicy: 'completed' as const },
        { workflowId: 'wf-upstream', taskId: 'verify', requiredStatus: 'completed' as const, gatePolicy: 'completed' as const },
      ],
    },
    {
      id: 'wf-other',
      name: 'Other',
      status: 'pending' as const,
      createdAt: '2026-06-30T00:00:00.000Z',
      updatedAt: '2026-06-30T00:00:00.000Z',
      externalDependencies: [
        { workflowId: 'wf-upstream', taskId: 'review', requiredStatus: 'completed' as const, gatePolicy: 'completed' as const },
      ],
    },
  ];
  const persistence = {
    listWorkflows: vi.fn(() => workflows),
    loadWorkflow: vi.fn((id: string) => workflows.find((workflow) => workflow.id === id)),
  };
  const mutations = {
    recreateWorkflow: vi.fn(async () => ({ started: [], runnable: [], topup: [] })),
    rebaseRecreate: vi.fn(async () => ({ started: [], runnable: [], topup: [] })),
    rebaseRetry: vi.fn(async () => ({ started: [], runnable: [], topup: [] })),
    retryWorkflow: vi.fn(async () => ({ started: [], runnable: [], topup: [] })),
    cancelWorkflow: vi.fn(async () => ({ cancelled: [], runningCancelled: [], topup: [] })),
    setWorkflowExternalGatePolicies: vi.fn(async () => ({
      started: [{ id: 'wf-downstream/task-a', status: 'running', execution: {}, config: { workflowId: 'wf-downstream' } }],
      runnable: [{ id: 'wf-downstream/task-a', status: 'running', execution: {}, config: { workflowId: 'wf-downstream' } }],
      topup: [],
    })),
  };
  const orchestrator = {
    getWorkflowStatus: vi.fn(() => ({ running: 0, pending: 1, completed: 2, failed: 0 })),
  };
  return { persistence, mutations, orchestrator } satisfies SlackWorkflowOpRunnerDeps;
}

describe('Slack gate-policy workflow op runner', () => {
  it('resolves workflow names and updates matching external dependencies through the mutation facade', async () => {
    const deps = makeDeps();
    const run = createSlackWorkflowOpRunner(deps);

    const result = await run({
      operation: 'gate-policy',
      target: { workflow: 'Downstream' },
      updates: [{ workflowId: 'wf-upstream', taskId: '__merge__', gatePolicy: 'review_ready' }],
    });

    expect(result.ok).toBe(true);
    expect(deps.mutations.setWorkflowExternalGatePolicies).toHaveBeenCalledWith('wf-downstream', [
      { workflowId: 'wf-upstream', taskId: undefined, gatePolicy: 'review_ready' },
    ]);
    expect(result.summary).toContain('gate-policy: 1 ok');
    expect(result.summary).toContain('wf-upstream/__merge__ -> review_ready');
  });

  it('fans out all-target gate-policy ops across workflows with dependency-specific updates', async () => {
    const deps = makeDeps();
    const run = createSlackWorkflowOpRunner(deps);

    const op: SlackWorkflowOp = {
      operation: 'gate-policy',
      target: { all: true },
      updates: [{ workflowId: 'wf-upstream', taskId: 'review', gatePolicy: 'review_ready' }],
    };
    const result = await run(op);

    expect(result.ok).toBe(false);
    expect(deps.mutations.setWorkflowExternalGatePolicies).toHaveBeenCalledTimes(1);
    expect(deps.mutations.setWorkflowExternalGatePolicies).toHaveBeenCalledWith('wf-other', [
      { workflowId: 'wf-upstream', taskId: 'review', gatePolicy: 'review_ready' },
    ]);
    expect(result.summary).toContain('wf-downstream: Workflow wf-downstream has no external dependencies matching');
  });

  it('preserves legacy workflow op routing through the existing mutation facade methods', async () => {
    const deps = makeDeps();
    const run = createSlackWorkflowOpRunner(deps);

    const result = await run({ operation: 'retry', target: { workflow: 'Downstream' } });

    expect(result.ok).toBe(true);
    expect(deps.mutations.retryWorkflow).toHaveBeenCalledWith('wf-downstream');
    expect(deps.mutations.setWorkflowExternalGatePolicies).not.toHaveBeenCalled();
    expect(result.summary).toBe('retry: 1 ok');
  });
});
