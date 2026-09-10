import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalBus } from '@invoker/transport';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { CommandService, TaskState } from '@invoker/workflow-core';
import { runHeadless } from '../headless.js';
import type { HeadlessDeps } from '../headless-shared.js';
import { isHeadlessMutatingCommand } from '../headless-command-classification.js';
import { acknowledgeNoTrackHeadlessExec } from '../ipc/gui-mutation-handlers.js';
import { PersistedWorkflowMutationCoordinator } from '../persisted-workflow-mutation-coordinator.js';

const EXECUTION_POOLS = {
  'pool-worktree-only': { members: [{ type: 'worktree' as const, id: 'local-a' }] },
  'pool-mixed': {
    members: [{ type: 'worktree' as const, id: 'local-a' }, { type: 'ssh' as const, id: 'remote-a' }],
  },
};

const AGENT_REGISTRY = {
  listExecution: () => [{ name: 'claude' }, { name: 'codex' }],
} as unknown as HeadlessDeps['executionAgentRegistry'];

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'wf-1/task-1',
    description: 'task-1',
    status: 'pending',
    dependencies: [],
    createdAt: new Date(),
    config: { workflowId: 'wf-1', runnerKind: 'worktree', poolId: 'pool-worktree-only' },
    execution: {},
    ...overrides,
  } as unknown as TaskState;
}

function makeDeps(task: TaskState): HeadlessDeps {
  const noopLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(() => noopLogger) };
  let current = task;
  return {
    logger: noopLogger as any,
    orchestrator: {
      syncFromDb: vi.fn(),
      getTask: vi.fn(() => current),
    } as any,
    persistence: {
      readOnly: false,
      listWorkflows: vi.fn(() => [{ id: 'wf-1', name: 'wf-1', generation: 0, status: 'running' as const,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]),
      loadTasks: vi.fn(() => [current]),
    } as unknown as SQLiteAdapter,
    commandService: {
      editTaskPool: vi.fn(async () => ({ ok: true as const, data: [] })),
      editTaskAgent: vi.fn(async () => ({ ok: true as const, data: [] })),
      editTaskType: vi.fn(async () => ({ ok: true as const, data: [] })),
    } as unknown as CommandService,
    executorRegistry: {} as any,
    executionAgentRegistry: AGENT_REGISTRY,
    messageBus: new LocalBus() as any,
    repoRoot: '/fake/repo',
    invokerConfig: { executionPools: EXECUTION_POOLS } as any,
    initServices: vi.fn(async () => {}),
    noTrack: true,
  } as HeadlessDeps;
}

describe('headless route-task refusals', () => {
  it('refuses --pool on a merge node', async () => {
    const deps = makeDeps(makeTask({
      id: '__merge__wf-1',
      config: { workflowId: 'wf-1', runnerKind: 'merge', isMergeNode: true } as any,
    }));

    await expect(runHeadless(['route-task', '__merge__wf-1', '--pool', 'pool-mixed'], deps)).rejects.toThrow(
      'Cannot assign pool "pool-mixed" to merge node "__merge__wf-1": merge nodes carry no execution pool.',
    );
    expect(deps.commandService.editTaskPool).not.toHaveBeenCalled();
  });

  it('allows --agent on a merge node', async () => {
    const deps = makeDeps(makeTask({
      id: '__merge__wf-1',
      config: { workflowId: 'wf-1', runnerKind: 'merge', isMergeNode: true } as any,
    }));

    await runHeadless(['route-task', '__merge__wf-1', '--agent', 'codex'], deps);

    expect(deps.commandService.editTaskAgent).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { taskId: '__merge__wf-1', agentName: 'codex' } }),
    );
  });

  it('refuses a worktree or ssh runner without a pool', async () => {
    const deps = makeDeps(makeTask({
      config: { workflowId: 'wf-1', runnerKind: 'scratch' } as any,
    }));

    await expect(runHeadless(['route-task', 'wf-1/task-1', '--runner', 'ssh'], deps)).rejects.toThrow(
      'Cannot route task "wf-1/task-1" to runner "ssh" without a pool: worktree and ssh runners require a non-empty pool. Pass --pool <id>.',
    );
    expect(deps.commandService.editTaskType).not.toHaveBeenCalled();
  });

  it('refuses a pool that is absent from config.executionPools', async () => {
    const deps = makeDeps(makeTask());

    await expect(runHeadless(['route-task', 'wf-1/task-1', '--pool', 'pool-ghost'], deps)).rejects.toThrow(
      'Cannot route task "wf-1/task-1" to pool "pool-ghost": pool is not defined in executionPools. Available: [pool-worktree-only, pool-mixed]',
    );
    expect(deps.commandService.editTaskPool).not.toHaveBeenCalled();
  });

  it('refuses an ssh runner against an all-worktree pool', async () => {
    const deps = makeDeps(makeTask());

    await expect(
      runHeadless(['route-task', 'wf-1/task-1', '--pool', 'pool-worktree-only', '--runner', 'ssh'], deps),
    ).rejects.toThrow(
      'Cannot route task "wf-1/task-1" to pool "pool-worktree-only" with runner "ssh": the pool has no ssh member, so that combination cannot execute.',
    );
    expect(deps.commandService.editTaskPool).not.toHaveBeenCalled();
  });

  it('refuses an all-worktree pool for a task already on the ssh runner when --runner is omitted', async () => {
    const deps = makeDeps(makeTask({
      config: { workflowId: 'wf-1', runnerKind: 'ssh', poolId: 'pool-mixed', poolMemberId: 'remote-a' } as any,
    }));

    await expect(runHeadless(['route-task', 'wf-1/task-1', '--pool', 'pool-worktree-only'], deps)).rejects.toThrow(
      'Cannot route task "wf-1/task-1" to pool "pool-worktree-only" with runner "ssh": the pool has no ssh member, so that combination cannot execute.',
    );
    expect(deps.commandService.editTaskPool).not.toHaveBeenCalled();
  });

  it('refuses an agent that is absent from the execution agent registry', async () => {
    const deps = makeDeps(makeTask());

    await expect(runHeadless(['route-task', 'wf-1/task-1', '--agent', 'gemini'], deps)).rejects.toThrow(
      'Cannot route task "wf-1/task-1" to agent "gemini": no execution agent is registered under that name. Available: [claude, codex]',
    );
    expect(deps.commandService.editTaskAgent).not.toHaveBeenCalled();
  });

  it.each(['completed', 'skipped', 'closed'] as const)('refuses a %s task', async (status) => {
    const deps = makeDeps(makeTask({ status }));

    await expect(runHeadless(['route-task', 'wf-1/task-1', '--agent', 'codex'], deps)).rejects.toThrow(
      `Cannot re-route task "wf-1/task-1": it is ${status} and will not be dispatched again.`,
    );
    expect(deps.commandService.editTaskAgent).not.toHaveBeenCalled();
  });

  it('refuses a running task without --force', async () => {
    const deps = makeDeps(makeTask({ status: 'running' }));

    await expect(runHeadless(['route-task', 'wf-1/task-1', '--agent', 'codex'], deps)).rejects.toThrow(
      'Cannot re-route task "wf-1/task-1" while it is running because the launched attempt already resolved its agent. Pass --force to re-route anyway.',
    );
    expect(deps.commandService.editTaskAgent).not.toHaveBeenCalled();
  });

  it('routes a running task when --force is given', async () => {
    const deps = makeDeps(makeTask({ status: 'running' }));

    await runHeadless(['route-task', 'wf-1/task-1', '--agent', 'codex', '--force'], deps);

    expect(deps.commandService.editTaskAgent).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { taskId: 'wf-1/task-1', agentName: 'codex' } }),
    );
  });

  it('refuses a terminal task even when --force is given', async () => {
    const deps = makeDeps(makeTask({ status: 'completed' }));

    await expect(runHeadless(['route-task', 'wf-1/task-1', '--agent', 'codex', '--force'], deps)).rejects.toThrow(
      'Cannot re-route task "wf-1/task-1": it is completed and will not be dispatched again.',
    );
  });
});

describe('headless route-task applies each flag', () => {
  let deps: HeadlessDeps;

  beforeEach(() => {
    deps = makeDeps(makeTask());
  });

  it('routes --agent through editTaskAgent', async () => {
    await runHeadless(['route-task', 'wf-1/task-1', '--agent', 'codex'], deps);

    expect(deps.commandService.editTaskAgent).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { taskId: 'wf-1/task-1', agentName: 'codex' } }),
    );
    expect(deps.commandService.editTaskPool).not.toHaveBeenCalled();
    expect(deps.commandService.editTaskType).not.toHaveBeenCalled();
  });

  it('routes --pool through editTaskPool', async () => {
    await runHeadless(['route-task', 'wf-1/task-1', '--pool', 'pool-mixed'], deps);

    expect(deps.commandService.editTaskPool).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { taskId: 'wf-1/task-1', poolId: 'pool-mixed' } }),
    );
  });

  it('routes --runner through editTaskType', async () => {
    deps = makeDeps(makeTask({
      config: { workflowId: 'wf-1', runnerKind: 'worktree', poolId: 'pool-mixed' } as any,
    }));

    await runHeadless(['route-task', 'wf-1/task-1', '--runner', 'ssh'], deps);

    expect(deps.commandService.editTaskType).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { taskId: 'wf-1/task-1', runnerKind: 'ssh', poolMemberId: undefined } }),
    );
  });

  it('routes --clear-member through editTaskType without changing the runner', async () => {
    deps = makeDeps(makeTask({
      config: { workflowId: 'wf-1', runnerKind: 'ssh', poolId: 'pool-mixed', poolMemberId: 'remote-a' } as any,
    }));

    await runHeadless(['route-task', 'wf-1/task-1', '--clear-member'], deps);

    expect(deps.commandService.editTaskType).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { taskId: 'wf-1/task-1', runnerKind: 'ssh', poolMemberId: undefined } }),
    );
  });

  it('skips editTaskType when --clear-member has no pinned member to clear', async () => {
    await runHeadless(['route-task', 'wf-1/task-1', '--clear-member'], deps);

    expect(deps.commandService.editTaskType).not.toHaveBeenCalled();
  });

  it('applies pool, runner, and agent in one invocation', async () => {
    deps = makeDeps(makeTask({
      config: { workflowId: 'wf-1', runnerKind: 'worktree', poolId: 'pool-worktree-only' } as any,
    }));

    await runHeadless(
      ['route-task', 'wf-1/task-1', '--pool', 'pool-mixed', '--runner', 'ssh', '--agent', 'codex'],
      deps,
    );

    expect(deps.commandService.editTaskPool).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { taskId: 'wf-1/task-1', poolId: 'pool-mixed' } }),
    );
    expect(deps.commandService.editTaskType).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { taskId: 'wf-1/task-1', runnerKind: 'ssh', poolMemberId: undefined } }),
    );
    expect(deps.commandService.editTaskAgent).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { taskId: 'wf-1/task-1', agentName: 'codex' } }),
    );
  });

  it('rejects an invocation with no routing flags', async () => {
    await expect(runHeadless(['route-task', 'wf-1/task-1'], deps)).rejects.toThrow('Nothing to change.');
  });

  it('skips the command when delete-all removed every workflow', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    deps.persistence.listWorkflows = vi.fn(() => []) as any;
    deps.persistence.loadTasks = vi.fn(() => []) as any;

    await runHeadless(['route-task', 'wf-1/task-1', '--agent', 'codex'], deps);

    expect(write.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain(
      'route-task skipped: task "wf-1/task-1" was removed by delete-all.',
    );
    expect(deps.commandService.editTaskAgent).not.toHaveBeenCalled();
    write.mockRestore();
  });
});

describe('headless route-task delegation shape', () => {
  it('is a registered mutating headless command', () => {
    expect(isHeadlessMutatingCommand(['route-task'])).toBe(true);
  });

  it('is executed rather than acknowledged as a queued intent, so refusals reach the caller', () => {
    const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const submit = vi.fn();

    const result = acknowledgeNoTrackHeadlessExec(
      { args: ['route-task', 'wf-1/task-1', '--agent', 'codex'], noTrack: false },
      'wf-1',
      'high',
      'gui',
      {
        ownerId: 'owner-1',
        getWorkflowMutationCoordinator: () => ({ submit }) as never,
        workflowExists: () => true,
        logger: logger as never,
      },
    );

    expect(result).toBeUndefined();
    expect(submit).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('would swallow refusals if it were sent as a fire-and-forget no-track mutation', () => {
    const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };

    const result = acknowledgeNoTrackHeadlessExec(
      { args: ['route-task', 'wf-1/task-1', '--agent', 'codex'], noTrack: true },
      'wf-1',
      'high',
      'gui',
      {
        ownerId: 'owner-1',
        getWorkflowMutationCoordinator: () => ({ submit: vi.fn(() => 7) }) as never,
        workflowExists: () => true,
        logger: logger as never,
      },
    );

    expect(result).toEqual(expect.objectContaining({ workflowId: 'wf-1' }));
  });
  it('attributes a failed route-task intent to its target task, like every other task-scoped command', () => {
    const persistence = {
      loadWorkflow: () => undefined,
      listWorkflows: () => [],
      loadTasks: () => [],
    } as any;
    const coordinator = new PersistedWorkflowMutationCoordinator(persistence, 'owner-1', async () => undefined);
    const resolve = (args: string[]): string | undefined =>
      (coordinator as any).resolveHeadlessIntentFailureTaskId([{ args }]);

    expect(resolve(['route-task', 'wf-1/task-1', '--agent', 'codex'])).toBe('wf-1/task-1');
    expect(resolve(['retry-task', 'wf-1/task-1'])).toBe('wf-1/task-1');
  });
});
