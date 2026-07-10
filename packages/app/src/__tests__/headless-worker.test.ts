import { describe, expect, it, vi } from 'vitest';
import { PR_SUMMARY_REFRESH_WORKER_KIND } from '@invoker/execution-engine';
import type { WorkerActionRecord } from '@invoker/data-store';
import { runHeadless } from '../headless.js';

function makeDeps(action: WorkerActionRecord) {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn() },
    invokerConfig: {},
    persistence: {
      listWorkflows: vi.fn(() => []),
      loadTasks: vi.fn(() => []),
      getEvents: vi.fn(() => []),
      getEventsByTypes: vi.fn(() => []),
      countEventsByTypes: vi.fn((eventTypes: readonly string[]) =>
        eventTypes.map((eventType) => ({ eventType, count: 0, lastCreatedAt: null }))),
      listWorkerActions: vi.fn((filters?: { workerKind?: string }) =>
        filters?.workerKind === PR_SUMMARY_REFRESH_WORKER_KIND ? [action] : []),
    },
  };
}

describe('headless worker status', () => {
  it('renders recent worker actions in text output', async () => {
    const action: WorkerActionRecord = {
      id: 'pr-summary-refresh:__merge__wf-1:42',
      workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
      actionType: 'refresh-pr-summary',
      workflowId: 'wf-1',
      taskId: '__merge__wf-1',
      subjectType: 'pull_request',
      subjectId: '42',
      externalKey: '__merge__wf-1:42',
      status: 'completed',
      attemptCount: 1,
      summary: 'PR summary refreshed',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
      completedAt: '2026-01-01T00:00:01.000Z',
    };
    let stdout = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });

    try {
      await runHeadless(['worker', 'status'], makeDeps(action) as never);
    } finally {
      write.mockRestore();
    }

    expect(stdout).toContain(PR_SUMMARY_REFRESH_WORKER_KIND);
    expect(stdout).toContain('recentActions');
    expect(stdout).toContain('refresh-pr-summary');
    expect(stdout).toContain('PR summary refreshed');
  });
});
