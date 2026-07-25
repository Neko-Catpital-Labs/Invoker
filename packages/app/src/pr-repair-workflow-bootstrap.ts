import type { Logger } from '@invoker/contracts';
import type { SQLiteAdapter } from '@invoker/data-store';
import {
  createPrMaintenanceGitHub,
  parseMergifyStackMetadata,
  resolveCurrentPullRequestStack,
  spawnPrMaintenanceCommand,
  type PullRequestIssueComment,
  type TaskRunner,
} from '@invoker/execution-engine';
import { type Orchestrator, type PlanDefinition, type TaskState } from '@invoker/workflow-core';

import { loadPlanSubmissionDefinitions } from './plan-submission-loader.js';

type LivePullRequest = {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  labels: unknown;
};

type DequeueBootstrapRecord = {
  kind: 'dequeue-bootstrap';
  stackId: string;
  workflowIdsByPr: Record<string, string>;
};

const PULL_REQUEST_FIELDS = ['number', 'title', 'url', 'headRefName', 'headRefOid', 'baseRefName', 'labels'] as const;

export async function ensureDequeuedPrRepairWorkflow(
  input: {
    repo: string;
    prNumber: number;
    headSha: string;
    dequeueCommentId: string;
    failedChecks: readonly string[];
  },
  deps: {
    persistence: SQLiteAdapter;
    orchestrator: Orchestrator;
    taskExecutor: TaskRunner;
    logger: Logger;
    allowGraphMutation: boolean;
    repoRoot: string;
  },
): Promise<{ workflowId: string } | undefined> {
  const existing = deps.persistence.findReviewGateByPr(String(input.prNumber));
  if (existing) {
    return { workflowId: existing.workflowId };
  }

  const github = createPrMaintenanceGitHub({
    run: spawnPrMaintenanceCommand,
    repo: input.repo,
    author: process.env.INVOKER_PR_CRON_AUTHOR ?? 'EdbertChan',
    logger: deps.logger,
    sleep: async () => {},
  });

  const currentPullRequest = normalizePullRequestRecord(
    await github.viewPullRequest(input.prNumber, [...PULL_REQUEST_FIELDS]),
  );
  if (!currentPullRequest) {
    return undefined;
  }

  const openPullRequests = dedupePullRequests([
    ...(await github.listOpenPullRequests([...PULL_REQUEST_FIELDS])).map(normalizePullRequestRecord).filter(isDefined),
    currentPullRequest,
  ]);

  const commentsByPr = new Map<number, readonly PullRequestIssueComment[]>();
  const currentComments = await github.fetchIssueComments(input.prNumber);
  commentsByPr.set(input.prNumber, currentComments);

  if (currentPullRequest.headRefOid !== input.headSha) {
    return undefined;
  }

  const currentMarker = parseMergifyStackMetadata(currentComments);
  if (currentMarker) {
    const missingCommentNumbers = currentMarker.pulls
      .map((pull) => pull.number)
      .filter((prNumber) => prNumber !== input.prNumber && !commentsByPr.has(prNumber));
    const fetchedComments = await Promise.all(missingCommentNumbers.map(async (prNumber) => ({
      prNumber,
      comments: await github.fetchIssueComments(prNumber),
    })));
    for (const entry of fetchedComments) {
      commentsByPr.set(entry.prNumber, entry.comments);
    }
  }

  const resolvedStack = resolveCurrentPullRequestStack(
    openPullRequests,
    commentsByPr,
    input.prNumber,
    currentPullRequest.baseRefName || 'main',
  );
  const pullRequestsByNumber = new Map(openPullRequests.map((pullRequest) => [pullRequest.number, pullRequest]));
  const stackPullRequests = resolvedStack.pulls.map((pull) => {
    const livePullRequest = pullRequestsByNumber.get(pull.number);
    if (!livePullRequest) {
      throw new Error(`Open pull request ${pull.number} is missing from ${input.repo} stack ${resolvedStack.stackId}.`);
    }
    return livePullRequest;
  });

  const workflowIdsByPr = reuseBootstrappedWorkflows(stackPullRequests, input.repo, resolvedStack.stackId, deps.persistence)
    ?? await rebuildBootstrappedWorkflows(stackPullRequests, input.repo, deps);

  const repairWorkflowsJson = JSON.stringify({
    kind: 'dequeue-bootstrap',
    stackId: resolvedStack.stackId,
    workflowIdsByPr,
  } satisfies DequeueBootstrapRecord);
  const nowIso = new Date().toISOString();
  stackPullRequests.forEach((pullRequest, stackOrder) => {
    deps.persistence.upsertPrMirror({
      repo: input.repo,
      prNumber: pullRequest.number,
      headSha: pullRequest.headRefOid,
      baseRef: pullRequest.baseRefName,
      labelsJson: JSON.stringify(pullRequest.labels ?? []),
      stackId: resolvedStack.stackId,
      stackOrder,
      workflowId: workflowIdsByPr[String(pullRequest.number)],
      repairWorkflowsJson,
      updatedAt: nowIso,
    });
  });

  const workflowId = workflowIdsByPr[String(input.prNumber)];
  if (!workflowId) {
    throw new Error(`Bootstrapped stack ${resolvedStack.stackId} did not include PR ${input.prNumber}.`);
  }
  return { workflowId };
}

function reuseBootstrappedWorkflows(
  stackPullRequests: readonly LivePullRequest[],
  repo: string,
  stackId: string,
  persistence: SQLiteAdapter,
): Record<string, string> | undefined {
  const targetPrKeys = stackPullRequests.map((pullRequest) => String(pullRequest.number));
  const records = stackPullRequests.map((pullRequest) => {
    const mirror = persistence.getPrMirror(repo, pullRequest.number);
    if (!mirror?.repairWorkflowsJson) {
      return undefined;
    }
    return parseDequeueBootstrapRecord(mirror.repairWorkflowsJson);
  });
  const [firstRecord, ...restRecords] = records;
  if (!firstRecord || firstRecord.stackId !== stackId) {
    return undefined;
  }
  if (!hasCompleteWorkflowMap(firstRecord.workflowIdsByPr, targetPrKeys, persistence)) {
    return undefined;
  }
  for (const record of restRecords) {
    if (!record || record.stackId !== stackId) {
      return undefined;
    }
    if (!targetPrKeys.every((prKey) => record.workflowIdsByPr[prKey] === firstRecord.workflowIdsByPr[prKey])) {
      return undefined;
    }
  }
  return { ...firstRecord.workflowIdsByPr };
}

async function rebuildBootstrappedWorkflows(
  stackPullRequests: readonly LivePullRequest[],
  repo: string,
  deps: {
    persistence: SQLiteAdapter;
    orchestrator: Orchestrator;
    taskExecutor: TaskRunner;
    logger: Logger;
    allowGraphMutation: boolean;
    repoRoot: string;
  },
): Promise<Record<string, string>> {
  const repoUrl = (await deps.taskExecutor.execGitReadonly(['remote', 'get-url', 'origin'], deps.repoRoot)).trim();
  const definitions = stackPullRequests.map((pullRequest) => ({
    name: `Repair PR #${pullRequest.number} — ${pullRequest.title}`,
    repoUrl,
    baseBranch: pullRequest.baseRefName,
    featureBranch: pullRequest.headRefName,
    onFinish: 'none',
    mergeMode: 'manual',
    tasks: [{
      id: 'repair-anchor',
      description: 'Bootstrap existing PR branch for worker-owned repair',
      command: 'true',
    }],
  } satisfies PlanDefinition));
  const { workflowIds } = loadPlanSubmissionDefinitions(definitions, {
    orchestrator: deps.orchestrator,
    persistence: deps.persistence,
    logger: deps.logger,
    allowGraphMutation: deps.allowGraphMutation,
  });

  const workflowIdsByPr: Record<string, string> = {};
  for (const [index, workflowId] of workflowIds.entries()) {
    const pullRequest = stackPullRequests[index];
    if (!pullRequest) {
      throw new Error(`Missing pull request for workflow ${workflowId}.`);
    }
    await bindWorkflowToExistingPullRequest(workflowId, pullRequest, repo, repoUrl, deps);
    workflowIdsByPr[String(pullRequest.number)] = workflowId;
  }
  return workflowIdsByPr;
}

async function bindWorkflowToExistingPullRequest(
  workflowId: string,
  pullRequest: LivePullRequest,
  repo: string,
  repoUrl: string,
  deps: {
    persistence: SQLiteAdapter;
    orchestrator: Orchestrator;
    taskExecutor: TaskRunner;
  },
): Promise<void> {
  const tasks = deps.persistence.loadTasks(workflowId);
  const anchorTask = singleTask(tasks, workflowId, false);
  const mergeTask = singleTask(tasks, workflowId, true);
  const workspacePath = await deps.taskExecutor.createMergeWorktree(
    pullRequest.headRefName,
    `repair-pr-${pullRequest.number}`,
    repoUrl,
  );
  const completedAt = new Date();

  deps.persistence.updateTask(anchorTask.id, {
    status: 'completed',
    execution: {
      branch: pullRequest.headRefName,
      commit: pullRequest.headRefOid,
      completedAt,
    },
  });
  deps.persistence.updateTask(mergeTask.id, {
    status: 'review_ready',
    config: { runnerKind: 'worktree' },
    execution: {
      branch: pullRequest.headRefName,
      workspacePath,
      reviewId: `${repo}#${pullRequest.number}`,
      reviewUrl: pullRequest.url,
      reviewProviderId: `${repo}#${pullRequest.number}`,
      reviewStatus: 'Awaiting review',
      completedAt,
    },
  });
  deps.orchestrator.syncFromDb(workflowId);
}
function parseDequeueBootstrapRecord(value: string): DequeueBootstrapRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }
  const record = parsed as {
    kind?: unknown;
    stackId?: unknown;
    workflowIdsByPr?: unknown;
  };
  if (record.kind !== 'dequeue-bootstrap' || typeof record.stackId !== 'string') {
    return undefined;
  }
  if (!record.workflowIdsByPr || typeof record.workflowIdsByPr !== 'object') {
    return undefined;
  }
  const workflowIdsByPr: Record<string, string> = {};
  for (const [prKey, workflowId] of Object.entries(record.workflowIdsByPr)) {
    if (typeof workflowId !== 'string' || workflowId.length === 0) {
      return undefined;
    }
    workflowIdsByPr[prKey] = workflowId;
  }
  return { kind: 'dequeue-bootstrap', stackId: record.stackId, workflowIdsByPr };
}

function hasCompleteWorkflowMap(
  workflowIdsByPr: Readonly<Record<string, string>>,
  targetPrKeys: readonly string[],
  persistence: SQLiteAdapter,
): boolean {
  return targetPrKeys.every((prKey) => {
    const workflowId = workflowIdsByPr[prKey];
    return typeof workflowId === 'string' && workflowId.length > 0 && persistence.loadWorkflow(workflowId) !== undefined;
  });
}

function singleTask(
  tasks: readonly TaskState[],
  workflowId: string,
  isMergeNode: boolean,
): TaskState {
  const matches = tasks.filter((task) => Boolean(task.config.isMergeNode) === isMergeNode);
  if (matches.length !== 1) {
    throw new Error(`Workflow ${workflowId} has ${matches.length} ${isMergeNode ? 'merge' : 'anchor'} bootstrap tasks.`);
  }
  return matches[0]!;
}

function normalizePullRequestRecord(value: Record<string, unknown>): LivePullRequest | undefined {
  const number = toPrNumber(value.number);
  if (number === undefined) return undefined;
  return {
    number,
    title: stringOrFallback(value.title, `PR #${number}`),
    url: stringOrFallback(value.url, ''),
    headRefName: stringOrFallback(value.headRefName, ''),
    headRefOid: stringOrFallback(value.headRefOid, ''),
    baseRefName: stringOrFallback(value.baseRefName, ''),
    labels: value.labels,
  };
}

function dedupePullRequests(pullRequests: readonly LivePullRequest[]): LivePullRequest[] {
  const byNumber = new Map<number, LivePullRequest>();
  for (const pullRequest of pullRequests) {
    byNumber.set(pullRequest.number, pullRequest);
  }
  return Array.from(byNumber.values()).sort((left, right) => left.number - right.number);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function stringOrFallback(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function toPrNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : undefined;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}
