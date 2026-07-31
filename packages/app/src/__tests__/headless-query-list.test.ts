import { describe, expect, it } from 'vitest';
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
