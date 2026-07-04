import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ReviewGateLookup, WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';
import {
  CODERABBIT_UPDATE_WORKER_KIND,
  coderabbitUpdateActionKey,
  createCodeRabbitUpdateTick,
  type CodeRabbitAgentRunner,
} from '@invoker/execution-engine';
import type {
  WorkerGitHubClient,
  WorkerGitHubComment,
  WorkerGitHubPullRequest,
} from '@invoker/execution-engine';

const ENV_KEYS = [
  'INVOKER_GITHUB_TARGET_REPO',
  'INVOKER_PR_CRON_AUTHOR',
  'INVOKER_CODERABBIT_LOGIN',
  'INVOKER_PR_CODERABBIT_MAX_ATTEMPTS',
  'INVOKER_PR_CRON_WORKDIR',
  'INVOKER_PR_CODERABBIT_EXECUTION_AGENT',
  'INVOKER_PR_CRON_OMP_MODEL',
  'INVOKER_PR_CRON_OMP_TIMEOUT',
  'INVOKER_PR_CODERABBIT_POLL_INTERVAL_MS',
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
    number: 10,
    url: 'https://github.com/owner/repo/pull/10',
    state: 'OPEN',
    title: 'PR 10',
    headSha: 'sha-10',
    branch: 'feature/10',
    baseBranch: 'main',
    ...overrides,
  };
}

function comment(overrides: Partial<WorkerGitHubComment> = {}): WorkerGitHubComment {
  return {
    authorLogin: 'coderabbitai[bot]',
    body: 'please check this',
    updatedAt: '2026-07-01T00:00:00Z',
    htmlUrl: 'https://github.com/owner/repo/pull/10#discussion_r1',
    ...overrides,
  };
}

function reviewGate(overrides: Partial<ReviewGateLookup> = {}): ReviewGateLookup {
  return {
    workflowId: 'wf-10',
    mergeTaskId: '__merge__wf-10',
    reviewId: '10',
    reviewUrl: 'https://github.com/owner/repo/pull/10',
    branch: 'feature/10',
    baseBranch: 'main',
    workflowStatus: 'review_ready',
    workflowGeneration: 2,
    mergeTaskStatus: 'review_ready',
    selectedAttemptId: 'attempt-1',
    ...overrides,
  };
}

function task(id = 'task-1'): TaskState {
  return {
    id,
    description: id,
    status: 'completed',
    dependencies: [],
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    config: { workflowId: 'wf-10' },
    execution: {},
  } as TaskState;
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
  reviewComments?: Record<number, WorkerGitHubComment[]>;
  issueComments?: Record<number, WorkerGitHubComment[]>;
  mappings?: Record<number, ReviewGateLookup | undefined>;
  currentPrs?: Record<number, WorkerGitHubPullRequest | undefined>;
}): {
  actions: Map<string, WorkerActionRecord>;
  github: WorkerGitHubClient;
  runner: CodeRabbitAgentRunner;
  store: ReturnType<typeof makeStore>;
} {
  const actions = new Map<string, WorkerActionRecord>();
  const store = makeStore(actions, args.mappings ?? {});
  const github: WorkerGitHubClient = {
    listOpenPullRequests: vi.fn(async () => args.prs),
    getPullRequest: vi.fn(async ({ pullNumber }) => args.currentPrs?.[pullNumber] ?? args.prs.find((candidate) => candidate.number === pullNumber)),
    listPullRequestReviewComments: vi.fn(async ({ pullNumber }) => args.reviewComments?.[pullNumber] ?? []),
    listIssueComments: vi.fn(async ({ issueNumber }) => args.issueComments?.[issueNumber] ?? []),
  };
  const runner: CodeRabbitAgentRunner = {
    run: vi.fn(async () => ({ status: 'completed', summary: 'done' })),
  };
  return { actions, github, runner, store };
}

function makeStore(
  actions: Map<string, WorkerActionRecord>,
  mappings: Record<number, ReviewGateLookup | undefined>,
) {
  return {
    listWorkflows: vi.fn(() => [{ id: 'wf-10' }]),
    loadTasks: vi.fn(() => [task()]),
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) => actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const key = `${write.workerKind}:${write.externalKey}`;
      const saved = toRecord(write, actions.get(key));
      actions.set(key, saved);
      return saved;
    }),
    listWorkerActions: vi.fn(() => Array.from(actions.values())),
    logEvent: vi.fn(),
    findReviewGateByPr: vi.fn((num: string) => mappings[Number(num)]),
  };
}

describe('CodeRabbit update worker', () => {
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

  it('collects bot comments, uses the latest updatedAt, confirms head SHA, and processes one PR per tick', async () => {
    setEnv('INVOKER_GITHUB_TARGET_REPO', 'owner/repo');
    setEnv('INVOKER_PR_CRON_AUTHOR', 'EdbertChan');
    const first = pr({ number: 10, headSha: 'sha-10' });
    const second = pr({ number: 11, url: 'https://github.com/owner/repo/pull/11', headSha: 'sha-11' });
    const harness = makeHarness({
      prs: [first, second],
      mappings: { 10: reviewGate(), 11: reviewGate({ workflowId: 'wf-11', mergeTaskId: '__merge__wf-11', reviewId: '11' }) },
      reviewComments: {
        10: [
          comment({ updatedAt: '2026-07-01T00:00:00Z', path: 'a.ts' }),
          comment({ authorLogin: 'human', updatedAt: '2026-07-09T00:00:00Z' }),
        ],
        11: [comment({ updatedAt: '2026-07-03T00:00:00Z' })],
      },
      issueComments: {
        10: [comment({ updatedAt: '2026-07-02T00:00:00Z' })],
      },
    });
    const tick = createCodeRabbitUpdateTick({
      store: harness.store,
      github: harness.github,
      runner: harness.runner,
      logger,
    });

    await tick({ identity: { kind: CODERABBIT_UPDATE_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });

    expect(harness.github.listOpenPullRequests).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      author: 'EdbertChan',
      limit: 100,
    });
    expect(harness.github.getPullRequest).toHaveBeenCalledTimes(1);
    expect(harness.github.getPullRequest).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', pullNumber: 10 });
    expect(harness.runner.run).toHaveBeenCalledTimes(1);
    expect(harness.runner.run).toHaveBeenCalledWith(expect.objectContaining({
      latestCommentUpdatedAt: '2026-07-02T00:00:00Z',
      expectedHeadSha: 'sha-10',
      comments: [
        expect.objectContaining({ updatedAt: '2026-07-01T00:00:00Z' }),
        expect.objectContaining({ updatedAt: '2026-07-02T00:00:00Z' }),
      ],
    }));
    expect(harness.github.listPullRequestReviewComments).not.toHaveBeenCalledWith(expect.objectContaining({ pullNumber: 11 }));

    const action = harness.actions.get(`${CODERABBIT_UPDATE_WORKER_KIND}:${coderabbitUpdateActionKey(10, '2026-07-02T00:00:00Z')}`);
    expect(action).toMatchObject({
      workerKind: CODERABBIT_UPDATE_WORKER_KIND,
      actionType: 'address-coderabbit-feedback',
      status: 'completed',
      attemptCount: 1,
      workflowId: 'wf-10',
      taskId: '__merge__wf-10',
      payload: expect.objectContaining({
        latestCommentUpdatedAt: '2026-07-02T00:00:00Z',
        expectedHeadSha: 'sha-10',
      }),
    });
    expect(harness.store.logEvent).toHaveBeenCalledWith(
      '__merge__wf-10',
      'task.worker_action',
      expect.objectContaining({
        workerKind: CODERABBIT_UPDATE_WORKER_KIND,
        status: 'completed',
      }),
    );
  });

  it('does not run the agent when the PR has no Invoker workflow mapping', async () => {
    setEnv('INVOKER_GITHUB_TARGET_REPO', 'owner/repo');
    const harness = makeHarness({
      prs: [pr()],
      mappings: { 10: undefined },
      reviewComments: { 10: [comment()] },
    });
    const tick = createCodeRabbitUpdateTick({
      store: harness.store,
      github: harness.github,
      runner: harness.runner,
      logger,
    });

    await tick({ identity: { kind: CODERABBIT_UPDATE_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });

    expect(harness.runner.run).not.toHaveBeenCalled();
    expect(harness.store.upsertWorkerAction).not.toHaveBeenCalled();
  });

  it('skips stale CodeRabbit work when the PR head changed before launch', async () => {
    setEnv('INVOKER_GITHUB_TARGET_REPO', 'owner/repo');
    const harness = makeHarness({
      prs: [pr({ headSha: 'old-sha' })],
      currentPrs: { 10: pr({ headSha: 'new-sha' }) },
      mappings: { 10: reviewGate() },
      reviewComments: { 10: [comment()] },
    });
    const tick = createCodeRabbitUpdateTick({
      store: harness.store,
      github: harness.github,
      runner: harness.runner,
      logger,
    });

    await tick({ identity: { kind: CODERABBIT_UPDATE_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });

    expect(harness.runner.run).not.toHaveBeenCalled();
    const action = harness.actions.get(`${CODERABBIT_UPDATE_WORKER_KIND}:${coderabbitUpdateActionKey(10, '2026-07-01T00:00:00Z')}`);
    expect(action).toMatchObject({
      status: 'skipped',
      payload: expect.objectContaining({
        reason: 'head-sha-changed-before-launch',
        listedHeadSha: 'old-sha',
        currentHeadSha: 'new-sha',
      }),
    });
  });
});
