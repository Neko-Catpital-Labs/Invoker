import { describe, expect, it } from 'vitest';

import {
  assertPlanUnchanged,
  createReviewTokenStore,
  hashPlanContent,
} from '../mcp-review-binding.js';
import {
  summarizeTaskStatuses,
  waitForWorkflowTasks,
  workflowTasksSettled,
} from '../mcp-workflow-status.js';

describe('mcp-review-binding', () => {
  it('issues tokens bound to plan content hashes', () => {
    const store = createReviewTokenStore();
    const binding = store.issue({
      planText: 'name: Demo\n',
      source: { kind: 'planPath', planPath: '/tmp/plan.yaml' },
    });
    expect(binding.token).toMatch(/^rev_/);
    expect(binding.contentHash).toBe(hashPlanContent('name: Demo\n'));
    expect(store.get(binding.token)?.source).toEqual({ kind: 'planPath', planPath: '/tmp/plan.yaml' });
    expect(store.consume(binding.token)?.token).toBe(binding.token);
    expect(store.get(binding.token)).toBeUndefined();
  });

  it('rejects changed plan content', () => {
    const hash = hashPlanContent('original');
    expect(() => assertPlanUnchanged(hash, 'changed')).toThrow(/changed after review/);
  });
});

describe('mcp-workflow-status', () => {
  it('treats approval and blocked states as settled', () => {
    expect(workflowTasksSettled([
      { id: 'a', status: 'completed' },
      { id: 'b', status: 'awaiting_approval' },
    ])).toBe(true);
    expect(workflowTasksSettled([{ id: 'a', status: 'running' }])).toBe(false);
    expect(summarizeTaskStatuses([
      { id: 'a', status: 'completed' },
      { id: 'b', status: 'failed' },
      { id: 'c', status: 'awaiting_approval' },
    ])).toMatchObject({
      total: 3,
      completed: 1,
      failed: 1,
      awaitingApproval: 1,
    });
  });

  it('returns settled=true once tasks stop being active', async () => {
    let calls = 0;
    const result = await waitForWorkflowTasks({
      workflowId: 'wf-1',
      maxWaitMs: 1000,
      pollIntervalMs: 1,
      sleep: async () => undefined,
      loadTasks: async () => {
        calls += 1;
        if (calls === 1) return [{ id: 'a', status: 'running' }];
        return [{ id: 'a', status: 'completed' }];
      },
    });
    expect(result).toMatchObject({
      settled: true,
      timedOut: false,
      status: { completed: 1, running: 0 },
    });
  });
});
