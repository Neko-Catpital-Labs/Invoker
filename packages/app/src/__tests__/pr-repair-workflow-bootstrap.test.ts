import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '@invoker/contracts';
import { SQLiteAdapter } from '@invoker/data-store';
import type * as ExecutionEngineModule from '@invoker/execution-engine';
import {
  createPrMaintenanceGitHub,
  type PrMaintenanceGitHub,
  type TaskRunner,
} from '@invoker/execution-engine';
import { InMemoryBus } from '@invoker/test-kit';
import { Orchestrator } from '@invoker/workflow-core';

import { ensureDequeuedPrRepairWorkflow } from '../pr-repair-workflow-bootstrap.js';

vi.mock('@invoker/execution-engine', async () => {
  const actual = await vi.importActual<typeof ExecutionEngineModule>('@invoker/execution-engine');
  return {
    ...actual,
    createPrMaintenanceGitHub: vi.fn(),
  };
});

type PullRequestFixture = {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  labels: unknown;
};

type BootstrapTaskExecutor = Pick<TaskRunner, 'execGitReadonly' | 'createMergeWorktree'>;

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
};

const STACK_5800: PullRequestFixture[] = [
  { number: 5800, title: 'PR 5800', url: 'https://github.com/owner/repo/pull/5800', headRefName: 'stack/5800', headRefOid: 'sha-5800', baseRefName: 'main', labels: ['admin-bypass'] },
  { number: 5801, title: 'PR 5801', url: 'https://github.com/owner/repo/pull/5801', headRefName: 'stack/5801', headRefOid: 'sha-5801', baseRefName: 'stack/5800', labels: ['admin-bypass'] },
  { number: 5802, title: 'PR 5802', url: 'https://github.com/owner/repo/pull/5802', headRefName: 'stack/5802', headRefOid: 'sha-5802', baseRefName: 'stack/5801', labels: ['admin-bypass'] },
  { number: 5803, title: 'PR 5803', url: 'https://github.com/owner/repo/pull/5803', headRefName: 'stack/5803', headRefOid: 'sha-5803', baseRefName: 'stack/5802', labels: ['admin-bypass'] },
  { number: 5804, title: 'PR 5804', url: 'https://github.com/owner/repo/pull/5804', headRefName: 'stack/5804', headRefOid: 'sha-5804', baseRefName: 'stack/5803', labels: ['admin-bypass'] },
  { number: 5805, title: 'PR 5805', url: 'https://github.com/owner/repo/pull/5805', headRefName: 'stack/5805', headRefOid: 'sha-5805', baseRefName: 'stack/5804', labels: ['admin-bypass'] },
];

const SINGLE_5810: PullRequestFixture = {
  number: 5810,
  title: 'PR 5810',
  url: 'https://github.com/owner/repo/pull/5810',
  headRefName: 'stack/5810',
  headRefOid: 'sha-5810',
  baseRefName: 'main',
  labels: ['admin-bypass'],
};

const adapters: SQLiteAdapter[] = [];
let github: PrMaintenanceGitHub;

beforeEach(() => {
  github = {
    listOpenPullRequests: vi.fn(async () => []),
    viewPullRequest: vi.fn(async () => ({})),
    fetchCoderabbitComments: vi.fn(async () => []),
    fetchIssueComments: vi.fn(async () => []),
    postPullRequestComment: vi.fn(async () => true),
  };
  vi.mocked(createPrMaintenanceGitHub).mockReturnValue(github);
});

afterEach(() => {
  vi.restoreAllMocks();
  while (adapters.length > 0) {
    adapters.pop()?.close();
  }
});

function makePullRequestRecord(pullRequest: PullRequestFixture): Record<string, unknown> {
  return {
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    headRefName: pullRequest.headRefName,
    headRefOid: pullRequest.headRefOid,
    baseRefName: pullRequest.baseRefName,
    labels: pullRequest.labels,
  };
}

async function makeContext() {
  const persistence = await SQLiteAdapter.create(':memory:');
  adapters.push(persistence);
  const orchestrator = new Orchestrator({
    persistence,
    messageBus: new InMemoryBus(),
  });
  const taskExecutor = {
    execGitReadonly: vi.fn(async () => 'git@github.com:owner/repo.git\n'),
    createMergeWorktree: vi.fn(async (_ref: string, label: string) => `/tmp/${label}`),
  } satisfies BootstrapTaskExecutor;
  const startExecution = vi.spyOn(orchestrator, 'startExecution');
  return {
    persistence,
    orchestrator,
    startExecution,
    taskExecutor: taskExecutor as unknown as TaskRunner,
    createMergeWorktree: taskExecutor.createMergeWorktree,
  };
}

describe('ensureDequeuedPrRepairWorkflow', () => {
  it('reconstructs the #5800 stack from hidden marker data and binds every PR to a review-ready workflow', async () => {
    const ctx = await makeContext();
    const marker = '<!-- mergify-stack-data: {"stack_id":"stack/5800","pull_numbers_bottom_to_top":[5800,5801,5802,5803,5804,5805]} -->';
    vi.mocked(github.viewPullRequest).mockResolvedValue(makePullRequestRecord(STACK_5800[0]!));
    vi.mocked(github.listOpenPullRequests).mockResolvedValue(STACK_5800.map(makePullRequestRecord));
    vi.mocked(github.fetchIssueComments).mockImplementation(async (prNumber) => (
      prNumber === 5800 ? [{ id: 'c-5800', body: marker, updatedAt: '2026-07-25T00:00:00Z' }] : []
    ));

    const result = await ensureDequeuedPrRepairWorkflow({
      repo: 'owner/repo',
      prNumber: 5800,
      headSha: 'sha-5800',
      dequeueCommentId: 'c-5800',
      failedChecks: ['CI'],
    }, {
      persistence: ctx.persistence,
      orchestrator: ctx.orchestrator,
      taskExecutor: ctx.taskExecutor,
      logger,
      allowGraphMutation: false,
      repoRoot: '/repo',
    });

    expect(result?.workflowId).toBeDefined();
    expect(ctx.persistence.listWorkflows()).toHaveLength(6);
    expect(ctx.createMergeWorktree).toHaveBeenCalledTimes(6);
    expect(ctx.startExecution).not.toHaveBeenCalled();
    expect(vi.mocked(github.fetchIssueComments)).toHaveBeenCalledWith(5800);
    expect(vi.mocked(github.fetchIssueComments)).toHaveBeenCalledWith(5805);

    const workflowIdsByPr: Record<string, string> = {};
    for (const pullRequest of STACK_5800) {
      const lookup = ctx.persistence.findReviewGateByPr(String(pullRequest.number));
      expect(lookup?.workflowId).toBeDefined();
      workflowIdsByPr[String(pullRequest.number)] = lookup?.workflowId ?? '';
      const tasks = ctx.persistence.loadTasks(lookup?.workflowId ?? '');
      const mergeTask = tasks.find((task) => task.config.isMergeNode);
      expect(mergeTask?.status).toBe('review_ready');
      expect(mergeTask?.execution.reviewId).toBe(`owner/repo#${pullRequest.number}`);
      expect(mergeTask?.execution.reviewUrl).toBe(pullRequest.url);
      expect(mergeTask?.execution.branch).toBe(pullRequest.headRefName);
      expect(mergeTask?.execution.workspacePath).toBe(`/tmp/repair-pr-${pullRequest.number}`);
    }

    const mirror = ctx.persistence.getPrMirror('owner/repo', 5800);
    expect(mirror?.repairWorkflowsJson).toBe(JSON.stringify({
      kind: 'dequeue-bootstrap',
      stackId: 'stack/5800',
      workflowIdsByPr,
    }));
  });

  it('creates exactly one workflow for a standalone unmapped PR', async () => {
    const ctx = await makeContext();
    vi.mocked(github.viewPullRequest).mockResolvedValue(makePullRequestRecord(SINGLE_5810));
    vi.mocked(github.listOpenPullRequests).mockResolvedValue([makePullRequestRecord(SINGLE_5810)]);
    vi.mocked(github.fetchIssueComments).mockResolvedValue([]);

    const result = await ensureDequeuedPrRepairWorkflow({
      repo: 'owner/repo',
      prNumber: 5810,
      headSha: 'sha-5810',
      dequeueCommentId: 'c-5810',
      failedChecks: ['CI'],
    }, {
      persistence: ctx.persistence,
      orchestrator: ctx.orchestrator,
      taskExecutor: ctx.taskExecutor,
      logger,
      allowGraphMutation: false,
      repoRoot: '/repo',
    });

    expect(result?.workflowId).toBeDefined();
    expect(ctx.persistence.listWorkflows()).toHaveLength(1);
    expect(ctx.createMergeWorktree).toHaveBeenCalledTimes(1);
    expect(ctx.persistence.findReviewGateByPr('5810')?.workflowId).toBe(result?.workflowId);
  });
});
