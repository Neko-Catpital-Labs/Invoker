import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerActionRecord } from '@invoker/data-store';
import { PR_SUMMARY_REFRESH_WORKER_KIND } from '@invoker/execution-engine';
import { runHeadless } from '../headless.js';

const writes: string[] = [];

afterEach(() => {
  writes.length = 0;
  vi.restoreAllMocks();
});

function deps() {
  const action: WorkerActionRecord = {
    id: 'wa-pr-summary',
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: 'refresh-pr-summary',
    workflowId: 'wf-1',
    taskId: 'wf-1/__merge__',
    subjectType: 'pull_request',
    subjectId: '123',
    externalKey: 'wf-1:wf-1/__merge__:123',
    status: 'completed',
    attemptCount: 1,
    summary: 'Refreshed PR summary',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    completedAt: '2026-01-01T00:01:00.000Z',
  };
  return {
    invokerConfig: {},
    persistence: {
      listWorkerActions: vi.fn((filters?: { workerKind?: string }) =>
        filters?.workerKind === PR_SUMMARY_REFRESH_WORKER_KIND ? [action] : [],
      ),
      listWorkflows: vi.fn(() => []),
      loadTasks: vi.fn(() => []),
      getEvents: vi.fn(() => []),
      getEventsByTypes: vi.fn(() => []),
      countEventsByTypes: vi.fn(() => []),
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

describe('headless worker command', () => {
  it('renders worker status with recentActions', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    await runHeadless(['worker', 'status'], deps() as never);

    const output = writes.join('');
    expect(output).toContain(PR_SUMMARY_REFRESH_WORKER_KIND);
    expect(output).toContain('recentActions');
    expect(output).toContain('wa-pr-summary');
    expect(output).toContain('Refreshed PR summary');
  });
});
