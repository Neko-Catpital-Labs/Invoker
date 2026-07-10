import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { PR_SUMMARY_REFRESH_WORKER_KIND } from '@invoker/execution-engine';
import { runHeadless } from '../headless.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(),
};
logger.child.mockReturnValue(logger);

function makeDeps(): unknown {
  return {
    logger,
    persistence: {
      enqueueWorkflowMutationIntent: vi.fn(() => 1),
      listWorkflows: vi.fn(() => []),
      loadTasks: vi.fn(() => []),
      listWorkerActions: vi.fn(() => []),
    },
    invokerConfig: {},
  };
}

describe('headless worker command', () => {
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

  it('lists the PR summary refresh worker', async () => {
    await runHeadless(['worker', 'list'], makeDeps() as never);

    expect(stdout).toContain('Worker kinds');
    expect(stdout).toContain(PR_SUMMARY_REFRESH_WORKER_KIND);
  });

  it('runs an empty PR summary refresh one-shot scan', async () => {
    await runHeadless(['worker', PR_SUMMARY_REFRESH_WORKER_KIND], makeDeps() as never);

    expect(stdout).toContain(`${PR_SUMMARY_REFRESH_WORKER_KIND} worker scan completed.`);
  });
});
