import { describe, expect, it } from 'vitest';
import type { WorkerActionRecord } from '@invoker/data-store';
import {
  runReadOnlyHeadlessQueryToString,
  type HeadlessQueryDeps,
} from '../headless-query-list.js';

const recentAction: WorkerActionRecord = {
  id: 'pr-summary-refresh:42',
  workerKind: 'pr-summary-refresh',
  actionType: 'refresh-pr-summary',
  workflowId: 'wf-1',
  taskId: '__merge__wf-1',
  subjectType: 'review',
  subjectId: '42',
  externalKey: 'pr-summary-refresh:__merge__wf-1:2:github:42',
  status: 'completed',
  attemptCount: 1,
  summary: 'Updated PR body pipeline summary',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:01:00.000Z',
  completedAt: '2026-01-01T00:01:00.000Z',
};

function deps(): HeadlessQueryDeps {
  return {
    persistence: {
      listWorkerActions: (filters?: { workerKind?: string }) =>
        filters?.workerKind === 'pr-summary-refresh' ? [recentAction] : [],
      listWorkflows: () => [],
      loadTasks: () => [],
      getEvents: () => [],
    } as unknown as HeadlessQueryDeps['persistence'],
    orchestrator: {} as unknown as HeadlessQueryDeps['orchestrator'],
    executionAgentRegistry: undefined,
    invokerConfig: {} as unknown as HeadlessQueryDeps['invokerConfig'],
    getUiPerfStats: () => ({}),
    resetUiPerfStats: () => {},
  };
}

describe('headless worker status', () => {
  it('includes recentActions in JSON and text output', async () => {
    const json = await runReadOnlyHeadlessQueryToString(['worker', 'status', '--output', 'json'], deps());
    const parsed = JSON.parse(json) as { workers: Array<{ kind: string; recentActions: Array<{ id: string }> }> };
    const worker = parsed.workers.find((candidate) => candidate.kind === 'pr-summary-refresh');
    expect(worker?.recentActions).toEqual([expect.objectContaining({ id: recentAction.id })]);

    const text = await runReadOnlyHeadlessQueryToString(['worker', 'status'], deps());
    expect(text).toContain('pr-summary-refresh');
    expect(text).toContain('recentActions (1)');
    expect(text).toContain('Updated PR body pipeline summary');
  });
});
