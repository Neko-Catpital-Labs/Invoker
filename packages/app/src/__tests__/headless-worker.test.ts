import { describe, expect, it, vi } from 'vitest';
import type { WorkerActionRecord } from '@invoker/data-store';
import { PR_SUMMARY_REFRESH_WORKER_KIND } from '@invoker/execution-engine';
import { runHeadless } from '../headless.js';

describe('headless worker status', () => {
  it('renders registered workers with recentActions', async () => {
    const action: WorkerActionRecord = {
      id: 'pr-summary-refresh:wf-1:42',
      workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
      actionType: 'refresh-pr-summary',
      workflowId: 'wf-1',
      taskId: '__merge__wf-1',
      subjectType: 'review',
      subjectId: '42',
      externalKey: 'refresh:key',
      status: 'completed',
      attemptCount: 1,
      summary: 'Updated PR summary with worker pipeline',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
      completedAt: '2026-01-01T00:01:00.000Z',
    };
    let stdout = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });

    try {
      await runHeadless(['worker', 'status'], {
        invokerConfig: {},
        persistence: {
          listWorkerActions: vi.fn((filters?: { workerKind?: string }) =>
            filters?.workerKind === PR_SUMMARY_REFRESH_WORKER_KIND ? [action] : []),
          listWorkflows: vi.fn(() => []),
          loadTasks: vi.fn(() => []),
          getEvents: vi.fn(() => []),
          getEventsByTypes: vi.fn(() => []),
          countEventsByTypes: vi.fn(() => []),
        },
      } as never);
    } finally {
      write.mockRestore();
    }

    expect(stdout).toContain('Worker status');
    expect(stdout).toContain(PR_SUMMARY_REFRESH_WORKER_KIND);
    expect(stdout).toContain('recentActions');
    expect(stdout).toContain('Updated PR summary with worker pipeline');
  });
});
