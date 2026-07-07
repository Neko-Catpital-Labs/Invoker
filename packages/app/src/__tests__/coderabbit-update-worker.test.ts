import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  WorkerActionRecord,
  WorkerActionWrite,
} from '@invoker/data-store';
import type {
  CodeRabbitUpdateAgent,
  WorkerGitHubClient,
  WorkerStateStore,
} from '@invoker/execution-engine';
import {
  CODERABBIT_UPDATE_WORKER_KIND,
  DEFAULT_CODERABBIT_EXECUTION_AGENT,
  DEFAULT_CODERABBIT_MAX_ATTEMPTS,
  DEFAULT_CODERABBIT_TARGET_REPO,
  DEFAULT_CODERABBIT_TIMEOUT_MS,
  DEFAULT_CODERABBIT_WORK_DIR,
  codeRabbitActionKey,
  createCodeRabbitUpdateTick,
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
  const actions = new Map<string, WorkerActionRecord>();
  const store: WorkerStateStore = {
    listWorkflows: vi.fn(() => [{ id: 'wf-1' }]),
    loadWorkflow: vi.fn(() => ({
      id: 'wf-1',
      name: 'Workflow',
      status: 'review_ready',
      generation: 4,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })),
    loadTasks: vi.fn((workflowId) => workflowId === 'wf-1' ? [task] : []),
    loadTask: vi.fn((taskId) => taskId === task.id ? task : undefined),
    findReviewGateByPr: vi.fn((pr) => pr === '101'
      ? {
          workflowId: 'wf-1',
          mergeTaskId: task.id,
          reviewId: '101',
          reviewUrl: 'https://github.com/Neko-Catpital-Labs/Invoker/pull/101',
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
        number: 101,
        url: 'https://github.com/Neko-Catpital-Labs/Invoker/pull/101',
        state: 'open',
        headSha: 'sha-a',
        branch: 'feature/a',
        baseBranch: 'main',
        title: 'Feature A',
        body: 'Body',
      },
      {
        owner: 'Neko-Catpital-Labs',
        repo: 'Invoker',
        number: 102,
        url: 'https://github.com/Neko-Catpital-Labs/Invoker/pull/102',
        state: 'open',
        headSha: 'sha-b',
      },
    ]),
    getPullRequest: vi.fn(async () => ({
      owner: 'Neko-Catpital-Labs',
      repo: 'Invoker',
      number: 101,
      url: 'https://github.com/Neko-Catpital-Labs/Invoker/pull/101',
      state: 'open',
      headSha: 'sha-a',
    })),
    listPullRequestReviewComments: vi.fn(async () => [
      {
        authorLogin: 'coderabbitai[bot]',
        body: 'inline finding',
        updatedAt: '2026-01-02T00:00:00.000Z',
        path: 'src/a.ts',
        htmlUrl: 'https://github.com/comment/1',
      },
      {
        authorLogin: 'human',
        body: 'not bot',
        updatedAt: '2026-01-05T00:00:00.000Z',
      },
    ]),
    listPullRequestIssueComments: vi.fn(async () => [
      {
        authorLogin: 'coderabbitai[bot]',
        body: 'summary finding',
        updatedAt: '2026-01-03T00:00:00.000Z',
        htmlUrl: 'https://github.com/comment/2',
      },
    ]),
  };
  const updateAgent: CodeRabbitUpdateAgent = {
    addressFeedback: vi.fn(async () => ({ ok: true, summary: 'updated branch', sessionId: 'sess-1' })),
  };
  return { actions, store, github, updateAgent, task };
}

describe('CodeRabbit update worker', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('addresses the first mapped PR with new CodeRabbit comments and records a worker action', async () => {
    const h = makeHarness();
    const tick = createCodeRabbitUpdateTick({
      store: h.store,
      github: h.github,
      updateAgent: h.updateAgent,
      logger,
    });

    await tick({ identity: { kind: CODERABBIT_UPDATE_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });

    expect(h.github.listPullRequests).toHaveBeenCalledWith({
      owner: 'Neko-Catpital-Labs',
      repo: 'Invoker',
      author: 'EdbertChan',
      state: 'open',
      limit: 100,
    });
    expect(h.github.getPullRequest).toHaveBeenCalledWith({
      owner: 'Neko-Catpital-Labs',
      repo: 'Invoker',
      pullNumber: 101,
    });
    expect(h.updateAgent.addressFeedback).toHaveBeenCalledTimes(1);
    expect(h.updateAgent.addressFeedback).toHaveBeenCalledWith(expect.objectContaining({
      targetRepo: DEFAULT_CODERABBIT_TARGET_REPO,
      latestMarker: '2026-01-03T00:00:00.000Z',
      workflowId: 'wf-1',
      mergeTaskId: h.task.id,
      workDir: DEFAULT_CODERABBIT_WORK_DIR,
      executionAgent: DEFAULT_CODERABBIT_EXECUTION_AGENT,
      timeoutMs: DEFAULT_CODERABBIT_TIMEOUT_MS,
      expectedHeadSha: 'sha-a',
      comments: [
        expect.objectContaining({ body: 'inline finding' }),
        expect.objectContaining({ body: 'summary finding' }),
      ],
      invokerTasks: [h.task],
    }));

    const externalKey = codeRabbitActionKey({
      targetRepo: DEFAULT_CODERABBIT_TARGET_REPO,
      pullNumber: 101,
      latestMarker: '2026-01-03T00:00:00.000Z',
    });
    expect(h.actions.get(`${CODERABBIT_UPDATE_WORKER_KIND}:${externalKey}`)).toMatchObject({
      workerKind: CODERABBIT_UPDATE_WORKER_KIND,
      actionType: 'address-coderabbit-feedback',
      workflowId: 'wf-1',
      taskId: h.task.id,
      subjectId: '101',
      status: 'completed',
      attemptCount: 1,
      agentName: DEFAULT_CODERABBIT_EXECUTION_AGENT,
      sessionId: 'sess-1',
      payload: expect.objectContaining({
        latestMarker: '2026-01-03T00:00:00.000Z',
        maxAttempts: DEFAULT_CODERABBIT_MAX_ATTEMPTS,
      }),
    });
    expect(h.store.logEvent).toHaveBeenCalledWith(
      h.task.id,
      'task.worker_action',
      expect.objectContaining({
        worker: CODERABBIT_UPDATE_WORKER_KIND,
        status: 'completed',
      }),
    );
  });

  it('does not invoke the update agent when the PR has no Invoker workflow mapping', async () => {
    const h = makeHarness();
    vi.mocked(h.store.findReviewGateByPr).mockReturnValue(undefined);
    const tick = createCodeRabbitUpdateTick({
      store: h.store,
      github: h.github,
      updateAgent: h.updateAgent,
      logger,
    });

    await tick({ identity: { kind: CODERABBIT_UPDATE_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });

    expect(h.updateAgent.addressFeedback).not.toHaveBeenCalled();
    expect([...h.actions.values()][0]).toMatchObject({
      status: 'skipped',
      attemptCount: 0,
      payload: expect.objectContaining({ reason: 'review-gate-mapping-not-found' }),
    });
  });

  it('skips stale CodeRabbit work when the PR head SHA changes before mutation', async () => {
    const h = makeHarness();
    vi.mocked(h.github.getPullRequest).mockResolvedValue({
      owner: 'Neko-Catpital-Labs',
      repo: 'Invoker',
      number: 101,
      url: 'https://github.com/Neko-Catpital-Labs/Invoker/pull/101',
      state: 'open',
      headSha: 'sha-new',
    });
    const tick = createCodeRabbitUpdateTick({
      store: h.store,
      github: h.github,
      updateAgent: h.updateAgent,
      logger,
    });

    await tick({ identity: { kind: CODERABBIT_UPDATE_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });

    expect(h.updateAgent.addressFeedback).not.toHaveBeenCalled();
    expect([...h.actions.values()][0]).toMatchObject({
      status: 'skipped',
      payload: expect.objectContaining({
        reason: 'head-sha-changed',
        expectedHeadSha: 'sha-a',
        currentHeadSha: 'sha-new',
      }),
    });
  });
});
