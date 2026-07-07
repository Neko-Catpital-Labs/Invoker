import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  WorkerActionRecord,
  WorkerActionWrite,
} from '@invoker/data-store';
import type {
  WorkerGitHubClient,
  WorkerHeadlessClient,
  WorkerStateStore,
} from '@invoker/execution-engine';
import {
  DEFAULT_CODERABBIT_TARGET_REPO,
  DEFAULT_MERGE_CONFLICT_REBASE_MAX_ATTEMPTS,
  MERGE_CONFLICT_REBASE_WORKER_KIND,
  createMergeConflictRebaseTick,
  mergeConflictRebaseActionKey,
} from '@invoker/execution-engine';
import type { TaskState } from '@invoker/workflow-core';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(),
};

function makeTask(): TaskState {
  return {
    id: 'wf-1/__merge__',
    description: 'merge',
    status: 'review_ready',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1', isMergeNode: true },
    execution: { generation: 4 },
    taskStateVersion: 1,
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

function makeHarness() {
  const task = makeTask();
  let generation = 4;
  const actions = new Map<string, WorkerActionRecord>();
  const store: WorkerStateStore = {
    listWorkflows: vi.fn(() => [{ id: 'wf-1' }]),
    loadWorkflow: vi.fn((workflowId) => workflowId === 'wf-1'
      ? {
          id: 'wf-1',
          name: 'Workflow',
          status: 'review_ready',
          generation,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }
      : undefined),
    loadTasks: vi.fn((workflowId) => workflowId === 'wf-1' ? [task] : []),
    loadTask: vi.fn((taskId) => taskId === task.id ? task : undefined),
    findReviewGateByPr: vi.fn((pr) => pr === '201'
      ? {
          workflowId: 'wf-1',
          mergeTaskId: task.id,
          reviewId: '201',
          reviewUrl: 'https://github.com/Neko-Catpital-Labs/Invoker/pull/201',
          workflowStatus: 'review_ready',
          workflowGeneration: 4,
        }
      : undefined),
    getWorkerAction: vi.fn((workerKind, externalKey) => actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write) => {
      const key = `${write.workerKind}:${write.externalKey}`;
      const existing = actions.get(key);
      const saved = toRecord({ ...write, id: existing?.id ?? write.id, createdAt: existing?.createdAt });
      actions.set(key, saved);
      return saved;
    }),
    listWorkerActions: vi.fn(() => [...actions.values()]),
    logEvent: vi.fn(),
  };
  const github: WorkerGitHubClient = {
    listPullRequests: vi.fn(async () => [
      {
        owner: 'Neko-Catpital-Labs',
        repo: 'Invoker',
        number: 201,
        url: 'https://github.com/Neko-Catpital-Labs/Invoker/pull/201',
        state: 'open',
        mergeStateStatus: 'DIRTY',
      },
    ]),
    getPullRequest: vi.fn(),
    createPullRequestComment: vi.fn(async () => {}),
  };
  const headless: WorkerHeadlessClient = {
    exec: vi.fn(async () => {
      generation = 5;
      return { ok: true, response: { delegated: true } };
    }),
  };
  return {
    actions,
    store,
    github,
    headless,
    task,
    setGeneration: (next: number) => {
      generation = next;
    },
  };
}

describe('merge-conflict rebase worker', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('submits headless rebase-recreate for a mapped conflicting PR and confirms generation advance', async () => {
    const h = makeHarness();
    const tick = createMergeConflictRebaseTick({
      store: h.store,
      github: h.github,
      headless: h.headless,
      logger,
      confirmTimeoutMs: 0,
    });

    await tick({ identity: { kind: MERGE_CONFLICT_REBASE_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });

    expect(h.github.listPullRequests).toHaveBeenCalledWith({
      owner: 'Neko-Catpital-Labs',
      repo: 'Invoker',
      author: 'EdbertChan',
      state: 'open',
      limit: 100,
    });
    expect(h.headless.exec).toHaveBeenCalledWith(
      ['rebase-recreate', 'wf-1'],
      { noTrack: true },
    );
    const externalKey = mergeConflictRebaseActionKey({
      targetRepo: DEFAULT_CODERABBIT_TARGET_REPO,
      workflowId: 'wf-1',
      generation: 4,
    });
    expect(h.actions.get(`${MERGE_CONFLICT_REBASE_WORKER_KIND}:${externalKey}`)).toMatchObject({
      workerKind: MERGE_CONFLICT_REBASE_WORKER_KIND,
      actionType: 'rebase-recreate-conflicting-pr',
      workflowId: 'wf-1',
      taskId: h.task.id,
      subjectId: '201',
      status: 'completed',
      attemptCount: 1,
      payload: expect.objectContaining({
        previousGeneration: 4,
        newGeneration: 5,
      }),
    });
    expect(h.store.logEvent).toHaveBeenCalledWith(
      h.task.id,
      'task.worker_action',
      expect.objectContaining({
        worker: MERGE_CONFLICT_REBASE_WORKER_KIND,
        status: 'completed',
      }),
    );
  });

  it('does not mutate PRs that have no Invoker workflow mapping', async () => {
    const h = makeHarness();
    vi.mocked(h.store.findReviewGateByPr).mockReturnValue(undefined);
    const tick = createMergeConflictRebaseTick({
      store: h.store,
      github: h.github,
      headless: h.headless,
      logger,
      confirmTimeoutMs: 0,
    });

    await tick({ identity: { kind: MERGE_CONFLICT_REBASE_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });

    expect(h.headless.exec).not.toHaveBeenCalled();
    expect(h.github.createPullRequestComment).not.toHaveBeenCalled();
    expect(h.actions.size).toBe(0);
  });

  it('caps attempts and posts one manual-attention comment for an exhausted generation', async () => {
    const h = makeHarness();
    const externalKey = mergeConflictRebaseActionKey({
      targetRepo: DEFAULT_CODERABBIT_TARGET_REPO,
      workflowId: 'wf-1',
      generation: 4,
    });
    h.actions.set(`${MERGE_CONFLICT_REBASE_WORKER_KIND}:${externalKey}`, {
      id: `${MERGE_CONFLICT_REBASE_WORKER_KIND}:${externalKey}`,
      workerKind: MERGE_CONFLICT_REBASE_WORKER_KIND,
      actionType: 'rebase-recreate-conflicting-pr',
      workflowId: 'wf-1',
      taskId: h.task.id,
      subjectType: 'pull_request',
      subjectId: '201',
      externalKey,
      status: 'failed',
      attemptCount: DEFAULT_MERGE_CONFLICT_REBASE_MAX_ATTEMPTS,
      summary: 'previous failures',
      payload: { manualAttentionCommented: false },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const tick = createMergeConflictRebaseTick({
      store: h.store,
      github: h.github,
      headless: h.headless,
      logger,
      maxAttempts: DEFAULT_MERGE_CONFLICT_REBASE_MAX_ATTEMPTS,
      confirmTimeoutMs: 0,
    });

    await tick({ identity: { kind: MERGE_CONFLICT_REBASE_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });
    await tick({ identity: { kind: MERGE_CONFLICT_REBASE_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 2 });

    expect(h.headless.exec).not.toHaveBeenCalled();
    expect(h.github.createPullRequestComment).toHaveBeenCalledTimes(1);
    expect(h.github.createPullRequestComment).toHaveBeenCalledWith({
      owner: 'Neko-Catpital-Labs',
      repo: 'Invoker',
      pullNumber: 201,
      body: expect.stringContaining('gave up after 3 rebase-recreate attempts'),
    });
    expect(h.actions.get(`${MERGE_CONFLICT_REBASE_WORKER_KIND}:${externalKey}`)).toMatchObject({
      status: 'skipped',
      attemptCount: DEFAULT_MERGE_CONFLICT_REBASE_MAX_ATTEMPTS,
      payload: expect.objectContaining({
        reason: 'attempt-cap-exhausted',
        manualAttentionCommented: true,
      }),
    });
  });
});
