import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ReviewGateLookup, WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import {
  CODERABBIT_UPDATE_WORKER_KIND,
  codeRabbitActionKey,
  createCodeRabbitUpdateTick,
  type CodeRabbitGitHubClient,
  type CodeRabbitUpdateRunner,
  type WorkerGitHubPullRequest,
} from '@invoker/execution-engine';
import type { TaskState } from '@invoker/workflow-core';

import { resolveCodeRabbitUpdateWorkerConfig } from '../config.js';

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

function makeTask(): TaskState {
  return {
    id: '__merge__wf-1',
    description: 'merge',
    status: 'review_ready',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1', isMergeNode: true },
    execution: { reviewId: '101', branch: 'feature/pr-101' },
    taskStateVersion: 1,
  } as TaskState;
}

function makePr(number: number, headSha: string): WorkerGitHubPullRequest {
  return {
    owner: 'owner',
    repo: 'repo',
    number,
    url: `https://github.com/owner/repo/pull/${number}`,
    state: 'open',
    branch: `feature/pr-${number}`,
    baseBranch: 'main',
    headSha,
  };
}

function makeWorkflow(number = 101): ReviewGateLookup {
  return {
    workflowId: 'wf-1',
    mergeTaskId: '__merge__wf-1',
    reviewId: String(number),
    reviewUrl: `https://github.com/owner/repo/pull/${number}`,
    branch: `feature/pr-${number}`,
    baseBranch: 'main',
    workflowStatus: 'running',
    workflowGeneration: 4,
    mergeTaskStatus: 'review_ready',
  };
}

function makeHarness(workflow: ReviewGateLookup | null = makeWorkflow()) {
  const actions = new Map<string, WorkerActionRecord>();
  const events: Array<{ taskId: string; eventType: string; payload?: unknown }> = [];
  const store = {
    listWorkflows: vi.fn(() => [{ id: 'wf-1' }]),
    loadWorkflow: vi.fn(() => ({ id: 'wf-1', generation: 4 })),
    loadTasks: vi.fn(() => [makeTask()]),
    loadTask: vi.fn(() => makeTask()),
    findReviewGateByPr: vi.fn((pr: string) => (workflow && pr === workflow.reviewId ? workflow : undefined)),
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
  return { actions, events, store };
}

describe('CodeRabbit update worker', () => {
  it('uses the cron-compatible CodeRabbit defaults', () => {
    expect(resolveCodeRabbitUpdateWorkerConfig({}, {} as NodeJS.ProcessEnv)).toMatchObject({
      targetRepo: 'Neko-Catpital-Labs/Invoker',
      author: 'EdbertChan',
      login: 'coderabbitai[bot]',
      maxAttempts: 3,
      workDir: join(homedir(), '.invoker', 'pr-cron-work'),
      executionAgent: 'omp',
      timeoutMs: 45 * 60_000,
    });
  });

  it('processes one mapped PR using the latest CodeRabbit updatedAt and records task state', async () => {
    const harness = makeHarness();
    const prs = [makePr(101, 'sha-101'), makePr(102, 'sha-102')];
    const github: CodeRabbitGitHubClient = {
      listOpenPullRequests: vi.fn(async () => prs),
      listPullRequestComments: vi.fn(async ({ pullNumber }) => [
        {
          body: `older for ${pullNumber}`,
          updatedAt: '2026-01-01T00:00:00Z',
          userLogin: 'coderabbitai[bot]',
        },
        {
          body: `latest bot for ${pullNumber}`,
          updatedAt: '2026-01-02T00:00:00Z',
          userLogin: 'coderabbitai[bot]',
        },
        {
          body: 'newer human',
          updatedAt: '2026-01-03T00:00:00Z',
          userLogin: 'reviewer',
        },
      ]),
      getPullRequest: vi.fn(async ({ pullNumber }) => makePr(pullNumber, `sha-${pullNumber}`)),
    };
    const runner: CodeRabbitUpdateRunner = {
      run: vi.fn(async () => ({ status: 'completed', summary: 'addressed feedback', sessionId: 'session-1' })),
    };

    const tick = createCodeRabbitUpdateTick({
      store: harness.store,
      logger,
      github,
      runner,
      config: { targetRepo: 'owner/repo', author: 'EdbertChan', login: 'coderabbitai[bot]' },
    });

    await tick({ identity: { kind: CODERABBIT_UPDATE_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });

    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({
      latestUpdatedAt: '2026-01-02T00:00:00Z',
      expectedHeadSha: 'sha-101',
      tasks: [expect.objectContaining({ id: '__merge__wf-1' })],
    }));
    expect(github.listPullRequestComments).toHaveBeenCalledTimes(1);
    const externalKey = codeRabbitActionKey('owner/repo', 101, '2026-01-02T00:00:00Z');
    expect(harness.actions.get(`${CODERABBIT_UPDATE_WORKER_KIND}:${externalKey}`)).toMatchObject({
      workerKind: CODERABBIT_UPDATE_WORKER_KIND,
      actionType: 'address-coderabbit-feedback',
      status: 'completed',
      attemptCount: 1,
      sessionId: 'session-1',
      agentName: 'omp',
    });
    expect(harness.events.some((event) =>
      event.taskId === '__merge__wf-1' && event.eventType === 'task.worker_action')).toBe(true);
  });

  it('does not run the updater for a PR without an Invoker workflow mapping', async () => {
    const harness = makeHarness(null);
    const github: CodeRabbitGitHubClient = {
      listOpenPullRequests: vi.fn(async () => [makePr(101, 'sha-101')]),
      listPullRequestComments: vi.fn(async () => [{
        body: 'feedback',
        updatedAt: '2026-01-02T00:00:00Z',
        userLogin: 'coderabbitai[bot]',
      }]),
      getPullRequest: vi.fn(async () => makePr(101, 'sha-101')),
    };
    const runner: CodeRabbitUpdateRunner = {
      run: vi.fn(async () => ({ status: 'completed' })),
    };

    const tick = createCodeRabbitUpdateTick({
      store: harness.store,
      logger,
      github,
      runner,
      config: { targetRepo: 'owner/repo', login: 'coderabbitai[bot]' },
    });

    await tick({ identity: { kind: CODERABBIT_UPDATE_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });

    expect(runner.run).not.toHaveBeenCalled();
    expect(harness.actions.size).toBe(0);
  });
});
