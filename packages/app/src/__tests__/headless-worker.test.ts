import { describe, expect, it } from 'vitest';
import type { WorkerActionRecord } from '@invoker/data-store';
import {
  PR_SUMMARY_REFRESH_WORKER_KIND,
} from '@invoker/execution-engine';

import {
  runReadOnlyHeadlessQueryToString,
  type HeadlessQueryDeps,
} from '../headless-query-list.js';

const action: WorkerActionRecord = {
  id: 'pr-summary-refresh:__merge__wf-1:42',
  workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
  actionType: 'refresh-pr-summary',
  workflowId: 'wf-1',
  taskId: '__merge__wf-1',
  subjectType: 'review',
  subjectId: '42',
  externalKey: 'pr-summary-refresh:__merge__wf-1:42',
  status: 'completed',
  attemptCount: 1,
  summary: 'Updated PR body with pipeline summary',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:01.000Z',
  completedAt: '2026-01-01T00:00:01.000Z',
};

function deps(): HeadlessQueryDeps {
  return {
    persistence: {
      listWorkerActions: () => [action],
      countEventsByTypes: (eventTypes: readonly string[]) =>
        eventTypes.map((eventType) => ({ eventType, count: 0, lastCreatedAt: null })),
      getEventsByTypes: () => [],
      listWorkflows: () => [],
    } as unknown as HeadlessQueryDeps['persistence'],
    orchestrator: {} as unknown as HeadlessQueryDeps['orchestrator'],
    executionAgentRegistry: undefined,
    invokerConfig: {} as unknown as HeadlessQueryDeps['invokerConfig'],
    getUiPerfStats: () => ({}),
    resetUiPerfStats: () => {},
  };
}

describe('headless worker status', () => {
  it('includes recentActions in JSON output', async () => {
    const output = await runReadOnlyHeadlessQueryToString(
      ['worker', 'status', '--output', 'json'],
      deps(),
    );

    const parsed = JSON.parse(output) as { recentActions?: Array<{ workerKind: string; actionType: string }> };
    expect(parsed.recentActions).toEqual([
      expect.objectContaining({
        workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
        actionType: 'refresh-pr-summary',
      }),
    ]);
  });

  it('renders recentActions in text output', async () => {
    const output = await runReadOnlyHeadlessQueryToString(
      ['worker', 'status'],
      deps(),
    );

    expect(output).toContain('Recent worker actions');
    expect(output).toContain('pr-summary-refresh/refresh-pr-summary');
    expect(output).toContain('Updated PR body with pipeline summary');
  });
});
