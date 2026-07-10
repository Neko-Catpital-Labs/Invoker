import { afterEach, describe, expect, it, vi } from 'vitest';
import { PR_SUMMARY_REFRESH_WORKER_KIND } from '@invoker/execution-engine';
import { runHeadless } from '../headless.js';

describe('headless worker command', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists the PR summary refresh worker', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runHeadless(['worker', 'list'], { invokerConfig: {} } as never);

    const output = stdout.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain(PR_SUMMARY_REFRESH_WORKER_KIND);
  });

  it('includes recentActions in worker status json output', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const persistence = {
      listWorkerActions: vi.fn(() => [{
        id: 'wa-1',
        workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
        actionType: 'refresh-pr-summary',
        subjectType: 'review',
        subjectId: '42',
        externalKey: 'key',
        status: 'completed',
        attemptCount: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }]),
      listWorkflows: vi.fn(() => []),
      loadTasks: vi.fn(() => []),
      getEvents: vi.fn(() => []),
    };

    await runHeadless(['worker', 'status', '--output', 'json'], {
      invokerConfig: {},
      persistence,
    } as never);

    const output = stdout.mock.calls.map((call) => String(call[0])).join('');
    expect(JSON.parse(output)).toMatchObject({
      recentActions: [{
        workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
        actionType: 'refresh-pr-summary',
      }],
    });
    expect(persistence.listWorkerActions).toHaveBeenCalledWith({ limit: 5 });
  });
});
