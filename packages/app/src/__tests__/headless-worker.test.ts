import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerActionRecord } from '@invoker/data-store';
import { renderWorkerStatus } from '../headless-query-list.js';

const writes: string[] = [];

function action(overrides: Partial<WorkerActionRecord> = {}): WorkerActionRecord {
  return {
    id: 'pr-summary-refresh:wf-1:12',
    workerKind: 'pr-summary-refresh',
    actionType: 'review-body-refresh',
    workflowId: 'wf-1',
    taskId: '__merge__wf-1',
    subjectType: 'pull_request',
    subjectId: '12',
    externalKey: 'wf-1:__merge__wf-1:github:12:1',
    status: 'completed',
    attemptCount: 1,
    summary: 'Refreshed PR summary body',
    payload: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
    ...overrides,
  };
}

function persistence(actions: WorkerActionRecord[]) {
  return {
    countEventsByTypes: vi.fn((eventTypes: readonly string[]) =>
      eventTypes.map((eventType) => ({ eventType, count: 0, lastCreatedAt: null }))),
    getEventsByTypes: vi.fn(() => []),
    listWorkerActions: vi.fn(() => actions),
  };
}

describe('headless worker status', () => {
  afterEach(() => {
    writes.length = 0;
    vi.restoreAllMocks();
  });

  it('prints recent worker actions in text output', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    await renderWorkerStatus([], { persistence: persistence([action()]) } as never);

    const output = writes.join('');
    expect(output).toContain('Recent worker actions');
    expect(output).toContain('pr-summary-refresh');
    expect(output).toContain('Refreshed PR summary body');
  });

  it('includes recentActions in json output', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    await renderWorkerStatus(['--output', 'json'], { persistence: persistence([action()]) } as never);

    const parsed = JSON.parse(writes.join(''));
    expect(parsed.recentActions).toEqual([
      expect.objectContaining({
        workerKind: 'pr-summary-refresh',
        actionType: 'review-body-refresh',
        status: 'completed',
      }),
    ]);
  });
});
