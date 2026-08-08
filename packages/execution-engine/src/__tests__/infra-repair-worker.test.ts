import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  WorkerActionRecord,
  WorkerActionWrite,
  WorkflowMutationPriority,
} from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import { PR_6976_OAUTH_SESSION_EXPIRED_ERROR } from './fixtures/pr-6976-oauth-session-expired.js';
import {
  buildRepoMirrorRepairScript,
  createInfraRepairTick,
  extractCorruptMirrorPath,
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

function makeHarness(
  tasksInput: TaskState[] = [makeTask()],
  options: { defaultAutoFixRetries?: number } = {},
) {
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
  const runRepoMirrorRepairFn = vi.fn(async () => 'mirror repair ok');
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
    defaultAutoFixRetries: options.defaultAutoFixRetries ?? Number.POSITIVE_INFINITY,
    runRemoteProvisionRepairFn,
    runRepoMirrorRepairFn,
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
    runRepoMirrorRepairFn,
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

  it('classifies a corrupt repo mirror, removes it remotely, and queues retry-task', async () => {
    // Repro: SSH bootstrap_clone_fetch hits a mirror whose .git/ exists but is
    // corrupt (present but missing HEAD/config/objects) -- git's own fetch
    // fails with "not a git repository" because buildMirrorCloneScript only
    // checks directory existence, not repo validity, before skipping clone.
    const h = makeHarness([
      makeTask({
        execution: {
          error: 'Executor startup failed (ssh): SSH remote script failed (exit=128, phase=bootstrap_clone_fetch)\n'
            + 'STDERR:\n'
            + 'fatal: not a git repository (or any of the parent directories): .git\n'
            + '[WARNING] Git fetch failed for /home/invoker/.invoker/repos/647faa73e90e\n'
            + '[WARNING] Continuing with existing refs. Tasks may use stale commits.\n'
            + "ERROR: base ref 'master' not found and fallback 'origin/master' also missing\n",
        },
      }),
    ]);

    await h.tick(POLL_CTX);

    expect(h.runRepoMirrorRepairFn).toHaveBeenCalledTimes(1);
    expect(h.runRepoMirrorRepairFn).toHaveBeenCalledWith(expect.objectContaining({
      mirrorPath: '/home/invoker/.invoker/repos/647faa73e90e',
    }));
    expect(h.runRemoteProvisionRepairFn).not.toHaveBeenCalled();
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.submissions[0]?.channel).toBe(INFRA_REPAIR_RETRY_TASK_CHANNEL);
    expect(parseInfraRepairRetryTaskMutationArgs(h.submissions[0]?.args ?? [])).toEqual({ taskId: 'wf-1/task-1' });
    expect(workerActions(h.actions)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        workerKind: INFRA_REPAIR_WORKER_KIND,
        actionType: 'repair-infra-failure',
        taskId: 'wf-1/task-1',
        status: 'completed',
        payload: expect.objectContaining({
          infraReason: 'ssh-repo-mirror-corrupt',
          channel: INFRA_REPAIR_RETRY_TASK_CHANNEL,
        }),
      }),
    ]));
  });

  it('fails cleanly when the corrupt mirror path cannot be parsed from the error', async () => {
    const h = makeHarness([
      makeTask({
        execution: {
          error: 'SSH remote script failed (exit=128, phase=bootstrap_clone_fetch)\n'
            + 'STDERR:\n'
            + 'fatal: not a git repository (or any of the parent directories): .git\n',
        },
      }),
    ]);

    await h.tick(POLL_CTX);

    expect(h.runRepoMirrorRepairFn).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('refuses to act when the parsed mirror path is unsafe, even if something matched', async () => {
    for (const unsafePath of ['/', '~', '.', '..', '', '/home/invoker/.invoker/worktrees/x']) {
      const h = makeHarness([
        makeTask({
          execution: {
            error: `SSH remote script failed (exit=128, phase=bootstrap_clone_fetch)\nSTDERR:\nfatal: not a git repository (or any of the parent directories): .git\n[WARNING] Git fetch failed for ${unsafePath}\n`,
          },
        }),
      ]);

      await h.tick(POLL_CTX);

      expect(h.runRepoMirrorRepairFn, `path=${JSON.stringify(unsafePath)}`).not.toHaveBeenCalled();
      expect(h.submit, `path=${JSON.stringify(unsafePath)}`).not.toHaveBeenCalled();
    }
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

  it('stops recreating a task once the shared auto-fix retry budget is exhausted, instead of looping forever', async () => {
    const h = makeHarness([
      makeTask({
        execution: {
          error: 'cd ~/.invoker/worktrees/repo/task-1: No such file or directory',
        },
      }),
    ], { defaultAutoFixRetries: 2 });
    h.resolveRemoteBranchOwnerPathFn.mockResolvedValue(undefined);

    for (let round = 0; round < 5; round += 1) {
      await h.tick({ ...POLL_CTX, tickNumber: round + 1 });
      h.tasks.set('wf-1/task-1', makeTask({
        execution: {
          error: 'cd ~/.invoker/worktrees/repo/task-1: No such file or directory',
          generation: 2 + round + 1,
        },
        taskStateVersion: 7 + round + 1,
      }));
    }

    const recreateSubmissions = h.submissions.filter((s) => s.channel === INFRA_REPAIR_RECREATE_TASK_CHANNEL);
    expect(recreateSubmissions).toHaveLength(2);
  });

  it('recreates invalid branch-reference and no-saved-workspace failures', async () => {
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

  it('does not recreate a task when invalid-reference points at a missing upstream commit', async () => {
    const missingCommit = '0a9fa79519df5dbada79e06f9899e22b26549435';
    const h = makeHarness([
      makeTask({
        execution: {
          error: `fatal: invalid reference: ${missingCommit}`,
        },
      }),
    ]);

    await h.tick(POLL_CTX);

    expect(h.submit).not.toHaveBeenCalled();
    expect(workerActions(h.actions)).toEqual([expect.objectContaining({
      workerKind: INFRA_REPAIR_WORKER_KIND,
      actionType: 'repair-infra-failure',
      taskId: 'wf-1/task-1',
      status: 'completed',
      payload: expect.objectContaining({
        infraReason: 'ssh-invalid-reference',
        invalidReference: missingCommit,
        reason: 'upstream-commit-unreachable',
      }),
    })]);

    await h.tick({ ...POLL_CTX, tickNumber: 2 });

    expect(h.submit).not.toHaveBeenCalled();
    expect(workerActions(h.actions)).toHaveLength(1);
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

  it('records an OAuth-session-expired alert without queueing any follow-up mutation', async () => {
    const h = makeHarness([
      makeTask({
        execution: {
          error: PR_6976_OAUTH_SESSION_EXPIRED_ERROR,
        },
      }),
    ]);

    await h.tick(POLL_CTX);

    expect(h.submit).not.toHaveBeenCalled();
    expect(h.runRemoteProvisionRepairFn).not.toHaveBeenCalled();
    expect(h.runRepoMirrorRepairFn).not.toHaveBeenCalled();
    expect(workerActions(h.actions)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        workerKind: INFRA_REPAIR_WORKER_KIND,
        actionType: 'repair-target',
        subjectType: 'infra-target',
        subjectId: 'remote-1',
        status: 'failed',
        payload: expect.objectContaining({
          infraReason: 'ssh-oauth-session-expired',
        }),
      }),
      expect.objectContaining({
        workerKind: INFRA_REPAIR_WORKER_KIND,
        actionType: 'repair-infra-failure',
        taskId: 'wf-1/task-1',
        status: 'completed',
        payload: expect.objectContaining({
          infraReason: 'ssh-oauth-session-expired',
        }),
      }),
    ]));
  });

  it('does not record a second OAuth-session-expired alert within the cooldown window', async () => {
    const h = makeHarness([
      makeTask({
        execution: {
          error: PR_6976_OAUTH_SESSION_EXPIRED_ERROR,
        },
      }),
    ]);

    await h.tick(POLL_CTX);

    const targetActionWrites = () => h.actions.get(
      `${INFRA_REPAIR_WORKER_KIND}:target:remote-1:repair:ssh-oauth-session-expired`,
    );
    const firstAlert = targetActionWrites();
    expect(firstAlert?.status).toBe('failed');

    h.tasks.set('wf-1/task-2', makeTask({
      id: 'wf-1/task-2',
      execution: {
        error: PR_6976_OAUTH_SESSION_EXPIRED_ERROR,
        branch: 'feature/task-2',
        workspacePath: '~/.invoker/worktrees/repo/task-2',
      },
      taskStateVersion: 8,
    }));

    await h.tick({ ...POLL_CTX, tickNumber: 2 });

    expect(h.submit).not.toHaveBeenCalled();
    expect(targetActionWrites()).toEqual(firstAlert);
    expect(workerActions(h.actions)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actionType: 'repair-infra-failure',
        taskId: 'wf-1/task-2',
        status: 'skipped',
        payload: expect.objectContaining({
          reason: 'alert-cooldown',
        }),
      }),
    ]));
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

describe('extractCorruptMirrorPath', () => {
  it('parses the mirror path out of the bootstrap script warning line', () => {
    expect(extractCorruptMirrorPath(
      '[WARNING] Git fetch failed for /home/invoker/.invoker/repos/647faa73e90e\n',
    )).toBe('/home/invoker/.invoker/repos/647faa73e90e');
  });

  it('rejects paths that are missing, empty, or not shaped like a mirror path', () => {
    expect(extractCorruptMirrorPath(undefined)).toBeUndefined();
    expect(extractCorruptMirrorPath('no warning line here')).toBeUndefined();
    expect(extractCorruptMirrorPath('[WARNING] Git fetch failed for /\n')).toBeUndefined();
    expect(extractCorruptMirrorPath('[WARNING] Git fetch failed for ~\n')).toBeUndefined();
    expect(extractCorruptMirrorPath('[WARNING] Git fetch failed for /home/invoker/.invoker/worktrees/x\n')).toBeUndefined();
  });
});

describe('buildRepoMirrorRepairScript', () => {
  it('embeds a guard that refuses unsafe paths before rm -rf, independent of the caller', () => {
    const script = buildRepoMirrorRepairScript({ mirrorPath: '/home/invoker/.invoker/repos/647faa73e90e' });
    expect(script).toContain('refusing to act on unsafe mirror path');
    expect(script).toContain('rm -rf "$MIRROR_PATH"');
    // The guard must run before the deletion, not after.
    expect(script.indexOf('refusing to act on unsafe mirror path')).toBeLessThan(script.indexOf('rm -rf "$MIRROR_PATH"'));
  });
});
