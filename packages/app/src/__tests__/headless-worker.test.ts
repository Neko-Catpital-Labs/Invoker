import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerActionRecord } from '@invoker/data-store';
import { PR_SUMMARY_REFRESH_WORKER_KIND } from '@invoker/execution-engine';

import { runHeadless } from '../headless.js';
import type { HeadlessDeps } from '../headless-shared.js';

const workerAction: WorkerActionRecord = {
  id: 'pr-summary-action-1',
  workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
  actionType: 'refresh-pr-summary',
  workflowId: 'wf-1',
  taskId: 'wf-1/__merge__',
  subjectType: 'pull_request',
  subjectId: '301',
  externalKey: 'pr-summary-refresh:wf-1:wf-1/__merge__:pr-301:abc',
  status: 'completed',
  attemptCount: 1,
  summary: 'Updated PR body with the latest Invoker pipeline summary',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:01:00.000Z',
  completedAt: '2026-01-01T00:01:00.000Z',
};

function makeDeps(): HeadlessDeps {
  return {
    invokerConfig: {},
    persistence: {
      listWorkerActions: vi.fn((filters?: { workerKind?: string }) =>
        filters?.workerKind === PR_SUMMARY_REFRESH_WORKER_KIND ? [workerAction] : []),
      listWorkflows: vi.fn(() => []),
      loadTasks: vi.fn(() => []),
      getEvents: vi.fn(() => []),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  } as unknown as HeadlessDeps;
}

describe('headless worker status', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes recentActions for registered worker kinds in JSON output', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runHeadless(['worker', 'status', '--output', 'json'], makeDeps());

    const payload = JSON.parse(String(stdout.mock.calls[0][0]));
    const prSummary = payload.workers.find((worker: { kind: string }) =>
      worker.kind === PR_SUMMARY_REFRESH_WORKER_KIND);
    expect(prSummary).toMatchObject({
      kind: PR_SUMMARY_REFRESH_WORKER_KIND,
      recentActions: [expect.objectContaining({
        actionType: 'refresh-pr-summary',
        status: 'completed',
        summary: 'Updated PR body with the latest Invoker pipeline summary',
      })],
    });
  });

  it('renders recentActions in text status output', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runHeadless(['worker', 'status'], makeDeps());

    const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output).toContain('Worker status');
    expect(output).toContain(PR_SUMMARY_REFRESH_WORKER_KIND);
    expect(output).toContain('refresh-pr-summary');
    expect(output).toContain('Updated PR body with the latest Invoker pipeline summary');
  });
});
