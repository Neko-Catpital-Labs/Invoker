import { describe, expect, it } from 'vitest';
import type { WorkerStatusSnapshot } from '@invoker/contracts';
import {
  runReadOnlyHeadlessQueryToString,
  type HeadlessQueryDeps,
} from '../headless-query-list.js';

function deps(snapshot: WorkerStatusSnapshot): HeadlessQueryDeps {
  return {
    persistence: {} as HeadlessQueryDeps['persistence'],
    orchestrator: {} as HeadlessQueryDeps['orchestrator'],
    executionAgentRegistry: undefined,
    invokerConfig: {} as HeadlessQueryDeps['invokerConfig'],
    getUiPerfStats: () => ({}),
    resetUiPerfStats: () => {},
    getWorkerStatus: () => snapshot,
  };
}

describe('headless worker status', () => {
  it('renders recent worker actions in text and JSON output', async () => {
    const snapshot: WorkerStatusSnapshot = {
      generatedAt: '2026-01-01T00:00:00.000Z',
      workers: [{
        kind: 'pr-summary-refresh',
        note: 'Refreshes PR summaries.',
        lifecycle: 'running',
        policy: 'enabled',
        autoStarts: true,
        startable: false,
        stoppable: true,
        recentActions: [{
          id: 'wa-1',
          workerKind: 'pr-summary-refresh',
          actionType: 'refresh-pr-summary',
          workflowId: 'wf-1',
          taskId: '__merge__wf-1',
          subjectType: 'pull_request',
          subjectId: '123',
          externalKey: 'wf-1:__merge__wf-1:github:123:1',
          status: 'completed',
          attemptCount: 1,
          summary: 'Updated PR body with 2 worker actions',
          createdAt: '2026-01-01T00:00:01.000Z',
          updatedAt: '2026-01-01T00:00:02.000Z',
          completedAt: '2026-01-01T00:00:02.000Z',
        }],
      }],
    };

    const text = await runReadOnlyHeadlessQueryToString(['worker', 'status'], deps(snapshot));
    expect(text).toContain('pr-summary-refresh');
    expect(text).toContain('refresh-pr-summary');
    expect(text).toContain('Updated PR body with 2 worker actions');

    const json = await runReadOnlyHeadlessQueryToString(['worker', 'status', '--output', 'json'], deps(snapshot));
    expect(JSON.parse(json).workers[0].recentActions[0]).toMatchObject({
      actionType: 'refresh-pr-summary',
      summary: 'Updated PR body with 2 worker actions',
    });
  });
});
