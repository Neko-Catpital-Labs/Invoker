import { describe, expect, it } from 'vitest';
import type { WorkerActionRecord } from '@invoker/data-store';
import {
  runReadOnlyHeadlessQueryToString,
  type HeadlessQueryDeps,
} from '../headless-query-list.js';

const recentAction: WorkerActionRecord = {
  id: 'pr-summary-refresh:__merge__wf-1:123:g2',
  workerKind: 'pr-summary-refresh',
  actionType: 'refresh-pr-summary',
  workflowId: 'wf-1',
  taskId: '__merge__wf-1',
  subjectType: 'review',
  subjectId: '123',
  externalKey: '__merge__wf-1:123:g2',
  status: 'completed',
  attemptCount: 1,
  summary: 'Updated PR Pipeline summary',
  payload: { reviewId: '123' },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:10.000Z',
  completedAt: '2026-01-01T00:00:10.000Z',
};

function makeDeps(): HeadlessQueryDeps {
  return {
    persistence: {
      listWorkflows: () => [],
      loadTasks: () => [],
      getEvents: () => [],
      listWorkerActions: () => [recentAction],
    } as unknown as HeadlessQueryDeps['persistence'],
    orchestrator: {} as unknown as HeadlessQueryDeps['orchestrator'],
    executionAgentRegistry: undefined,
    invokerConfig: {} as unknown as HeadlessQueryDeps['invokerConfig'],
    getUiPerfStats: () => ({}),
    resetUiPerfStats: () => {},
  };
}

describe('headless worker status', () => {
  it('includes recent worker actions in text and JSON output', async () => {
    const text = await runReadOnlyHeadlessQueryToString(['worker', 'status'], makeDeps());
    expect(text).toContain('Recent worker actions');
    expect(text).toContain('pr-summary-refresh/refresh-pr-summary [completed]');
    expect(text).toContain('Updated PR Pipeline summary');

    const json = await runReadOnlyHeadlessQueryToString(['worker', 'status', '--output', 'json'], makeDeps());
    expect(JSON.parse(json)).toMatchObject({
      workerId: 'auto-fix-recovery',
      recentActions: [
        {
          workerKind: 'pr-summary-refresh',
          actionType: 'refresh-pr-summary',
          status: 'completed',
          summary: 'Updated PR Pipeline summary',
        },
      ],
    });
  });
});
