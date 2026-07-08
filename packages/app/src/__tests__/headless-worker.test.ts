import { describe, expect, it, vi } from 'vitest';
import type { WorkerActionRecord } from '@invoker/data-store';
import { runHeadless } from '../headless.js';

const action: WorkerActionRecord = {
  id: 'wa-1',
  workerKind: 'coderabbit-update',
  actionType: 'address-coderabbit-feedback',
  workflowId: 'wf-1',
  taskId: '__merge__wf-1',
  subjectType: 'pull_request',
  subjectId: '101',
  externalKey: 'coderabbit:101:2026-01-01T00:00:00.000Z',
  status: 'completed',
  attemptCount: 1,
  summary: 'CodeRabbit feedback addressed and pushed',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:01:00.000Z',
  completedAt: '2026-01-01T00:01:00.000Z',
};

describe('headless worker status', () => {
  it('emits worker status recentActions in JSON output', async () => {
    let stdout = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      stdout += chunk.toString();
      return true;
    });

    try {
      await runHeadless(['worker', 'status', '--output', 'json'], {
        persistence: {
          listWorkerActions: vi.fn((filters: { workerKind?: string }) => (
            filters.workerKind === 'coderabbit-update' ? [action] : []
          )),
          listWorkflows: vi.fn(() => []),
          loadTasks: vi.fn(() => []),
          getEvents: vi.fn(() => []),
        },
        invokerConfig: {},
      } as any);
    } finally {
      write.mockRestore();
    }

    const parsed = JSON.parse(stdout);
    const worker = parsed.workers.find((entry: { kind: string }) => entry.kind === 'coderabbit-update');
    expect(worker.recentActions).toEqual([
      expect.objectContaining({
        id: 'wa-1',
        actionType: 'address-coderabbit-feedback',
        summary: 'CodeRabbit feedback addressed and pushed',
      }),
    ]);
  });
});
