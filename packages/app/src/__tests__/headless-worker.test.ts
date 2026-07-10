import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { PR_SUMMARY_REFRESH_WORKER_KIND } from '@invoker/execution-engine';
import { runHeadless } from '../headless.js';

describe('headless worker registry', () => {
  let homeRoot: string;
  let previousDbDir: string | undefined;
  let write: MockInstance;
  let stdout: string;

  beforeEach(() => {
    homeRoot = mkdtempSync(join(tmpdir(), 'invoker-headless-worker-home-'));
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

  it('lists pr-summary-refresh as a manual worker kind', async () => {
    await runHeadless(['worker', 'list'], { invokerConfig: {} } as never);

    expect(stdout).toContain('Worker kinds');
    expect(stdout).toContain(PR_SUMMARY_REFRESH_WORKER_KIND);
  });

  it('runs pr-summary-refresh one-shot when there are no merge tasks to refresh', async () => {
    await runHeadless(['worker', PR_SUMMARY_REFRESH_WORKER_KIND], {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn() },
      repoRoot: '/repo',
      invokerConfig: {},
      persistence: {
        listWorkflows: vi.fn(() => []),
        loadTasks: vi.fn(() => []),
        enqueueWorkflowMutationIntent: vi.fn(() => 1),
      },
    } as never);

    expect(stdout).toContain(`${PR_SUMMARY_REFRESH_WORKER_KIND} worker scan completed.`);
  });
});
