import { describe, expect, it } from 'vitest';
import type { WorkerActionRecord } from '@invoker/data-store';
import { PR_SUMMARY_REFRESH_WORKER_KIND } from '@invoker/execution-engine';
import {
  runReadOnlyHeadlessQueryToString,
  type HeadlessQueryDeps,
} from '../headless-query-list.js';

const recentAction: WorkerActionRecord = {
  id: 'pr-summary-refresh:__merge__wf-1:123:2:attempt-1',
  workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
  actionType: 'refresh-pr-summary',
  workflowId: 'wf-1',
  taskId: '__merge__wf-1',
  subjectType: 'review',
  subjectId: '123',
  externalKey: 'pr-summary-refresh:__merge__wf-1:123:2:attempt-1',
  status: 'completed',
  attemptCount: 1,
  summary: 'Updated PR summary with pipeline actions',
  payload: { reviewId: '123' },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:01.000Z',
  completedAt: '2026-01-01T00:00:01.000Z',
};

function deps(): HeadlessQueryDeps {
  return {
    persistence: {
      listWorkflows: () => [],
      loadTasks: () => [],
      getEvents: () => [],
      listWorkerActions: (filters?: { workerKind?: string }) =>
        filters?.workerKind === PR_SUMMARY_REFRESH_WORKER_KIND ? [recentAction] : [],
    } as unknown as HeadlessQueryDeps['persistence'],
    orchestrator: {} as unknown as HeadlessQueryDeps['orchestrator'],
    executionAgentRegistry: undefined,
    invokerConfig: {} as unknown as HeadlessQueryDeps['invokerConfig'],
    getUiPerfStats: () => ({}),
    resetUiPerfStats: () => {},
  };
}

describe('headless worker status', () => {
  it('renders status snapshot recentActions for built-in workers', async () => {
    const output = await runReadOnlyHeadlessQueryToString(
      ['worker', 'status', '--output', 'json'],
      deps(),
    );

    const parsed = JSON.parse(output) as {
      workers: Array<{ kind: string; recentActions: Array<{ id: string; summary?: string }> }>;
    };
    const worker = parsed.workers.find((row) => row.kind === PR_SUMMARY_REFRESH_WORKER_KIND);
    expect(worker?.recentActions).toEqual([
      expect.objectContaining({
        id: recentAction.id,
        summary: 'Updated PR summary with pipeline actions',
      }),
    ]);
  });
});
