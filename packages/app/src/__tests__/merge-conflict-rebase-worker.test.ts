import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ReviewGateLookup, WorkerActionRecord, WorkerActionWrite, Workflow } from '@invoker/data-store';
import {
  MERGE_CONFLICT_REBASE_WORKER_KIND,
  createMergeConflictRebaseTick,
  mergeConflictRebaseActionKey,
} from '@invoker/execution-engine';
import type { WorkerGitHubClient, WorkerGitHubPullRequest } from '@invoker/execution-engine';

const ENV_KEYS = [
  'INVOKER_GITHUB_TARGET_REPO',
  'INVOKER_PR_CRON_AUTHOR',
  'INVOKER_PR_REBASE_MAX_ATTEMPTS',
  'INVOKER_PR_REBASE_CONFIRM_TIMEOUT',
  'INVOKER_PR_REBASE_CONFIRM_POLL_MS',
  'INVOKER_PR_CONFLICT_REBASE_POLL_INTERVAL_MS',
] as const;

const originalEnv = new Map<string, string | undefined>();

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
};

function pr(overrides: Partial<WorkerGitHubPullRequest> = {}): WorkerGitHubPullRequest {
  return {
    owner: 'owner',
    repo: 'repo',
    number: 20,
    url: 'https://github.com/owner/repo/pull/20',
    state: 'OPEN',
    headSha: 'sha-20',
    branch: 'feature/20',
    baseBranch: 'main',
    mergeable: 'CONFLICTING',
    mergeStateStatus: 'DIRTY',
    ...overrides,
  };
}

function reviewGate(overrides: Partial<ReviewGateLookup> = {}): ReviewGateLookup {
  return {
    workflowId: 'wf-20',
    mergeTaskId: '__merge__wf-20',
    reviewId: '20',
    reviewUrl: 'https://github.com/owner/repo/pull/20',
    branch: 'feature/20',
    baseBranch: 'main',
    workflowStatus: 'review_ready',
    workflowGeneration: 7,
    mergeTaskStatus: 'review_ready',
    selectedAttemptId: 'attempt-1',
    ...overrides,
  };
}

function workflow(id: string, generation: number): Workflow {
  return {
    id,
    name: id,
    description: id,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    generation,
    status: 'review_ready',
    rollup: {
      total: 1,
      completed: 0,
      failed: 0,
      running: 0,
      pending: 0,
      waiting: 0,
      reviewReady: 1,
      awaitingApproval: 0,
      fixingWithAi: 0,
      needsInput: 0,
      closed: 0,
      stale: 0,
    },
  } as Workflow;
}

function toRecord(write: WorkerActionWrite, existing?: WorkerActionRecord): WorkerActionRecord {
  const now = '2026-07-01T00:00:00.000Z';
  return {
    ...write,
    attemptCount: write.attemptCount ?? 0,
    createdAt: existing?.createdAt ?? write.createdAt ?? now,
    updatedAt: write.updatedAt ?? now,
  };
}

function makeHarness(args: {
  prs: WorkerGitHubPullRequest[];
  mappings?: Record<number, ReviewGateLookup | undefined>;
  initialGenerations?: Record<string, number>;
}) {
  const actions = new Map<string, WorkerActionRecord>();
  const generations = new Map<string, number>();
  for (const [id, generation] of Object.entries(args.initialGenerations ?? { 'wf-20': 7 })) {
    generations.set(id, generation);
  }
  const store = {
    listWorkflows: vi.fn(() => Array.from(generations.keys()).map((id) => ({ id }))),
    loadWorkflow: vi.fn((workflowId: string) => {
      const generation = generations.get(workflowId);
      return generation === undefined ? undefined : workflow(workflowId, generation);
    }),
    loadTasks: vi.fn(() => []),
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) => actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const key = `${write.workerKind}:${write.externalKey}`;
      const saved = toRecord(write, actions.get(key));
      actions.set(key, saved);
      return saved;
    }),
    listWorkerActions: vi.fn(() => Array.from(actions.values())),
    logEvent: vi.fn(),
    findReviewGateByPr: vi.fn((num: string) => args.mappings?.[Number(num)]),
  };
  const github: WorkerGitHubClient = {
    listOpenPullRequests: vi.fn(async () => args.prs),
    getPullRequest: vi.fn(async ({ pullNumber }) => args.prs.find((candidate) => candidate.number === pullNumber)),
    createPullRequestComment: vi.fn(async () => undefined),
  };
  const submitter = {
    submit: vi.fn((workflowId: string) => {
      generations.set(workflowId, (generations.get(workflowId) ?? 0) + 1);
      return 77;
    }),
  };
  return { actions, generations, github, store, submitter };
}

describe('merge-conflict rebase worker', () => {
  afterEach(() => {
    for (const key of ENV_KEYS) {
      const original = originalEnv.get(key);
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
    originalEnv.clear();
    vi.clearAllMocks();
  });

  function setEnv(key: typeof ENV_KEYS[number], value: string): void {
    if (!originalEnv.has(key)) originalEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  it('maps a dirty PR through findReviewGateByPr, submits headless.exec rebase-recreate, and confirms generation advancement', async () => {
    setEnv('INVOKER_GITHUB_TARGET_REPO', 'owner/repo');
    setEnv('INVOKER_PR_CRON_AUTHOR', 'EdbertChan');
    const dirty = pr();
    const clean = pr({
      number: 21,
      url: 'https://github.com/owner/repo/pull/21',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
    });
    const harness = makeHarness({
      prs: [dirty, clean],
      mappings: { 20: reviewGate() },
      initialGenerations: { 'wf-20': 7 },
    });
    const tick = createMergeConflictRebaseTick({
      store: harness.store,
      github: harness.github,
      submitter: harness.submitter,
      logger,
      config: { mergeConflictConfirmPollMs: 1 },
      sleep: async () => undefined,
    });

    await tick({ identity: { kind: MERGE_CONFLICT_REBASE_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });

    expect(harness.store.findReviewGateByPr).toHaveBeenCalledWith('20');
    expect(harness.store.findReviewGateByPr).not.toHaveBeenCalledWith('21');
    expect(harness.submitter.submit).toHaveBeenCalledWith(
      'wf-20',
      'high',
      'headless.exec',
      [{ args: ['rebase-recreate', 'wf-20'], noTrack: true }],
    );
    const action = harness.actions.get(`${MERGE_CONFLICT_REBASE_WORKER_KIND}:${mergeConflictRebaseActionKey('wf-20', 7)}`);
    expect(action).toMatchObject({
      workerKind: MERGE_CONFLICT_REBASE_WORKER_KIND,
      actionType: 'rebase-recreate-conflicting-pr',
      status: 'completed',
      attemptCount: 1,
      intentId: '77',
      workflowId: 'wf-20',
      taskId: '__merge__wf-20',
      payload: expect.objectContaining({
        confirmedGeneration: 8,
      }),
    });
    expect(harness.store.logEvent).toHaveBeenCalledWith(
      '__merge__wf-20',
      'task.worker_action',
      expect.objectContaining({
        workerKind: MERGE_CONFLICT_REBASE_WORKER_KIND,
        status: 'completed',
      }),
    );
  });

  it('does not mutate unmapped conflicting PRs', async () => {
    setEnv('INVOKER_GITHUB_TARGET_REPO', 'owner/repo');
    const harness = makeHarness({
      prs: [pr()],
      mappings: { 20: undefined },
    });
    const tick = createMergeConflictRebaseTick({
      store: harness.store,
      github: harness.github,
      submitter: harness.submitter,
      logger,
      sleep: async () => undefined,
    });

    await tick({ identity: { kind: MERGE_CONFLICT_REBASE_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });

    expect(harness.submitter.submit).not.toHaveBeenCalled();
    expect(harness.github.createPullRequestComment).not.toHaveBeenCalled();
  });

  it('caps rebase attempts and posts only one manual-attention comment', async () => {
    setEnv('INVOKER_GITHUB_TARGET_REPO', 'owner/repo');
    setEnv('INVOKER_PR_REBASE_MAX_ATTEMPTS', '3');
    const gate = reviewGate({ workflowGeneration: 4 });
    const harness = makeHarness({
      prs: [pr()],
      mappings: { 20: gate },
      initialGenerations: { 'wf-20': 4 },
    });
    const key = `${MERGE_CONFLICT_REBASE_WORKER_KIND}:${mergeConflictRebaseActionKey('wf-20', 4)}`;
    harness.actions.set(key, {
      id: 'existing',
      workerKind: MERGE_CONFLICT_REBASE_WORKER_KIND,
      actionType: 'rebase-recreate-conflicting-pr',
      workflowId: 'wf-20',
      taskId: '__merge__wf-20',
      subjectType: 'pull_request',
      subjectId: '20',
      externalKey: mergeConflictRebaseActionKey('wf-20', 4),
      status: 'failed',
      attemptCount: 3,
      summary: 'previous failure',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    });
    const tick = createMergeConflictRebaseTick({
      store: harness.store,
      github: harness.github,
      submitter: harness.submitter,
      logger,
      sleep: async () => undefined,
    });

    await tick({ identity: { kind: MERGE_CONFLICT_REBASE_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });
    await tick({ identity: { kind: MERGE_CONFLICT_REBASE_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 2 });

    expect(harness.submitter.submit).not.toHaveBeenCalled();
    expect(harness.github.createPullRequestComment).toHaveBeenCalledTimes(1);
    expect(harness.github.createPullRequestComment).toHaveBeenCalledWith(expect.objectContaining({
      owner: 'owner',
      repo: 'repo',
      pullNumber: 20,
      body: expect.stringContaining('manual attention'),
    }));
    const manualAction = harness.actions.get(`${MERGE_CONFLICT_REBASE_WORKER_KIND}:manual-attention:wf-20`);
    expect(manualAction).toMatchObject({
      actionType: 'manual-attention-conflicting-pr',
      status: 'completed',
    });
  });
});
