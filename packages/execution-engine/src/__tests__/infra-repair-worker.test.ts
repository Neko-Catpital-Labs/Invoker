import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  WorkerActionRecord,
  WorkerActionWrite,
  WorkflowMutationPriority,
} from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import {
  createInfraRepairTick,
  INFRA_REPAIR_RECREATE_TASK_CHANNEL,
  INFRA_REPAIR_RETRY_TASK_CHANNEL,
  INFRA_REPAIR_WORKER_KIND,
  listInfraRepairScanCandidates,
  parseInfraRepairRecreateTaskMutationArgs,
  parseInfraRepairRetryTaskMutationArgs,
} from '../workers/infra-repair-worker.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
};

const POLL_CTX = {
  identity: { kind: INFRA_REPAIR_WORKER_KIND, instanceId: 'test' },
  reason: 'poll' as const,
  tickNumber: 1,
  signal: new AbortController().signal,
};

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  const { config, execution, ...rest } = overrides;
  return {
    id: 'wf-1/task-1',
    description: 'repair me',
    status: 'failed',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: {
      workflowId: 'wf-1',
      runnerKind: 'ssh',
      poolMemberId: 'remote-1',
      command: 'pnpm test',
      ...(config ?? {}),
    },
    execution: {
      generation: 2,
      selectedAttemptId: 'attempt-1',
      branch: 'feature/task-1',
      workspacePath: '~/.invoker/worktrees/repo/task-1',
      error: 'Executor startup failed',
      ...(execution ?? {}),
    },
    taskStateVersion: 7,
    ...rest,
  } as TaskState;
}

function toRecord(write: WorkerActionWrite): WorkerActionRecord {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    ...write,
    attemptCount: write.attemptCount ?? 0,
    createdAt: write.createdAt ?? now,
    updatedAt: write.updatedAt ?? now,
  };
}

function makeHarness(tasksInput: TaskState[] = [makeTask()]) {
  const tasks = new Map(tasksInput.map((task) => [task.id, task]));
  const actions = new Map<string, WorkerActionRecord>();
  const submissions: Array<{ workflowId: string; priority: WorkflowMutationPriority; channel: string; args: unknown[] }> = [];
  const submit = vi.fn((workflowId: string, priority: WorkflowMutationPriority, channel: string, args: unknown[]) => {
    submissions.push({ workflowId, priority, channel, args });
    return submissions.length;
  });
  const updateTask = vi.fn((taskId: string, changes: Partial<TaskState>) => {
    const existing = tasks.get(taskId);
    if (!existing) return;
    tasks.set(taskId, {
      ...existing,
      ...changes,
      execution: {
        ...existing.execution,
        ...((changes as { execution?: TaskState['execution'] }).execution ?? {}),
      },
    });
  });
  const store = {
    listWorkflows: vi.fn(() => [{ id: 'wf-1' }]),
    loadTasks: vi.fn((workflowId: string) => workflowId === 'wf-1' ? Array.from(tasks.values()) : []),
    loadTask: vi.fn((taskId: string) => tasks.get(taskId)),
    updateTask,
    getEvents: vi.fn(() => []),
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) => actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const existing = actions.get(`${write.workerKind}:${write.externalKey}`);
      const saved = toRecord({ ...write, id: existing?.id ?? write.id, createdAt: existing?.createdAt });
      actions.set(`${write.workerKind}:${write.externalKey}`, saved);
      return saved;
    }),
    logEvent: vi.fn(),
  };
  const runRemoteProvisionRepairFn = vi.fn(async () => 'remote repair ok');
  const resolveRemoteBranchOwnerPathFn = vi.fn(async () => undefined as string | undefined);
  let nowMs = Date.parse('2026-01-01T00:00:00.000Z');
  const tick = createInfraRepairTick({
    store,
    submitter: { submit },
    logger,
    ownerRepoRoot: '/tmp/repo',
    ownerInvokerHome: '/tmp/.invoker',
    remoteTargets: {
      'remote-1': {
        host: '203.0.113.10',
        user: 'invoker',
        sshKeyPath: '/tmp/key',
        provisionCommand: 'bash scripts/provision-ssh-worker.sh ensure-repo-ready',
      },
    },
    repairCooldownMs: 30 * 60 * 1000,
    runRemoteProvisionRepairFn,
    resolveRemoteBranchOwnerPathFn,
    now: () => nowMs,
  });

  return {
    actions,
    submissions,
    submit,
    tasks,
    tick,
    updateTask,
    runRemoteProvisionRepairFn,
    resolveRemoteBranchOwnerPathFn,
    setNow: (nextNowMs: number) => { nowMs = nextNowMs; },
  };
}

function workerActions(actions: Map<string, WorkerActionRecord>): WorkerActionRecord[] {
  return Array.from(actions.values());
}

describe('infra-repair worker', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('scans only failed SSH tasks', () => {
    const candidates = listInfraRepairScanCandidates({
      listWorkflows: () => [{ id: 'wf-1' }],
      loadTasks: () => [
        makeTask(),
        makeTask({
          id: 'wf-1/task-2',
          config: {
            workflowId: 'wf-1',
            runnerKind: 'worktree',
            poolMemberId: 'remote-1',
            command: 'pnpm test',
          },
        }),
        makeTask({ id: 'wf-1/task-3', status: 'running' }),
      ],
    });

    expect(candidates).toEqual([{
      taskId: 'wf-1/task-1',
      workflowId: 'wf-1',
      generation: 2,
      taskStateVersion: 7,
      source: 'scan',
    }]);
  });

  it('skips liveness stalls', async () => {
    const h = makeHarness([
      makeTask({
        execution: {
          error: '.invoker/env.sh: export: BAD-VAR: not a valid identifier',
          failureClass: 'liveness_stall',
        },
      }),
    ]);

    await h.tick(POLL_CTX);

    expect(h.runRemoteProvisionRepairFn).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('classifies env-invalid-export, runs remote repair, and queues retry-task', async () => {
    const h = makeHarness([
      makeTask({
        execution: {
          error: '.invoker/env.sh: export: BAD-VAR: not a valid identifier',
        },
      }),
    ]);

    await h.tick(POLL_CTX);

    expect(h.runRemoteProvisionRepairFn).toHaveBeenCalledTimes(1);
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.submissions[0]?.channel).toBe(INFRA_REPAIR_RETRY_TASK_CHANNEL);
    expect(parseInfraRepairRetryTaskMutationArgs(h.submissions[0]?.args ?? [])).toEqual({ taskId: 'wf-1/task-1' });
    expect(workerActions(h.actions)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        workerKind: INFRA_REPAIR_WORKER_KIND,
        actionType: 'repair-target',
        subjectType: 'infra-target',
        subjectId: 'remote-1',
        status: 'completed',
      }),
      expect.objectContaining({
        workerKind: INFRA_REPAIR_WORKER_KIND,
        actionType: 'repair-infra-failure',
        taskId: 'wf-1/task-1',
        status: 'completed',
        payload: expect.objectContaining({
          infraReason: 'ssh-env-invalid-export',
          channel: INFRA_REPAIR_RETRY_TASK_CHANNEL,
        }),
      }),
    ]));
  });

  it('reads the persisted failureClass subtype when the error text is opaque', async () => {
    const h = makeHarness([
      makeTask({
        execution: {
          error: 'Executor startup failed (ssh): opaque wrapper with no signature',
          failureClass: 'ssh-env-invalid-export',
        },
      }),
    ]);

    await h.tick(POLL_CTX);

    expect(h.runRemoteProvisionRepairFn).toHaveBeenCalledTimes(1);
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.submissions[0]?.channel).toBe(INFRA_REPAIR_RETRY_TASK_CHANNEL);
    expect(parseInfraRepairRetryTaskMutationArgs(h.submissions[0]?.args ?? [])).toEqual({ taskId: 'wf-1/task-1' });
  });

  it('repairs missing worktree owner path, updates workspacePath, and queues retry-task', async () => {
    const h = makeHarness([
      makeTask({
        execution: {
          error: 'cd ~/.invoker/worktrees/repo/task-1: No such file or directory',
          workspacePath: '~/.invoker/worktrees/repo/task-1',
        },
      }),
    ]);
    h.resolveRemoteBranchOwnerPathFn.mockResolvedValue('~/.invoker/worktrees/repo/task-1-owner');

    await h.tick(POLL_CTX);

    expect(h.updateTask).toHaveBeenCalledWith('wf-1/task-1', {
      execution: {
        workspacePath: '~/.invoker/worktrees/repo/task-1-owner',
      },
    });
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.submissions[0]?.channel).toBe(INFRA_REPAIR_RETRY_TASK_CHANNEL);
    expect(parseInfraRepairRetryTaskMutationArgs(h.submissions[0]?.args ?? [])).toEqual({ taskId: 'wf-1/task-1' });
  });

  it('recreates a task when the missing worktree path cannot be repaired', async () => {
    const h = makeHarness([
      makeTask({
        execution: {
          error: 'cd ~/.invoker/worktrees/repo/task-1: No such file or directory',
        },
      }),
    ]);
    h.resolveRemoteBranchOwnerPathFn.mockResolvedValue(undefined);

    await h.tick(POLL_CTX);

    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.submissions[0]?.channel).toBe(INFRA_REPAIR_RECREATE_TASK_CHANNEL);
    expect(parseInfraRepairRecreateTaskMutationArgs(h.submissions[0]?.args ?? [])).toEqual({ taskId: 'wf-1/task-1' });
  });

  it('recreates invalid-reference and no-saved-workspace failures', async () => {
    for (const error of [
      'fatal: invalid reference: refs/heads/feature/task-1',
      'Cannot apply a fix because this task has no saved workspace.',
    ]) {
      const h = makeHarness([
        makeTask({ execution: { error } }),
      ]);

      await h.tick(POLL_CTX);

      expect(h.submit).toHaveBeenCalledTimes(1);
      expect(h.submissions[0]?.channel).toBe(INFRA_REPAIR_RECREATE_TASK_CHANNEL);
      expect(parseInfraRepairRecreateTaskMutationArgs(h.submissions[0]?.args ?? [])).toEqual({ taskId: 'wf-1/task-1' });
    }
  });

  it('suppresses a second target repair but still retries a later task after recent success', async () => {
    const h = makeHarness([
      makeTask({
        id: 'wf-1/task-1',
        execution: { error: '.invoker/env.sh: export: BAD-VAR: not a valid identifier' },
      }),
    ]);

    await h.tick(POLL_CTX);

    h.tasks.set('wf-1/task-2', makeTask({
      id: 'wf-1/task-2',
      execution: {
        error: '.invoker/env.sh: export: BAD-VAR: not a valid identifier',
        branch: 'feature/task-2',
        workspacePath: '~/.invoker/worktrees/repo/task-2',
      },
      taskStateVersion: 8,
    }));

    await h.tick(POLL_CTX);

    expect(h.runRemoteProvisionRepairFn).toHaveBeenCalledTimes(1);
    const retrySubmissions = h.submissions.filter((submission) => submission.channel === INFRA_REPAIR_RETRY_TASK_CHANNEL);
    expect(retrySubmissions).toHaveLength(2);
    expect(parseInfraRepairRetryTaskMutationArgs(retrySubmissions[1]?.args ?? [])).toEqual({ taskId: 'wf-1/task-2' });
  });

  it('records a failed action and submits nothing when remote repair fails', async () => {
    const h = makeHarness([
      makeTask({
        execution: {
          error: '.invoker/env.sh: export: BAD-VAR: not a valid identifier',
        },
      }),
    ]);
    h.runRemoteProvisionRepairFn.mockRejectedValue(new Error('remote repair blew up'));

    await h.tick(POLL_CTX);

    expect(h.submit).not.toHaveBeenCalled();
    expect(workerActions(h.actions)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actionType: 'repair-target',
        subjectId: 'remote-1',
        status: 'failed',
      }),
      expect.objectContaining({
        actionType: 'repair-infra-failure',
        taskId: 'wf-1/task-1',
        status: 'failed',
        payload: expect.objectContaining({
          infraReason: 'ssh-env-invalid-export',
          error: expect.stringContaining('remote repair blew up'),
        }),
      }),
    ]));
  });
});
