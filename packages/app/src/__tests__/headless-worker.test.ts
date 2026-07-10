import { describe, expect, it, vi } from 'vitest';
import { runHeadless } from '../headless.js';
import type { WorkerActionRecord } from '@invoker/data-store';

const recentAction: WorkerActionRecord = {
  id: 'wa-1',
  workerKind: 'pr-summary-refresh',
  actionType: 'refresh-pr-summary',
  workflowId: 'wf-1',
  taskId: '__merge__wf-1',
  subjectType: 'pull_request',
  subjectId: '123',
  externalKey: 'wf-1:__merge__wf-1:123:g1',
  status: 'completed',
  attemptCount: 1,
  summary: 'Updated PR pipeline summary',
  payload: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:01.000Z',
  completedAt: '2026-01-01T00:00:01.000Z',
};

function deps() {
  return {
    persistence: {
      listWorkflows: vi.fn(() => []),
      loadTasks: vi.fn(() => []),
      getEvents: vi.fn(() => []),
      listWorkerActions: vi.fn(() => [recentAction]),
    },
  };
}

describe('headless worker status', () => {
  it('prints recent worker actions in text output', async () => {
    let stdout = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
    try {
      await runHeadless(['worker', 'status'], deps() as never);
    } finally {
      write.mockRestore();
    }

    expect(stdout).toContain('Recent worker actions');
    expect(stdout).toContain('pr-summary-refresh/refresh-pr-summary [completed]');
    expect(stdout).toContain('Updated PR pipeline summary');
  });

  it('includes recentActions in JSON output', async () => {
    let stdout = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
    try {
      await runHeadless(['worker', 'status', '--output', 'json'], deps() as never);
    } finally {
      write.mockRestore();
    }

    const parsed = JSON.parse(stdout);
    expect(parsed.workerId).toBe('auto-fix-recovery');
    expect(parsed.recentActions).toEqual([
      expect.objectContaining({
        workerKind: 'pr-summary-refresh',
        actionType: 'refresh-pr-summary',
        status: 'completed',
      }),
    ]);
  });
});
