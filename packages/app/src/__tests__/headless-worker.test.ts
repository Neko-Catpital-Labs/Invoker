import { describe, expect, it } from 'vitest';
import type { WorkerActionRecord } from '@invoker/data-store';
import {
  runReadOnlyHeadlessQueryToString,
  type HeadlessQueryDeps,
} from '../headless-query-list.js';

const recentAction: WorkerActionRecord = {
  id: 'pr-summary-refresh:__merge__wf-1:42',
  workerKind: 'pr-summary-refresh',
  actionType: 'refresh-pr-summary',
  workflowId: 'wf-1',
  taskId: '__merge__wf-1',
  subjectType: 'pull_request',
  subjectId: '__merge__wf-1:42',
  externalKey: '__merge__wf-1:42',
  status: 'completed',
  attemptCount: 1,
  summary: 'Refreshed PR summary body',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:01:00.000Z',
  completedAt: '2026-01-01T00:01:00.000Z',
};

function makeDeps(): HeadlessQueryDeps {
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
  it('renders full worker snapshot status with recentActions', async () => {
    const text = await runReadOnlyHeadlessQueryToString(['worker', 'status'], makeDeps());
    expect(text).toContain('Worker status');
    expect(text).toContain('pr-summary-refresh');
    expect(text).toContain('recentActions (1)');
    expect(text).toContain('Refreshed PR summary body');

    const json = await runReadOnlyHeadlessQueryToString(['worker', 'status', '--output', 'json'], makeDeps());
    const snapshot = JSON.parse(json) as { workers: Array<{ kind: string; recentActions: unknown[] }> };
    const worker = snapshot.workers.find((row) => row.kind === 'pr-summary-refresh');
    expect(worker?.recentActions).toHaveLength(1);
  });
});
