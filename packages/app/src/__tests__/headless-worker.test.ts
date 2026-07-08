import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerActionRecord } from '@invoker/data-store';

import { runHeadless, type HeadlessDeps } from '../headless.js';

const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

afterEach(() => {
  stdout.mockClear();
});

afterAll(() => {
  stdout.mockRestore();
});

function outputText(): string {
  return stdout.mock.calls.map((call) => String(call[0])).join('');
}

function deps(action: WorkerActionRecord): HeadlessDeps {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    invokerConfig: { externalWorkers: [], autoFixRetries: 0 },
    persistence: {
      listWorkerActions: vi.fn((filters?: { workerKind?: string }) =>
        filters?.workerKind === action.workerKind ? [action] : []),
      listWorkflows: vi.fn(() => []),
      loadTasks: vi.fn(() => []),
      getEvents: vi.fn(() => []),
    },
  } as unknown as HeadlessDeps;
}

describe('headless worker command', () => {
  it('prints worker status recentActions in json output', async () => {
    const action: WorkerActionRecord = {
      id: 'pr-summary-refresh:wf-1:42',
      workerKind: 'pr-summary-refresh',
      actionType: 'refresh-pr-summary',
      workflowId: 'wf-1',
      taskId: '__merge__wf-1',
      subjectType: 'review',
      subjectId: '42',
      externalKey: 'wf-1:__merge__wf-1:github:42:g1',
      status: 'completed',
      attemptCount: 1,
      summary: 'PR summary refresh checked',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
      completedAt: '2026-01-01T00:01:00.000Z',
    };

    await runHeadless(['worker', 'status', '--output', 'json'], deps(action));

    const parsed = JSON.parse(outputText()) as {
      workers: Array<{ kind: string; recentActions: Array<{ id: string; summary?: string }> }>;
    };
    const worker = parsed.workers.find((candidate) => candidate.kind === 'pr-summary-refresh');
    expect(worker?.recentActions).toEqual([
      expect.objectContaining({
        id: 'pr-summary-refresh:wf-1:42',
        summary: 'PR summary refresh checked',
      }),
    ]);
  });
});
