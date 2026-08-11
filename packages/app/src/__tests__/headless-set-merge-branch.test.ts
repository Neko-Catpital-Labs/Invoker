import { describe, expect, it, vi, beforeEach } from 'vitest';
import { LocalBus } from '@invoker/transport';
import type { CommandService } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';
import { headlessSetMergeBranch } from '../headless-run-resume.js';
import type { HeadlessDeps } from '../headless-shared.js';

describe('headless set merge-branch', () => {
  let mockDeps: HeadlessDeps;

  beforeEach(() => {
    const noopLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(() => noopLogger),
    };
    mockDeps = {
      logger: noopLogger as any,
      orchestrator: {
        startExecution: vi.fn(() => []),
        syncFromDb: vi.fn(),
      } as any,
      persistence: {
        readOnly: false,
        loadWorkflow: vi.fn(() => ({
          id: 'wf-1',
          name: 'test-workflow',
          generation: 0,
          status: 'running' as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })),
        loadTasks: vi.fn(() => [
          {
            id: 'wf-1/task-1',
            status: 'pending',
            config: { workflowId: 'wf-1' },
            execution: {},
          } as any,
          {
            id: 'wf-1/merge',
            status: 'failed',
            config: { workflowId: 'wf-1', isMergeNode: true },
            execution: {},
          } as any,
        ]),
        updateWorkflow: vi.fn(),
      } as unknown as SQLiteAdapter,
      commandService: {
        retryTask: vi.fn(async () => ({ ok: true as const, data: [] })),
      } as unknown as CommandService,
      executorRegistry: {} as any,
      messageBus: new LocalBus() as any,
      repoRoot: '/fake/repo',
      invokerConfig: {} as any,
      initServices: vi.fn(async () => {}),
      noTrack: true,
      ownerTaskRunnerProvider: () => ({ executeTasks: vi.fn(async () => {}) } as any),
    } as HeadlessDeps;
  });

  it('updates the workflow base branch and retries the merge task', async () => {
    await headlessSetMergeBranch('wf-1', 'fix/some-branch', mockDeps);

    expect(mockDeps.persistence.updateWorkflow).toHaveBeenCalledWith(
      'wf-1',
      { baseBranch: 'fix/some-branch' },
    );
    expect(mockDeps.commandService.retryTask).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: 'set-merge-branch',
        source: 'headless',
        scope: 'task',
        payload: { taskId: 'wf-1/merge' },
      }),
    );
  });
});
