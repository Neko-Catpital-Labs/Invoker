import { describe, expect, it, vi, beforeEach } from 'vitest';
import { runHeadless } from '../headless.js';
import type { HeadlessDeps } from '../headless-shared.js';
import { LocalBus } from '@invoker/transport';
import type { CommandService } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';

const REMOVED_POOL_SUBCOMMAND = ['task', 'pool'].join('-');

describe('headless set pool', () => {
  let mockDeps: HeadlessDeps;

  beforeEach(() => {
    const noopLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(() => noopLogger) };
    mockDeps = {
      logger: noopLogger as any,
      orchestrator: { syncFromDb: vi.fn() } as any,
      persistence: {
        readOnly: false,
        listWorkflows: vi.fn(() => [{ id: 'wf-1', name: 'test-workflow', generation: 0,
          status: 'running' as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]),
        loadTasks: vi.fn(() => [{ id: 'wf-1/task-1', status: 'pending',
          config: { workflowId: 'wf-1' }, execution: {} } as any]),
      } as unknown as SQLiteAdapter,
      commandService: {
        editTaskPool: vi.fn(async () => ({ ok: true as const, data: [] })),
        editTaskType: vi.fn(),
      } as unknown as CommandService,
      executorRegistry: {} as any,
      messageBus: new LocalBus() as any,
      repoRoot: '/fake/repo',
      invokerConfig: {} as any,
      initServices: vi.fn(async () => {}),
      noTrack: true,
    } as HeadlessDeps;
  });

  it('calls commandService.editTaskPool with the resolved task id and poolId', async () => {
    await runHeadless(['set', 'pool', 'wf-1/task-1', 'local-mac-only'], mockDeps);
    expect(mockDeps.commandService.editTaskPool).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { taskId: 'wf-1/task-1', poolId: 'local-mac-only' } }),
    );
  });

  it('throws a clear error when taskId or poolId is missing', async () => {
    await expect(runHeadless(['set', 'pool', 'wf-1/task-1'], mockDeps)).rejects.toThrow(
      'Missing arguments. Usage: --headless set pool <taskId> <poolId>',
    );
  });

  it('never calls commandService.editTaskType for a pool name', async () => {
    await runHeadless(['set', 'pool', 'wf-1/task-1', 'local-mac-only'], mockDeps);
    expect(mockDeps.commandService.editTaskType).not.toHaveBeenCalled();
  });

  it('rejects the removed pool subcommand alias without calling editTaskPool', async () => {
    await expect(runHeadless(['set', REMOVED_POOL_SUBCOMMAND, 'wf-1/task-1', 'local-mac-only'], mockDeps)).rejects.toThrow();
    expect(mockDeps.commandService.editTaskPool).not.toHaveBeenCalled();
  });
});
