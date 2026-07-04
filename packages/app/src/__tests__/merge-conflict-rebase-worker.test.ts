import { describe, expect, it, vi } from 'vitest';

import type { ReviewGateLookup, WorkerActionRecord, WorkerActionWrite, WorkflowMutationPriority } from '@invoker/data-store';
import {
  MERGE_CONFLICT_REBASE_WORKER_KIND,
  createMergeConflictRebaseTick,
  mergeConflictManualAttentionActionKey,
  mergeConflictRebaseActionKey,
  type MergeConflictRebaseGitHubClient,
  type WorkerGitHubPullRequest,
} from '@invoker/execution-engine';
import type { TaskState } from '@invoker/workflow-core';

import { resolveMergeConflictRebaseWorkerConfig } from '../config.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
};

function toRecord(write: WorkerActionWrite, existing?: WorkerActionRecord): WorkerActionRecord {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    ...write,
    id: existing?.id ?? write.id,
    attemptCount: write.attemptCount ?? existing?.attemptCount ?? 0,
    createdAt: existing?.createdAt ?? write.createdAt ?? now,
    updatedAt: write.updatedAt ?? now,
  };
}

function makePr(overrides: Partial<WorkerGitHubPullRequest> = {}): WorkerGitHubPullRequest {
  return {
    owner: 'owner',
    repo: 'repo',
    number: 201,
    url: 'https://github.com/owner/repo/pull/201',
    state: 'open',
    branch: 'feature/conflict',
    baseBranch: 'main',
    mergeable: 'CONFLICTING',
    mergeStateStatus: 'DIRTY',
    ...overrides,
  };
}

function makeWorkflow(): ReviewGateLookup {
  return {
    workflowId: 'wf-1',
    mergeTaskId: '__merge__wf-1',
    reviewId: '201',
    reviewUrl: 'https://github.com/owner/repo/pull/201',
    branch: 'feature/conflict',
    baseBranch: 'main',
    workflowStatus: 'running',
    workflowGeneration: 7,
    mergeTaskStatus: 'review_ready',
  };
}

function makeTask(): TaskState {
  return {
    id: '__merge__wf-1',
    description: 'merge',
    status: 'review_ready',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1', isMergeNode: true },
    execution: { reviewId: '201', branch: 'feature/conflict' },
    taskStateVersion: 1,
  } as TaskState;
}

function makeHarness(workflow: ReviewGateLookup | null = makeWorkflow()) {
  const actions = new Map<string, WorkerActionRecord>();
  const events: Array<{ taskId: string; eventType: string; payload?: unknown }> = [];
  let generation = workflow?.workflowGeneration ?? 0;
  const store = {
    listWorkflows: vi.fn(() => [{ id: 'wf-1' }]),
    loadWorkflow: vi.fn(() => ({
      id: 'wf-1',
      name: 'Workflow',
      status: 'running',
      generation,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })),
    loadTasks: vi.fn(() => [makeTask()]),
    loadTask: vi.fn(() => makeTask()),
    findReviewGateByPr: vi.fn((pr: string) => (workflow && pr === workflow.reviewId ? { ...workflow, workflowGeneration: generation } : undefined)),
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) => actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const key = `${write.workerKind}:${write.externalKey}`;
      const saved = toRecord(write, actions.get(key));
      actions.set(key, saved);
      return saved;
    }),
    listWorkerActions: vi.fn(({ workerKind }: { workerKind?: string } = {}) =>
      [...actions.values()].filter((action) => !workerKind || action.workerKind === workerKind)),
    logEvent: vi.fn((taskId: string, eventType: string, payload?: unknown) => {
      events.push({ taskId, eventType, payload });
    }),
  };
  return {
    actions,
    events,
    store,
    advanceGeneration: () => {
      generation += 1;
    },
  };
}

describe('merge-conflict rebase worker', () => {
  it('uses the cron-compatible merge-conflict defaults', () => {
    expect(resolveMergeConflictRebaseWorkerConfig({}, {} as NodeJS.ProcessEnv)).toMatchObject({
      targetRepo: 'Neko-Catpital-Labs/Invoker',
      author: 'EdbertChan',
      maxAttempts: 3,
      confirmTimeoutMs: 120_000,
    });
  });

  it('submits headless.exec rebase-recreate and completes only after generation advances', async () => {
    const workflow = makeWorkflow();
    const harness = makeHarness(workflow);
    const github: MergeConflictRebaseGitHubClient = {
      listOpenPullRequests: vi.fn(async () => [makePr()]),
      createPullRequestComment: vi.fn(async () => {}),
    };
    const submit = vi.fn((
      workflowId: string,
      priority: WorkflowMutationPriority,
      channel: string,
      args: unknown[],
    ) => {
      expect(workflowId).toBe('wf-1');
      expect(priority).toBe('high');
      expect(channel).toBe('headless.exec');
      expect(args).toEqual([{ args: ['rebase-recreate', 'wf-1'], noTrack: true }]);
      harness.advanceGeneration();
      return 77;
    });

    const tick = createMergeConflictRebaseTick({
      store: harness.store,
      submitter: { submit },
      logger,
      github,
      sleep: vi.fn(async () => {}),
      config: { targetRepo: 'owner/repo', author: 'EdbertChan', confirmTimeoutMs: 1, confirmPollMs: 1 },
    });

    await tick({ identity: { kind: MERGE_CONFLICT_REBASE_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });

    expect(submit).toHaveBeenCalledTimes(1);
    const externalKey = mergeConflictRebaseActionKey('owner/repo', 'wf-1', 7);
    expect(harness.actions.get(`${MERGE_CONFLICT_REBASE_WORKER_KIND}:${externalKey}`)).toMatchObject({
      workerKind: MERGE_CONFLICT_REBASE_WORKER_KIND,
      actionType: 'rebase-recreate',
      status: 'completed',
      attemptCount: 1,
      intentId: '77',
    });
    expect(harness.events.some((event) =>
      event.taskId === '__merge__wf-1' && event.eventType === 'task.worker_action')).toBe(true);
  });

  it('does not mutate an unmapped conflicting PR', async () => {
    const harness = makeHarness(null);
    const github: MergeConflictRebaseGitHubClient = {
      listOpenPullRequests: vi.fn(async () => [makePr()]),
      createPullRequestComment: vi.fn(async () => {}),
    };
    const submit = vi.fn(() => 1);

    const tick = createMergeConflictRebaseTick({
      store: harness.store,
      submitter: { submit },
      logger,
      github,
      config: { targetRepo: 'owner/repo', author: 'EdbertChan' },
    });

    await tick({ identity: { kind: MERGE_CONFLICT_REBASE_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });

    expect(submit).not.toHaveBeenCalled();
    expect(github.createPullRequestComment).not.toHaveBeenCalled();
    expect(harness.actions.size).toBe(0);
  });

  it('caps rebase attempts and posts one manual-attention comment', async () => {
    const workflow = makeWorkflow();
    const harness = makeHarness(workflow);
    const pr = makePr();
    const rebaseKey = mergeConflictRebaseActionKey('owner/repo', 'wf-1', 7);
    harness.actions.set(`${MERGE_CONFLICT_REBASE_WORKER_KIND}:${rebaseKey}`, toRecord({
      id: 'existing-rebase',
      workerKind: MERGE_CONFLICT_REBASE_WORKER_KIND,
      actionType: 'rebase-recreate',
      workflowId: 'wf-1',
      taskId: '__merge__wf-1',
      subjectType: 'pull_request',
      subjectId: '201',
      externalKey: rebaseKey,
      status: 'failed',
      attemptCount: 3,
    }));
    const github: MergeConflictRebaseGitHubClient = {
      listOpenPullRequests: vi.fn(async () => [pr]),
      createPullRequestComment: vi.fn(async () => {}),
    };
    const submit = vi.fn(() => 1);
    const tick = createMergeConflictRebaseTick({
      store: harness.store,
      submitter: { submit },
      logger,
      github,
      config: { targetRepo: 'owner/repo', author: 'EdbertChan', maxAttempts: 3 },
    });

    await tick({ identity: { kind: MERGE_CONFLICT_REBASE_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });
    await tick({ identity: { kind: MERGE_CONFLICT_REBASE_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 2 });

    expect(submit).not.toHaveBeenCalled();
    expect(github.createPullRequestComment).toHaveBeenCalledTimes(1);
    expect(github.createPullRequestComment).toHaveBeenCalledWith(expect.objectContaining({
      pullNumber: 201,
      body: expect.stringContaining('manual attention'),
    }));
    const manualKey = mergeConflictManualAttentionActionKey('owner/repo', 'wf-1');
    expect(harness.actions.get(`${MERGE_CONFLICT_REBASE_WORKER_KIND}:${manualKey}`)).toMatchObject({
      actionType: 'manual-attention-comment',
      status: 'completed',
    });
  });
});
