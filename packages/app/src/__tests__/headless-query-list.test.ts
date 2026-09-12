import { describe, expect, it, vi } from 'vitest';
import type { WorkerActionRecord } from '@invoker/data-store';
import {
  runReadOnlyHeadlessQueryToString,
  type HeadlessQueryDeps,
} from '../headless-query-list.js';

const workerActions: WorkerActionRecord[] = [
  {
    id: 'wa-1',
    workerKind: 'autofix',
    actionType: 'fix-task',
    workflowId: 'wf-1',
    taskId: 'wf-1/task-1',
    subjectType: 'task',
    subjectId: 'wf-1/task-1',
    externalKey: 'wf-1/task-1:g0:a1',
    status: 'completed',
    attemptCount: 2,
    intentId: '42',
    agentName: 'codex',
    executionModel: 'gpt-5.2',
    sessionId: 'sess-1',
    summary: 'Fixed failing tests',
    payload: { result: 'ok' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:05:00.000Z',
    completedAt: '2026-01-01T00:05:00.000Z',
  },
];

function makeQueryDeps(): HeadlessQueryDeps {
  return {
    persistence: {
      listWorkerActions: (filters?: unknown) => {
        if (filters && (filters as { workflowId?: string }).workflowId === 'missing') return [];
        return workerActions;
      },
      listTaskEvents: () => [],
      listWorkflows: () => [],
    } as unknown as HeadlessQueryDeps['persistence'],
    orchestrator: {} as unknown as HeadlessQueryDeps['orchestrator'],
    executionAgentRegistry: undefined,
    invokerConfig: {} as unknown as HeadlessQueryDeps['invokerConfig'],
    getUiPerfStats: () => ({}),
    resetUiPerfStats: () => {},
  };
}

describe('headless query workers', () => {
  it('returns the local worker fleet snapshot as JSON', async () => {
    const output = await runReadOnlyHeadlessQueryToString(
      ['query', 'workers', '--output', 'json'],
      makeQueryDeps(),
    );

    const parsed = JSON.parse(output) as {
      generatedAt?: unknown;
      workers?: Array<Record<string, unknown>>;
    };
    expect(typeof parsed.generatedAt).toBe('string');
    expect(Array.isArray(parsed.workers)).toBe(true);
    const autoFixWorker = parsed.workers?.find((worker) => worker.kind === 'autofix');
    expect(autoFixWorker).toMatchObject({
      kind: 'autofix',
      lifecycle: 'stopped',
      policy: 'unknown',
      startable: false,
      stoppable: false,
      controlDisabledReason: 'Controls unavailable',
      source: 'built-in',
      availability: 'available',
    });
    expect(autoFixWorker).not.toHaveProperty('running');
    expect(autoFixWorker?.recentActions).toEqual(workerActions.map((action) => expect.objectContaining({ id: action.id })));
  });
});

describe('headless query worker-actions', () => {
  it('renders worker actions as JSON', async () => {
    const output = await runReadOnlyHeadlessQueryToString(
      ['query', 'worker-actions', '--workflow', 'wf-1', '--output', 'json'],
      makeQueryDeps(),
    );

    expect(JSON.parse(output)).toEqual([{
      id: 'wa-1',
      workerKind: 'autofix',
      actionType: 'fix-task',
      workflowId: 'wf-1',
      taskId: 'wf-1/task-1',
      subjectType: 'task',
      subjectId: 'wf-1/task-1',
      externalKey: 'wf-1/task-1:g0:a1',
      status: 'completed',
      attemptCount: 2,
      intentId: '42',
      agentName: 'codex',
      executionModel: 'gpt-5.2',
      sessionId: 'sess-1',
      summary: 'Fixed failing tests',
      payload: { result: 'ok' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:05:00.000Z',
      completedAt: '2026-01-01T00:05:00.000Z',
    }]);
  });

  it('renders worker actions as text and handles an empty result', async () => {
    const text = await runReadOnlyHeadlessQueryToString(
      ['query', 'worker-actions'],
      makeQueryDeps(),
    );
    expect(text).toContain('Worker actions (1)');
    expect(text).toContain('wa-1');
    expect(text).toContain('autofix/fix-task');

    const empty = await runReadOnlyHeadlessQueryToString(
      ['query', 'worker-actions', '--workflow', 'missing'],
      makeQueryDeps(),
    );
    expect(empty).toContain('No worker actions found');
  });
});

const decisionActions: WorkerActionRecord[] = [
  {
    id: 'wd-1',
    workerKind: 'autofix',
    actionType: 'fix-task',
    workflowId: 'wf-1',
    subjectType: 'task',
    subjectId: 'wf-1/task-2',
    externalKey: 'wf-1/task-2:g0:a1',
    status: 'skipped',
    attemptCount: 3,
    payload: { reason: 'worker-retry-budget-exhausted' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:02:00.000Z',
  },
];

function makeDecisionDeps(): HeadlessQueryDeps {
  return {
    persistence: {
      listWorkerActions: () => decisionActions,
      listWorkflows: () => [],
    } as unknown as HeadlessQueryDeps['persistence'],
    orchestrator: {} as unknown as HeadlessQueryDeps['orchestrator'],
    executionAgentRegistry: undefined,
    invokerConfig: {} as unknown as HeadlessQueryDeps['invokerConfig'],
    getUiPerfStats: () => ({}),
    resetUiPerfStats: () => {},
  };
}

describe('headless query worker-decisions', () => {
  it('surfaces decision class and reason as JSON', async () => {
    const output = await runReadOnlyHeadlessQueryToString(
      ['query', 'worker-decisions', '--workflow', 'wf-1', '--decision', 'skip', '--output', 'json'],
      makeDecisionDeps(),
    );

    const parsed = JSON.parse(output) as Array<{ decision?: string; reason?: string }>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].decision).toBe('skip');
    expect(parsed[0].reason).toBe('worker-retry-budget-exhausted');
  });

  it('rejects an invalid --decision value', async () => {
    await expect(
      runReadOnlyHeadlessQueryToString(
        ['query', 'worker-decisions', '--decision', 'bogus'],
        makeDecisionDeps(),
      ),
    ).rejects.toThrow('Invalid --decision');
  });
});

function makeTaskQueryDeps(overrides: {
  taskOutput?: string;
  containerId?: string | null;
}): HeadlessQueryDeps {
  return {
    persistence: {
      listWorkflows: () => [{ id: 'wf-1' }],
      loadTasks: (workflowId: string) =>
        workflowId === 'wf-1' ? [{ id: 'wf-1/task-1' }] : [],
      getTaskOutput: () => overrides.taskOutput ?? '',
      getContainerId: () => overrides.containerId ?? null,
    } as unknown as HeadlessQueryDeps['persistence'],
    orchestrator: {
      syncFromDb: () => {},
    } as unknown as HeadlessQueryDeps['orchestrator'],
    executionAgentRegistry: undefined,
    invokerConfig: {} as unknown as HeadlessQueryDeps['invokerConfig'],
    getUiPerfStats: () => ({}),
    resetUiPerfStats: () => {},
  };
}

describe('headless query task filters', () => {
  it('validates and delegates a filter while composing legacy task flags', async () => {
    const task = {
      id: 'wf-1/task-1', description: 'filtered task', status: 'failed', dependencies: [],
      createdAt: new Date('2026-01-01T00:00:00.000Z'), config: { workflowId: 'wf-1', isMergeNode: false },
      execution: {}, taskStateVersion: 1,
    } as any;
    const queryTasksByFilter = vi.fn(() => [task]);
    const deps = {
      ...makeTaskQueryDeps({}),
      persistence: { queryTasksByFilter } as any,
      orchestrator: { getWorkflowStatus: () => ({ total: 1, completed: 0, failed: 1, running: 0, pending: 0 }) } as any,
    };
    const output = await runReadOnlyHeadlessQueryToString(
      ['query', 'tasks', '--filter', JSON.stringify({ op: 'eq', key: 'description', value: 'filtered task' }), '--workflow', 'wf-1', '--status', 'failed', '--no-merge', '--output', 'json'],
      deps,
    );
    expect(JSON.parse(output)).toEqual([expect.objectContaining({ id: task.id })]);
    expect(queryTasksByFilter).toHaveBeenCalledWith({ op: 'and', filters: [
      { op: 'eq', key: 'description', value: 'filtered task' },
      { op: 'eq', key: 'workflow_id', value: 'wf-1' },
      { op: 'eq', key: 'status', value: 'failed' },
      { op: 'eq', key: 'is_merge_node', value: false },
    ] }, { limit: 500, offset: 0 });
  });

  it('prefers the positional workflow id over the flag default when composing a filter', async () => {
    const task = {
      id: 'wf-1/task-1', description: 'filtered task', status: 'failed', dependencies: [],
      createdAt: new Date('2026-01-01T00:00:00.000Z'), config: { workflowId: 'wf-1', isMergeNode: false },
      execution: {}, taskStateVersion: 1,
    } as any;
    const queryTasksByFilter = vi.fn(() => [task]);
    const deps = {
      ...makeTaskQueryDeps({}),
      persistence: { queryTasksByFilter } as any,
      orchestrator: { getWorkflowStatus: () => ({ total: 1, completed: 0, failed: 1, running: 0, pending: 0 }) } as any,
    };
    await runReadOnlyHeadlessQueryToString(
      ['query', 'tasks', 'wf-1', '--filter', JSON.stringify({ op: 'eq', key: 'description', value: 'filtered task' })],
      deps,
    );
    expect(queryTasksByFilter).toHaveBeenCalledWith({ op: 'and', filters: [
      { op: 'eq', key: 'description', value: 'filtered task' },
      { op: 'eq', key: 'workflow_id', value: 'wf-1' },
    ] }, { limit: 500, offset: 0 });
  });

  it('pages through filtered results past the persistence default page size', async () => {
    const makeTask = (id: string) => ({
      id: `wf-1/${id}`, description: id, status: 'failed', dependencies: [],
      createdAt: new Date('2026-01-01T00:00:00.000Z'), config: { workflowId: 'wf-1', isMergeNode: false },
      execution: {}, taskStateVersion: 1,
    } as any);
    const firstPage = Array.from({ length: 500 }, (_, i) => makeTask(`task-${i}`));
    const secondPage = [makeTask('task-500')];
    const queryTasksByFilter = vi.fn()
      .mockReturnValueOnce(firstPage)
      .mockReturnValueOnce(secondPage);
    const deps = {
      ...makeTaskQueryDeps({}),
      persistence: { queryTasksByFilter } as any,
      orchestrator: { getWorkflowStatus: () => ({ total: 501, completed: 0, failed: 501, running: 0, pending: 0 }) } as any,
    };
    const output = await runReadOnlyHeadlessQueryToString(
      ['query', 'tasks', '--filter', JSON.stringify({ op: 'eq', key: 'status', value: 'failed' }), '--output', 'json'],
      deps,
    );
    expect(JSON.parse(output)).toHaveLength(501);
    expect(queryTasksByFilter).toHaveBeenCalledTimes(2);
    expect(queryTasksByFilter).toHaveBeenNthCalledWith(1, { op: 'eq', key: 'status', value: 'failed' }, { limit: 500, offset: 0 });
    expect(queryTasksByFilter).toHaveBeenNthCalledWith(2, { op: 'eq', key: 'status', value: 'failed' }, { limit: 500, offset: 500 });
  });

  it('rejects an invalid filter before reading persistence', async () => {
    const queryTasksByFilter = vi.fn();
    const deps = { ...makeTaskQueryDeps({}), persistence: { queryTasksByFilter } as any };
    await expect(runReadOnlyHeadlessQueryToString(
      ['query', 'tasks', '--filter', JSON.stringify({ op: 'eq', key: 'not_a_column', value: 'x' })], deps,
    )).rejects.toThrow('taskFilter.key');
    expect(queryTasksByFilter).not.toHaveBeenCalled();
  });

  it('rejects --filter on a non-task query subcommand', async () => {
    const queryTasksByFilter = vi.fn();
    const deps = { ...makeTaskQueryDeps({}), persistence: { queryTasksByFilter } as any };
    await expect(runReadOnlyHeadlessQueryToString(
      ['query', 'workflows', '--filter', JSON.stringify({ op: 'eq', key: 'status', value: 'x' })], deps,
    )).rejects.toThrow('--filter is only supported for `query tasks`');
    expect(queryTasksByFilter).not.toHaveBeenCalled();
  });
});

describe('headless query capacity', () => {
  function makeCapacityDeps() {
    const future = new Date(Date.now() + 60_000).toISOString();
    const workflows = [
      { id: 'wf-1', name: 'CI regression: 34fe981-e2e-proof-shard-2', status: 'running', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'wf-2', name: 'CI regression: 7403cfd-e2e-proof-shard-2', status: 'running', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'wf-3', name: 'Investigate admin-bypass e2e babysit intervention', status: 'running', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    ] as any;
    const makeTask = (id: string, workflowId: string, status: string, createdAt: string, isMergeNode = false) => ({
      id, description: id, status, dependencies: [],
      createdAt: new Date(createdAt), config: { workflowId, isMergeNode },
      execution: {}, taskStateVersion: 1,
    } as any);
    const tasks = [
      makeTask('wf-1/fix-ci', 'wf-1', 'queued', '2026-01-01T00:10:00.000Z'),
      makeTask('wf-2/fix-ci', 'wf-2', 'pending', '2026-01-01T00:05:00.000Z'),
      makeTask('wf-3/investigate-finding-1', 'wf-3', 'queued', '2026-01-01T00:20:00.000Z'),
      makeTask('wf-3/investigate-finding-2', 'wf-3', 'pending', '2026-01-01T00:20:01.000Z'),
      makeTask('wf-1/__merge__', 'wf-1', 'pending', '2026-01-01T00:00:00.000Z', true),
      makeTask('wf-1/done', 'wf-1', 'completed', '2026-01-01T00:00:00.000Z'),
    ];
    return {
      ...makeQueryDeps(),
      persistence: {
        loadWorkflowTaskSnapshot: () => ({ workflows, tasks, tasksByWorkflowId: new Map() }),
        listExecutionResourceLeases: () => [
          {
            resourceKey: 'ssh:do3', resourceType: 'ssh', holderId: 'runner:do3',
            taskId: 'wf-9/running-1', poolId: 'mixed-local-ssh', poolMemberId: 'remote_digital_ocean_3',
            acquiredAt: future, lastHeartbeatAt: future, leaseExpiresAt: future,
          },
          {
            resourceKey: 'ssh:do3-b', resourceType: 'ssh', holderId: 'runner:do3-b',
            taskId: 'wf-9/running-2', poolId: 'mixed-local-ssh', poolMemberId: 'remote_digital_ocean_3',
            acquiredAt: future, lastHeartbeatAt: future, leaseExpiresAt: future,
          },
        ],
      } as unknown as HeadlessQueryDeps['persistence'],
      invokerConfig: {
        executionPools: {
          'mixed-local-ssh': {
            members: [
              { type: 'ssh', id: 'remote_digital_ocean_3' },
              { type: 'ssh', id: 'remote_digital_ocean_5' },
            ],
            maxConcurrentTasksPerMember: 2,
          },
        },
      } as unknown as HeadlessQueryDeps['invokerConfig'],
    };
  }

  it('reports per-member slot usage, queue depth grouped by workflow prefix, and the oldest waiting task', async () => {
    const output = await runReadOnlyHeadlessQueryToString(
      ['query', 'capacity', '--output', 'json'],
      makeCapacityDeps(),
    );
    const report = JSON.parse(output);

    expect(report.pools).toEqual([
      {
        poolId: 'mixed-local-ssh',
        maxConcurrentTasksPerMember: 2,
        members: [
          { memberId: 'remote_digital_ocean_3', maxConcurrentTasks: 2, inUse: 2, full: true },
          { memberId: 'remote_digital_ocean_5', maxConcurrentTasks: 2, inUse: 0, full: false },
        ],
      },
    ]);

    expect(report.totalQueued).toBe(4);
    expect(report.queueByWorkflowPrefix).toEqual([
      { prefix: 'CI regression', queuedTasks: 2, workflowCount: 2 },
      { prefix: 'Investigate admin-bypass e2e babysit intervention', queuedTasks: 2, workflowCount: 1 },
    ]);

    expect(report.oldestWaiting).toMatchObject({
      taskId: 'wf-2/fix-ci',
      workflowId: 'wf-2',
      createdAt: '2026-01-01T00:05:00.000Z',
    });
  });

  it('excludes merge-gate tasks and completed tasks from queue depth', async () => {
    const output = await runReadOnlyHeadlessQueryToString(
      ['query', 'capacity', '--output', 'json'],
      makeCapacityDeps(),
    );
    const report = JSON.parse(output);
    const allPrefixedTaskCounts = report.queueByWorkflowPrefix.reduce((sum: number, entry: { queuedTasks: number }) => sum + entry.queuedTasks, 0);
    expect(allPrefixedTaskCounts).toBe(4);
  });

  it('renders a human-readable text report', async () => {
    const output = await runReadOnlyHeadlessQueryToString(
      ['query', 'capacity'],
      makeCapacityDeps(),
    );
    expect(output).toContain('mixed-local-ssh');
    expect(output).toContain('remote_digital_ocean_3: 2/2 (FULL)');
    expect(output).toContain('remote_digital_ocean_5: 0/2');
    expect(output).toContain('OLDEST WAITING: wf-2/fix-ci');
  });
});

describe('headless query task-output', () => {
  it('prints the task output for a short task id', async () => {
    const output = await runReadOnlyHeadlessQueryToString(
      ['query', 'task-output', 'task-1'],
      makeTaskQueryDeps({ taskOutput: 'build ok\n' }),
    );
    expect(output).toBe('build ok\n');
  });

  it('emits the resolved id and output as JSON', async () => {
    const output = await runReadOnlyHeadlessQueryToString(
      ['query', 'task-output', 'task-1', '--output', 'json'],
      makeTaskQueryDeps({ taskOutput: 'log line' }),
    );
    expect(JSON.parse(output)).toEqual({ id: 'wf-1/task-1', output: 'log line' });
  });
});

describe('headless query container-id', () => {
  it('prints the container id for a short task id', async () => {
    const output = await runReadOnlyHeadlessQueryToString(
      ['query', 'container-id', 'task-1'],
      makeTaskQueryDeps({ containerId: 'container-abc' }),
    );
    expect(output).toBe('container-abc\n');
  });

  it('prints an empty line when there is no container', async () => {
    const output = await runReadOnlyHeadlessQueryToString(
      ['query', 'container-id', 'task-1'],
      makeTaskQueryDeps({ containerId: null }),
    );
    expect(output).toBe('\n');
  });
});

describe('headless query execution-leases', () => {
  it('lists live leases as JSON and hides expired rows', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    const output = await runReadOnlyHeadlessQueryToString(
      ['query', 'execution-leases', '--output', 'json'],
      {
        ...makeQueryDeps(),
        persistence: {
          listExecutionResourceLeases: () => [
            {
              resourceKey: 'ssh:invoker@shared.example.com:22',
              resourceType: 'ssh',
              holderId: 'runner:1:wf-1/t1:attempt',
              taskId: 'wf-1/t1',
              poolId: 'pnpm-ssh',
              poolMemberId: 'remote-shared',
              acquiredAt: future,
              lastHeartbeatAt: future,
              leaseExpiresAt: future,
            },
            {
              resourceKey: 'ssh:invoker@expired.example.com:22',
              resourceType: 'ssh',
              holderId: 'dead',
              acquiredAt: past,
              lastHeartbeatAt: past,
              leaseExpiresAt: past,
            },
          ],
        } as unknown as HeadlessQueryDeps['persistence'],
      },
    );

    expect(JSON.parse(output)).toEqual([
      {
        resourceKey: 'ssh:invoker@shared.example.com:22',
        resourceType: 'ssh',
        poolId: 'pnpm-ssh',
        poolMemberId: 'remote-shared',
        taskId: 'wf-1/t1',
        holderId: 'runner:1:wf-1/t1:attempt',
        acquiredAt: future,
        lastHeartbeatAt: future,
        leaseExpiresAt: future,
      },
    ]);
  });
});
