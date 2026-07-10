import { describe, expect, it } from 'vitest';
import type { WorkerActionRecord } from '@invoker/data-store';
import { PR_SUMMARY_REFRESH_WORKER_KIND } from '@invoker/execution-engine';
import {
  runReadOnlyHeadlessQueryToString,
  type HeadlessQueryDeps,
} from '../headless-query-list.js';

const summaryAction: WorkerActionRecord = {
  id: 'wa-summary',
  workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
  actionType: 'refresh-pr-summary',
  workflowId: 'wf-1',
  taskId: 'wf-1/__merge__',
  subjectType: 'review',
  subjectId: '123',
  externalKey: 'wf-1:wf-1/__merge__:github:123',
  status: 'completed',
  attemptCount: 1,
  summary: 'Updated PR summary with pipeline actions',
  payload: { reviewId: '123' },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:05:00.000Z',
  completedAt: '2026-01-01T00:05:00.000Z',
};

function makeDeps(): HeadlessQueryDeps {
  return {
    persistence: {
      listWorkerActions: (filters?: { workerKind?: string }) =>
        filters?.workerKind === PR_SUMMARY_REFRESH_WORKER_KIND ? [summaryAction] : [],
      listWorkflows: () => [],
      loadTasks: () => [],
      getEvents: () => [],
      getEventsByTypes: () => [],
      countEventsByTypes: (eventTypes: readonly string[]) =>
        eventTypes.map((eventType) => ({ eventType, count: 0, lastCreatedAt: null })),
    } as unknown as HeadlessQueryDeps['persistence'],
    orchestrator: {} as unknown as HeadlessQueryDeps['orchestrator'],
    executionAgentRegistry: undefined,
    invokerConfig: {} as unknown as HeadlessQueryDeps['invokerConfig'],
    getUiPerfStats: () => ({}),
    resetUiPerfStats: () => {},
  };
}

describe('headless worker status', () => {
  it('includes recentActions in JSON status output', async () => {
    const output = await runReadOnlyHeadlessQueryToString(
      ['worker', 'status', '--output', 'json'],
      makeDeps(),
    );

    const parsed = JSON.parse(output) as { workers: Array<{ kind: string; recentActions: unknown[] }> };
    const worker = parsed.workers.find((candidate) => candidate.kind === PR_SUMMARY_REFRESH_WORKER_KIND);
    expect(worker?.recentActions).toEqual([
      expect.objectContaining({
        id: 'wa-summary',
        actionType: 'refresh-pr-summary',
        summary: 'Updated PR summary with pipeline actions',
      }),
    ]);
  });

  it('renders recentActions in text status output', async () => {
    const output = await runReadOnlyHeadlessQueryToString(
      ['worker', 'status'],
      makeDeps(),
    );

    expect(output).toContain('Worker status');
    expect(output).toContain(PR_SUMMARY_REFRESH_WORKER_KIND);
    expect(output).toContain('recentActions:');
    expect(output).toContain('Updated PR summary with pipeline actions');
  });
});
