import { describe, expect, it, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import type { WorkerActionRecord } from '@invoker/data-store';
import { PR_SUMMARY_REFRESH_WORKER_KIND } from '@invoker/execution-engine';
import { runHeadless } from '../headless.js';

function workerAction(): WorkerActionRecord {
  return {
    id: 'pr-summary-refresh:1',
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: 'refresh-pr-summary',
    workflowId: 'wf-1',
    taskId: '__merge__wf-1',
    subjectType: 'review',
    subjectId: '42',
    externalKey: 'refresh:42',
    status: 'completed',
    attemptCount: 1,
    summary: 'Updated PR summary body',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
  };
}

function deps(): unknown {
  return {
    invokerConfig: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn() },
    persistence: {
      listWorkerActions: vi.fn((filters?: { workerKind?: string }) =>
        filters?.workerKind === PR_SUMMARY_REFRESH_WORKER_KIND ? [workerAction()] : []),
      listWorkflows: vi.fn(() => []),
      loadTasks: vi.fn(() => []),
      getEvents: vi.fn(() => []),
      getEventsByTypes: vi.fn(() => []),
      countEventsByTypes: vi.fn(() => []),
    },
  };
}

describe('headless worker status', () => {
  let write: MockInstance;
  let stdout: string;

  beforeEach(() => {
    stdout = '';
    write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    write.mockRestore();
  });

  it('lists the PR summary refresh worker from the manual entrypoint', async () => {
    await runHeadless(['worker', 'list'], deps() as never);

    expect(stdout).toContain(PR_SUMMARY_REFRESH_WORKER_KIND);
  });

  it('prints recentActions in worker status output', async () => {
    await runHeadless(['worker', 'status'], deps() as never);

    expect(stdout).toContain('recentActions');
    expect(stdout).toContain(PR_SUMMARY_REFRESH_WORKER_KIND);
    expect(stdout).toContain('Updated PR summary body');
  });
});
