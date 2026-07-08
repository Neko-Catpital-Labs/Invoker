import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ReviewGateLookup, WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';
import {
  CODERABBIT_UPDATE_WORKER_KIND,
  coderabbitActionKey,
  createCoderabbitUpdateTick,
  type PrMaintenanceCommandRunner,
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
  reviewId: '101',
  reviewUrl: 'https://github.com/owner/repo/pull/101',
  branch: 'feature/pr-101',
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

function makeStore(record = mapping) {
  const actions = new Map<string, WorkerActionRecord>();
  const logEvent = vi.fn();
  const store = {
    findReviewGateByPr: vi.fn((pr: string) => (pr === '101' ? record : undefined)),
    loadTasks: vi.fn((_workflowId: string): TaskState[] => [{
      id: 'wf-1/task-1',
      description: 'task',
      status: 'completed',
      dependencies: [],
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      config: { workflowId: 'wf-1' },
      execution: {},
      taskStateVersion: 1,
    } as TaskState]),
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) => actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const saved = toRecord(write);
      actions.set(`${write.workerKind}:${write.externalKey}`, saved);
      return saved;
    }),
    logEvent,
  };
  return { actions, store, logEvent };
}

function makeGithub(options: { secondHeadSha?: string; mappedPr?: boolean } = {}): WorkerGitHubClient {
  const getPullRequest = vi.fn()
    .mockResolvedValueOnce({
      owner: 'owner',
      repo: 'repo',
      number: 101,
      url: 'https://github.com/owner/repo/pull/101',
      state: 'open',
      headSha: 'sha-1',
      branch: 'feature/pr-101',
      baseBranch: 'main',
      title: 'PR 101',
      body: 'body',
    })
    .mockResolvedValue({
      owner: 'owner',
      repo: 'repo',
      number: 101,
      url: 'https://github.com/owner/repo/pull/101',
      state: 'open',
      headSha: options.secondHeadSha ?? 'sha-1',
      branch: 'feature/pr-101',
      baseBranch: 'main',
      title: 'PR 101',
      body: 'body',
    });
  return {
    listPullRequests: vi.fn(async () => [{
      owner: 'owner',
      repo: 'repo',
      number: options.mappedPr === false ? 202 : 101,
      url: `https://github.com/owner/repo/pull/${options.mappedPr === false ? 202 : 101}`,
      state: 'open',
      headSha: 'sha-1',
      branch: 'feature/pr-101',
      baseBranch: 'main',
      title: 'PR 101',
      body: 'body',
    }]),
    getPullRequest,
    listPullRequestReviewComments: vi.fn(async () => [{
      body: 'review comment',
      updatedAt: '2026-01-02T00:00:00Z',
      path: 'src/file.ts',
      url: 'https://github.com/owner/repo/pull/101#discussion_r1',
      authorLogin: 'coderabbitai[bot]',
    }]),
    listIssueComments: vi.fn(async () => [{
      body: 'summary comment',
      updatedAt: '2026-01-03T00:00:00Z',
      url: 'https://github.com/owner/repo/pull/101#issuecomment-1',
      authorLogin: 'coderabbitai[bot]',
    }]),
  };
}

function makeCommandRunner(workDir: string, statusOutput = '') {
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  let revParseCalls = 0;
  const runner: PrMaintenanceCommandRunner = vi.fn(async (command, args, options) => {
    calls.push({ command, args, cwd: options?.cwd });
    if (command === 'git' && args[0] === 'rev-parse') {
      revParseCalls += 1;
      return { stdout: revParseCalls === 1 ? 'local-sha-1\n' : 'local-sha-2\n', stderr: '' };
    }
    if (command === 'git' && args[0] === 'status') {
      return { stdout: statusOutput, stderr: '' };
    }
    return { stdout: '', stderr: '' };
  });
  mkdirSync(join(workDir, '101', '.git'), { recursive: true });
  return { calls, runner };
}

describe('CodeRabbit update worker', () => {
  let workDir: string | undefined;

  afterEach(() => {
    vi.clearAllMocks();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  });

  it('addresses one mapped PR, records worker_actions, logs task.worker_action, and pushes after head-SHA confirmation', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'coderabbit-worker-'));
    const h = makeStore();
    const github = makeGithub();
    const commands = makeCommandRunner(workDir);
    const tick = createCoderabbitUpdateTick({
      store: h.store,
      logger,
      github,
      commandRunner: commands.runner,
      targetRepo: 'owner/repo',
      workDir,
      now: () => new Date('2026-01-04T00:00:00.000Z'),
    });

    await tick({ identity: { kind: CODERABBIT_UPDATE_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });

    const key = coderabbitActionKey(101, '2026-01-03T00:00:00Z');
    expect(h.actions.get(`${CODERABBIT_UPDATE_WORKER_KIND}:${key}`)).toMatchObject({
      workerKind: CODERABBIT_UPDATE_WORKER_KIND,
      actionType: 'address-coderabbit-feedback',
      status: 'completed',
      attemptCount: 1,
      taskId: '__merge__wf-1',
      payload: expect.objectContaining({
        latestMarker: '2026-01-03T00:00:00Z',
        pushed: true,
      }),
    });
    expect(commands.calls.some((call) => call.command === 'omp')).toBe(true);
    expect(commands.calls).toContainEqual(expect.objectContaining({
      command: 'git',
      args: ['push', 'origin', 'HEAD:refs/heads/feature/pr-101'],
    }));
    expect(h.logEvent).toHaveBeenCalledWith(
      '__merge__wf-1',
      'task.worker_action',
      expect.objectContaining({
        worker: CODERABBIT_UPDATE_WORKER_KIND,
        status: 'completed',
        prNumber: '101',
      }),
    );
  });

  it('does not push when the PR head SHA changed after the agent ran', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'coderabbit-worker-'));
    const h = makeStore();
    const github = makeGithub({ secondHeadSha: 'sha-2' });
    const commands = makeCommandRunner(workDir);

    await createCoderabbitUpdateTick({
      store: h.store,
      logger,
      github,
      commandRunner: commands.runner,
      targetRepo: 'owner/repo',
      workDir,
    })({ identity: { kind: CODERABBIT_UPDATE_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });

    expect(commands.calls.some((call) => call.command === 'git' && call.args[0] === 'push')).toBe(false);
    const action = [...h.actions.values()].at(-1);
    expect(action).toMatchObject({
      status: 'failed',
      payload: expect.objectContaining({
        reason: 'head-sha-changed',
        expectedHeadSha: 'sha-1',
        currentHeadSha: 'sha-2',
      }),
    });
  });

  it('does not mutate PRs that have no Invoker workflow mapping', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'coderabbit-worker-'));
    const h = makeStore();
    const github = makeGithub({ mappedPr: false });
    const commands = makeCommandRunner(workDir);

    await createCoderabbitUpdateTick({
      store: h.store,
      logger,
      github,
      commandRunner: commands.runner,
      targetRepo: 'owner/repo',
      workDir,
    })({ identity: { kind: CODERABBIT_UPDATE_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });

    expect(commands.calls).toEqual([]);
    expect(h.actions.size).toBe(0);
  });
});
