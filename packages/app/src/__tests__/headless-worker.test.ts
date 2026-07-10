import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { WorkerActionRecord } from '@invoker/data-store';
import { PR_SUMMARY_REFRESH_WORKER_KIND } from '@invoker/execution-engine';
import { runHeadless } from '../headless.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn() };

describe('headless worker status and pr-summary-refresh', () => {
  let homeRoot: string;
  let previousDbDir: string | undefined;
  let stdout: string;
  let write: MockInstance;

  beforeEach(() => {
    homeRoot = mkdtempSync(join(tmpdir(), 'invoker-headless-worker-'));
    previousDbDir = process.env.INVOKER_DB_DIR;
    process.env.INVOKER_DB_DIR = homeRoot;
    stdout = '';
    write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    write.mockRestore();
    if (previousDbDir === undefined) delete process.env.INVOKER_DB_DIR;
    else process.env.INVOKER_DB_DIR = previousDbDir;
    rmSync(homeRoot, { recursive: true, force: true });
  });

  it('runs pr-summary-refresh as a one-shot worker scan', async () => {
    await runHeadless(['worker', PR_SUMMARY_REFRESH_WORKER_KIND], {
      logger,
      repoRoot: '/repo',
      invokerConfig: {},
      persistence: {
        listWorkflows: vi.fn(() => []),
        loadTasks: vi.fn(() => []),
        listWorkerActions: vi.fn(() => []),
        enqueueWorkflowMutationIntent: vi.fn(() => 1),
      },
    } as never);

    expect(stdout).toContain(`${PR_SUMMARY_REFRESH_WORKER_KIND} worker scan completed.`);
  });

  it('prints recentActions in worker status JSON output', async () => {
    const action: WorkerActionRecord = {
      id: 'wa-1',
      workerKind: 'autofix',
      actionType: 'auto-fix',
      workflowId: 'wf-1',
      taskId: 'wf-1/task-1',
      subjectType: 'task',
      subjectId: 'wf-1/task-1',
      externalKey: 'wf-1/task-1',
      status: 'queued',
      attemptCount: 1,
      summary: 'Queued fix',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    await runHeadless(['worker', 'status', '--output', 'json'], {
      logger,
      invokerConfig: {},
      persistence: {
        listWorkflows: vi.fn(() => []),
        loadTasks: vi.fn(() => []),
        getEvents: vi.fn(() => []),
        listWorkerActions: vi.fn(() => [action]),
      },
    } as never);

    const parsed = JSON.parse(stdout);
    expect(parsed.workerId).toBe('auto-fix-recovery');
    expect(parsed.recentActions).toEqual([
      expect.objectContaining({
        id: 'wa-1',
        workerKind: 'autofix',
        actionType: 'auto-fix',
        status: 'queued',
        summary: 'Queued fix',
      }),
    ]);
  });
});
