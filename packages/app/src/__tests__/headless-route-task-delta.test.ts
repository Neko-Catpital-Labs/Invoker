import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import { CommandService, Orchestrator } from '@invoker/workflow-core';
import type { TaskState } from '@invoker/workflow-core';
import { runHeadless } from '../headless.js';
import type { HeadlessDeps } from '../headless-shared.js';

const TASK_DELTA_CHANNEL = 'task.delta';

const EXECUTION_POOLS = {
  'pool-mixed': {
    members: [{ type: 'worktree' as const, id: 'local-a' }, { type: 'ssh' as const, id: 'remote-a' }],
  },
};

describe('headless route-task publishes on TASK_DELTA_CHANNEL', () => {
  let dbDir: string | undefined;

  afterEach(() => {
    if (dbDir) rmSync(dbDir, { recursive: true, force: true });
    dbDir = undefined;
    vi.restoreAllMocks();
  });

  it('persists the new routing and publishes a task delta for every applied flag', async () => {
    dbDir = mkdtempSync(join(tmpdir(), 'invoker-route-task-delta-'));
    const persistence = await SQLiteAdapter.create(join(dbDir, 'invoker.db'), { ownerCapability: true });
    try {
      const nowIso = new Date().toISOString();
      persistence.saveWorkflow({
        id: 'wf-1',
        name: 'wf-1',
        repoUrl: 'https://example.invalid/repo.git',
        createdAt: nowIso,
        updatedAt: nowIso,
      } as any);
      persistence.saveTask('wf-1', {
        id: 'wf-1/task-1',
        description: 'task-1',
        status: 'pending',
        dependencies: [],
        createdAt: new Date(),
        config: {
          workflowId: 'wf-1',
          runnerKind: 'worktree',
          poolId: 'pool-mixed',
          command: 'echo hi',
          executionAgent: 'claude',
        },
        execution: {},
      } as unknown as TaskState);

      const published: Array<{ channel: string; payload: unknown }> = [];
      const messageBus = { publish: (channel: string, payload: unknown) => { published.push({ channel, payload }); } };
      const orchestrator = new Orchestrator({
        persistence: persistence as any,
        messageBus,
        availablePoolIds: ['pool-mixed'],
      });
      orchestrator.syncAllFromDb();
      const commandService = new CommandService(orchestrator);

      const noopLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(() => noopLogger) };
      const deps = {
        logger: noopLogger as any,
        orchestrator,
        persistence,
        commandService,
        executorRegistry: {} as any,
        executionAgentRegistry: { listExecution: () => [{ name: 'claude' }, { name: 'codex' }] } as any,
        messageBus: messageBus as any,
        repoRoot: '/fake/repo',
        invokerConfig: { executionPools: EXECUTION_POOLS } as any,
        initServices: vi.fn(async () => {}),
        noTrack: true,
      } as unknown as HeadlessDeps;

      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      await runHeadless(['route-task', 'wf-1/task-1', '--runner', 'ssh', '--agent', 'codex'], deps);

      const deltas = published.filter((entry) => entry.channel === TASK_DELTA_CHANNEL);
      expect(deltas.length).toBeGreaterThanOrEqual(2);
      const changedConfigs = deltas
        .map((entry) => (entry.payload as { changes?: { config?: Record<string, unknown> } }).changes?.config)
        .filter((config): config is Record<string, unknown> => Boolean(config));
      expect(changedConfigs).toContainEqual(expect.objectContaining({ runnerKind: 'ssh' }));
      expect(changedConfigs).toContainEqual(expect.objectContaining({ executionAgent: 'codex' }));

      const reloaded = persistence.loadTasks('wf-1').find((task) => task.id === 'wf-1/task-1');
      expect(reloaded?.config.runnerKind).toBe('ssh');
      expect(reloaded?.config.poolId).toBe('pool-mixed');
      expect(reloaded?.config.executionAgent).toBe('codex');
    } finally {
      persistence.close();
    }
  });
  it('refuses a merge-node pool assignment that the database trigger would abort', async () => {
    dbDir = mkdtempSync(join(tmpdir(), 'invoker-route-task-trigger-'));
    const persistence = await SQLiteAdapter.create(join(dbDir, 'invoker.db'), { ownerCapability: true });
    try {
      const nowIso = new Date().toISOString();
      persistence.saveWorkflow({ id: 'wf-1', name: 'wf-1', createdAt: nowIso, updatedAt: nowIso } as any);
      persistence.saveTask('wf-1', {
        id: '__merge__wf-1',
        description: 'merge',
        status: 'pending',
        dependencies: [],
        createdAt: new Date(),
        config: { workflowId: 'wf-1', runnerKind: 'merge', isMergeNode: true },
        execution: {},
      } as unknown as TaskState);

      const messageBus = { publish: () => {} };
      const orchestrator = new Orchestrator({
        persistence: persistence as any,
        messageBus,
        availablePoolIds: ['pool-mixed'],
      });
      orchestrator.syncAllFromDb();

      const noopLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(() => noopLogger) };
      const deps = {
        logger: noopLogger as any,
        orchestrator,
        persistence,
        commandService: new CommandService(orchestrator),
        executorRegistry: {} as any,
        executionAgentRegistry: { listExecution: () => [{ name: 'claude' }] } as any,
        messageBus: messageBus as any,
        repoRoot: '/fake/repo',
        invokerConfig: { executionPools: EXECUTION_POOLS } as any,
        initServices: vi.fn(async () => {}),
        noTrack: true,
      } as unknown as HeadlessDeps;

      await expect(runHeadless(['route-task', '__merge__wf-1', '--pool', 'pool-mixed'], deps)).rejects.toThrow(
        'merge nodes carry no execution pool',
      );

      expect(() => (persistence as any).db.run(
        "UPDATE tasks SET pool_id = 'pool-mixed' WHERE id = '__merge__wf-1'",
      )).toThrow('tasks executor routing invariant violated');

      const reloaded = persistence.loadTasks('wf-1').find((task) => task.id === '__merge__wf-1');
      expect(reloaded?.config.runnerKind).toBe('merge');
    } finally {
      persistence.close();
    }
  });
});
