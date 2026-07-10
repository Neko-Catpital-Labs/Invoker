import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { WorkerActionRecord } from '@invoker/data-store';
import { PR_SUMMARY_REFRESH_WORKER_KIND } from '@invoker/execution-engine';
import { runHeadless } from '../headless.js';

const action: WorkerActionRecord = {
  id: 'pr-refresh-1',
  workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
  actionType: 'refresh-pr-summary',
  workflowId: 'wf-1',
  taskId: '__merge__wf-1',
  subjectType: 'review',
  subjectId: '123',
  externalKey: 'pr-summary-refresh:__merge__wf-1:3:123',
  status: 'completed',
  attemptCount: 1,
  summary: 'Updated PR summary with pipeline actions',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:01:00.000Z',
  completedAt: '2026-01-01T00:01:00.000Z',
};

function makeDeps(): unknown {
  return {
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

  it('renders recentActions for registered workers', async () => {
    await runHeadless(['worker', 'status'], makeDeps() as never);

    expect(stdout).toContain('Workers');
    expect(stdout).toContain(PR_SUMMARY_REFRESH_WORKER_KIND);
    expect(stdout).toContain('recentActions');
    expect(stdout).toContain('refresh-pr-summary');
    expect(stdout).toContain('Updated PR summary with pipeline actions');
  });

  it('includes recentActions in json output', async () => {
    await runHeadless(['worker', 'status', '--output', 'json'], makeDeps() as never);

    const parsed = JSON.parse(stdout) as { workers: Array<{ kind: string; recentActions: unknown[] }> };
    const worker = parsed.workers.find((row) => row.kind === PR_SUMMARY_REFRESH_WORKER_KIND);
    expect(worker?.recentActions).toHaveLength(1);
  });
});
