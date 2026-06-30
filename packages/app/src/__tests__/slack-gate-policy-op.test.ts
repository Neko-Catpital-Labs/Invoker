import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSlackWorkflowOpRunner } from '../slack-workflow-op.js';
import type { SlackWorkflowOp } from '../slack-workflow-op.js';

function workflow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wf-down',
    name: 'Downstream',
    externalDependencies: [
      { workflowId: 'wf-up', taskId: '__merge__', gatePolicy: 'completed' },
    ],
    ...overrides,
  };
}

describe('Slack gate-policy workflow op runner', () => {
  let persistence: {
    listWorkflows: ReturnType<typeof vi.fn>;
    loadWorkflow: ReturnType<typeof vi.fn>;
  };
  let orchestrator: { getWorkflowStatus: ReturnType<typeof vi.fn> };
  let mutations: {
    recreateWorkflow: ReturnType<typeof vi.fn>;
    rebaseRecreate: ReturnType<typeof vi.fn>;
    rebaseRetry: ReturnType<typeof vi.fn>;
    retryWorkflow: ReturnType<typeof vi.fn>;
    cancelWorkflow: ReturnType<typeof vi.fn>;
    setWorkflowExternalGatePolicies: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    persistence = {
      listWorkflows: vi.fn(() => [workflow()]),
      loadWorkflow: vi.fn((id: string) => (id === 'wf-down' ? workflow() : undefined)),
    };
    orchestrator = {
      getWorkflowStatus: vi.fn(() => ({ running: 1, pending: 2, completed: 3, failed: 0 })),
    };
    mutations = {
      recreateWorkflow: vi.fn().mockResolvedValue({}),
      rebaseRecreate: vi.fn().mockResolvedValue({}),
      rebaseRetry: vi.fn().mockResolvedValue({}),
      retryWorkflow: vi.fn().mockResolvedValue({}),
      cancelWorkflow: vi.fn().mockResolvedValue({}),
      setWorkflowExternalGatePolicies: vi.fn().mockResolvedValue({ runnable: [{ id: 'wf-down/api' }] }),
    };
  });

  it('resolves a gate-policy target by workflow name and uses the workflow mutation facade path', async () => {
    const run = createSlackWorkflowOpRunner({ persistence, orchestrator, mutations });
    const op: SlackWorkflowOp = {
      operation: 'gate-policy',
      target: { workflow: 'Downstream' },
      updates: [{ workflowId: 'wf-up', gatePolicy: 'review_ready' }],
    };

    const result = await run(op);

    expect(result.ok).toBe(true);
    expect(result.summary).toContain('gate-policy: 1 workflow updated');
    expect(result.summary).toContain('1 task started');
    expect(mutations.setWorkflowExternalGatePolicies).toHaveBeenCalledWith(
      'wf-down',
      [{ workflowId: 'wf-up', taskId: '__merge__', gatePolicy: 'review_ready' }],
    );
    expect(mutations.recreateWorkflow).not.toHaveBeenCalled();
  });

  it('supports all-workflow gate-policy targets without calling workflows that lack the dependency', async () => {
    persistence.listWorkflows.mockReturnValue([
      workflow({ id: 'wf-a', name: 'A' }),
      workflow({ id: 'wf-b', name: 'B', externalDependencies: undefined }),
      workflow({
        id: 'wf-c',
        name: 'C',
        externalDependencies: [{ workflowId: 'wf-other', taskId: '__merge__', gatePolicy: 'completed' }],
      }),
    ]);
    persistence.loadWorkflow.mockImplementation((id: string) => persistence.listWorkflows().find((w: any) => w.id === id));
    const run = createSlackWorkflowOpRunner({ persistence, orchestrator, mutations });
    const op: SlackWorkflowOp = {
      operation: 'gate-policy',
      target: { all: true },
      updates: [{ workflowId: 'wf-up', gatePolicy: 'review_ready' }],
    };

    const result = await run(op);

    expect(result.ok).toBe(true);
    expect(mutations.setWorkflowExternalGatePolicies).toHaveBeenCalledTimes(1);
    expect(mutations.setWorkflowExternalGatePolicies).toHaveBeenCalledWith(
      'wf-a',
      [{ workflowId: 'wf-up', taskId: '__merge__', gatePolicy: 'review_ready' }],
    );
    expect(result.summary).toContain('2 workflows skipped');
  });

  it('leaves existing Slack workflow operations on their previous mutation path', async () => {
    const run = createSlackWorkflowOpRunner({ persistence, orchestrator, mutations });

    const retry = await run({ operation: 'retry', target: { workflow: 'Downstream' } });
    const status = await run({ operation: 'status', target: { all: true } });

    expect(retry.ok).toBe(true);
    expect(mutations.retryWorkflow).toHaveBeenCalledWith('wf-down');
    expect(status.summary).toContain('1 running, 2 pending, 3 done, 0 failed');
    expect(orchestrator.getWorkflowStatus).toHaveBeenCalledWith('wf-down');
  });
});
