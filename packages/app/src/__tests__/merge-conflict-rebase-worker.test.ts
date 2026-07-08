import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ReviewGateLookup, WorkerActionRecord, WorkerActionWrite, WorkflowMutationPriority } from '@invoker/data-store';
import {
  MERGE_CONFLICT_REBASE_WORKER_KIND,
  createMergeConflictRebaseTick,
  mergeConflictManualAttentionKey,
  mergeConflictRebaseActionKey,
  type WorkerGitHubClient,
} from '@invoker/execution-engine';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
};

const mapping: ReviewGateLookup = {
  workflowId: 'wf-1',
  mergeTaskId: '__merge__wf-1',
  reviewId: '303',
  reviewUrl: 'https://github.com/owner/repo/pull/303',
  branch: 'feature/pr-303',
  baseBranch: 'main',
  workflowStatus: 'pending',
  workflowGeneration: 2,
  mergeTaskStatus: 'review_ready',
};

function toRecord(write: WorkerActionWrite): WorkerActionRecord {
  return {
    ...write,
    attemptCount: write.attemptCount ?? 0,
    createdAt: write.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: write.updatedAt ?? '2026-01-01T00:00:00.000Z',
  };
}

function makeStore(options: { generation?: number; mapped?: boolean; seed?: WorkerActionRecord[] } = {}) {
  let generation = options.generation ?? 2;
  const actions = new Map<string, WorkerActionRecord>();
  for (const action of options.seed ?? []) {
    actions.set(`${action.workerKind}:${action.externalKey}`, action);
  }
  const store = {
    findReviewGateByPr: vi.fn((pr: string) => (options.mapped === false || pr !== '303' ? undefined : mapping)),
    loadWorkflow: vi.fn((workflowId: string) => (workflowId === 'wf-1' ? {
      id: 'wf-1',
      name: 'workflow',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      generation,
    } as any : undefined)),
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) => actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const existing = actions.get(`${write.workerKind}:${write.externalKey}`);
      const saved = toRecord({ ...write, createdAt: existing?.createdAt });
      actions.set(`${write.workerKind}:${write.externalKey}`, saved);
      return saved;
    }),
    logEvent: vi.fn(),
  };
  return {
    actions,
    store,
    advanceGeneration: (next: number) => {
      generation = next;
    },
  };
}

function makeGithub(): WorkerGitHubClient & { createPullRequestComment: ReturnType<typeof vi.fn> } {
  return {
    listPullRequests: vi.fn(async () => [{
      owner: 'owner',
      repo: 'repo',
      number: 303,
      url: 'https://github.com/owner/repo/pull/303',
      state: 'open',
      headSha: 'sha-1',
      branch: 'feature/pr-303',
      baseBranch: 'main',
      mergeStateStatus: 'DIRTY',
      mergeable: 'CONFLICTING',
    }]),
    getPullRequest: vi.fn(),
    createPullRequestComment: vi.fn(async () => undefined),
  };
}

function makeExistingAction(overrides: Partial<WorkerActionRecord>): WorkerActionRecord {
  return {
    id: 'action-1',
    workerKind: MERGE_CONFLICT_REBASE_WORKER_KIND,
    actionType: 'rebase-recreate-conflicting-pr',
    workflowId: 'wf-1',
    taskId: '__merge__wf-1',
    subjectType: 'pull_request',
    subjectId: '303',
    externalKey: mergeConflictRebaseActionKey('wf-1', 2),
    status: 'failed',
    attemptCount: 3,
    summary: 'failed',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('merge-conflict rebase worker', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('submits headless.exec rebase-recreate for a mapped conflicting PR and confirms generation advancement', async () => {
    const h = makeStore();
    const github = makeGithub();
    const submit = vi.fn((workflowId: string, priority: WorkflowMutationPriority, channel: string, args: unknown[]) => {
      expect(workflowId).toBe('wf-1');
      expect(priority).toBe('high');
      expect(channel).toBe('headless.exec');
      expect(args).toEqual([{ args: ['rebase-recreate', 'wf-1'], noTrack: true }]);
      h.advanceGeneration(3);
      return 77;
    });

    await createMergeConflictRebaseTick({
      store: h.store,
      submitter: { submit },
      logger,
      github,
      targetRepo: 'owner/repo',
      confirmTimeoutMs: 0,
    })({ identity: { kind: MERGE_CONFLICT_REBASE_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(h.actions.get(`${MERGE_CONFLICT_REBASE_WORKER_KIND}:${mergeConflictRebaseActionKey('wf-1', 2)}`)).toMatchObject({
      workerKind: MERGE_CONFLICT_REBASE_WORKER_KIND,
      actionType: 'rebase-recreate-conflicting-pr',
      status: 'completed',
      attemptCount: 1,
      intentId: '77',
      payload: expect.objectContaining({
        previousGeneration: 2,
        currentGeneration: 3,
      }),
    });
    expect(h.store.logEvent).toHaveBeenCalledWith(
      '__merge__wf-1',
      'task.worker_action',
      expect.objectContaining({
        worker: MERGE_CONFLICT_REBASE_WORKER_KIND,
        status: 'completed',
        prNumber: 303,
      }),
    );
  });

  it('does not mutate PRs that have no Invoker workflow mapping', async () => {
    const h = makeStore({ mapped: false });
    const github = makeGithub();
    const submit = vi.fn();

    await createMergeConflictRebaseTick({
      store: h.store,
      submitter: { submit },
      logger,
      github,
      targetRepo: 'owner/repo',
      confirmTimeoutMs: 0,
    })({ identity: { kind: MERGE_CONFLICT_REBASE_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });

    expect(submit).not.toHaveBeenCalled();
    expect(github.createPullRequestComment).not.toHaveBeenCalled();
    expect(h.actions.size).toBe(0);
  });

  it('caps rebase attempts and posts only one manual-attention comment', async () => {
    const exhausted = makeExistingAction({ attemptCount: 3, status: 'failed' });
    const h = makeStore({ seed: [exhausted] });
    const github = makeGithub();
    const submit = vi.fn();
    const tick = createMergeConflictRebaseTick({
      store: h.store,
      submitter: { submit },
      logger,
      github,
      targetRepo: 'owner/repo',
      maxAttempts: 3,
      confirmTimeoutMs: 0,
    });

    await tick({ identity: { kind: MERGE_CONFLICT_REBASE_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });
    await tick({ identity: { kind: MERGE_CONFLICT_REBASE_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 2 });

    expect(submit).not.toHaveBeenCalled();
    expect(github.createPullRequestComment).toHaveBeenCalledTimes(1);
    expect(h.actions.get(`${MERGE_CONFLICT_REBASE_WORKER_KIND}:${mergeConflictManualAttentionKey('wf-1')}`)).toMatchObject({
      actionType: 'merge-conflict-manual-attention',
      status: 'completed',
      payload: expect.objectContaining({
        reason: 'attempt-cap',
        maxAttempts: 3,
      }),
    });
  });
});
