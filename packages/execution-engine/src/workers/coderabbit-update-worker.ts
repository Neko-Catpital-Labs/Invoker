import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Logger } from '@invoker/contracts';
import type {
  WorkerActionRecord,
  WorkerActionStatus,
  WorkerActionWrite,
} from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import type {
  WorkerGitHubClient,
  WorkerGitHubComment,
  WorkerGitHubPullRequest,
  WorkerStateStore,
} from '../worker-types.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const CODERABBIT_UPDATE_WORKER_KIND = 'coderabbit-update';
export const DEFAULT_CODERABBIT_UPDATE_WORKER_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_CODERABBIT_TARGET_REPO = 'Neko-Catpital-Labs/Invoker';
export const DEFAULT_CODERABBIT_AUTHOR = 'EdbertChan';
export const DEFAULT_CODERABBIT_LOGIN = 'coderabbitai[bot]';
export const DEFAULT_CODERABBIT_MAX_ATTEMPTS = 3;
export const DEFAULT_CODERABBIT_WORK_DIR = join(homedir(), '.invoker', 'pr-cron-work');
export const DEFAULT_CODERABBIT_EXECUTION_AGENT = 'omp';
export const DEFAULT_CODERABBIT_TIMEOUT_MS = 45 * 60_000;

const CODERABBIT_ACTION_TYPE = 'address-coderabbit-feedback';
const OPEN_OR_DONE_STATUSES = new Set<WorkerActionStatus>([
  'queued',
  'pending',
  'running',
  'needs_input',
  'review_ready',
  'completed',
]);

export interface CodeRabbitCommentContext {
  body: string;
  updatedAt: string;
  path?: string;
  htmlUrl?: string;
}

export interface CodeRabbitUpdateContext {
  targetRepo: string;
  pullRequest: WorkerGitHubPullRequest;
  latestMarker: string;
  comments: CodeRabbitCommentContext[];
  invokerTasks: TaskState[];
  workflowId: string;
  mergeTaskId: string;
  workDir: string;
  executionAgent: string;
  executionModel?: string;
  timeoutMs: number;
  expectedHeadSha?: string;
}

export interface CodeRabbitUpdateResult {
  ok: boolean;
  summary?: string;
  sessionId?: string;
}

export interface CodeRabbitUpdateAgent {
  addressFeedback(context: CodeRabbitUpdateContext): Promise<CodeRabbitUpdateResult>;
}

export interface CodeRabbitUpdateWorkerPolicyOptions {
  store: WorkerStateStore;
  github: WorkerGitHubClient;
  updateAgent: CodeRabbitUpdateAgent;
  logger: Logger;
  targetRepo?: string;
  author?: string;
  login?: string;
  maxAttempts?: number;
  workDir?: string;
  executionAgent?: string;
  executionModel?: string;
  timeoutMs?: number;
}

export interface CodeRabbitUpdateWorkerOptions {
  logger: Logger;
  instanceId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  coderabbit?: Omit<CodeRabbitUpdateWorkerPolicyOptions, 'logger'>;
  onTick?: WorkerTick;
}

interface RepoParts {
  owner: string;
  repo: string;
}

interface ReviewGateMapping {
  workflowId: string;
  mergeTaskId: string;
  workflowGeneration: number;
}

function parseTargetRepo(targetRepo: string): RepoParts {
  const [owner, repo] = targetRepo.split('/');
  if (!owner || !repo) {
    throw new Error(`Invalid targetRepo "${targetRepo}". Expected owner/repo.`);
  }
  return { owner, repo };
}

function maxUpdatedAt(comments: readonly CodeRabbitCommentContext[]): string | undefined {
  return comments
    .map((comment) => comment.updatedAt)
    .filter((value) => value.length > 0)
    .sort()
    .at(-1);
}

function normalizeComment(comment: WorkerGitHubComment): CodeRabbitCommentContext | undefined {
  if (!comment.updatedAt) return undefined;
  return {
    body: comment.body,
    updatedAt: comment.updatedAt,
    ...(comment.path ? { path: comment.path } : {}),
    ...(comment.htmlUrl ? { htmlUrl: comment.htmlUrl } : {}),
  };
}

async function collectCodeRabbitComments(
  github: WorkerGitHubClient,
  repo: RepoParts,
  pullNumber: number,
  login: string,
): Promise<CodeRabbitCommentContext[]> {
  const [reviewComments, issueComments] = await Promise.all([
    github.listPullRequestReviewComments?.({ ...repo, pullNumber }) ?? Promise.resolve([]),
    github.listPullRequestIssueComments?.({ ...repo, pullNumber }) ?? Promise.resolve([]),
  ]);
  return [...reviewComments, ...issueComments]
    .filter((comment) => comment.authorLogin === login)
    .map(normalizeComment)
    .filter((comment): comment is CodeRabbitCommentContext => Boolean(comment));
}

export function codeRabbitActionKey(args: {
  targetRepo: string;
  pullNumber: number;
  latestMarker: string;
}): string {
  return [
    CODERABBIT_UPDATE_WORKER_KIND,
    args.targetRepo,
    `pr-${args.pullNumber}`,
    args.latestMarker,
  ].join(':');
}

function actionIdForKey(externalKey: string): string {
  return `${CODERABBIT_UPDATE_WORKER_KIND}:${externalKey}`;
}

function getExistingAction(
  options: CodeRabbitUpdateWorkerPolicyOptions,
  externalKey: string,
): WorkerActionRecord | undefined {
  return options.store.getWorkerAction(CODERABBIT_UPDATE_WORKER_KIND, externalKey);
}

function logWorkerAction(
  options: CodeRabbitUpdateWorkerPolicyOptions,
  action: WorkerActionRecord | WorkerActionWrite,
  phase: string,
): void {
  const taskId = action.taskId;
  if (!taskId) return;
  options.store.logEvent?.(taskId, 'task.worker_action', {
    phase,
    worker: CODERABBIT_UPDATE_WORKER_KIND,
    workerKind: action.workerKind,
    actionType: action.actionType,
    externalKey: action.externalKey,
    status: action.status,
    attemptCount: action.attemptCount ?? 0,
    summary: action.summary ?? null,
    payload: action.payload ?? null,
  });
}

function recordCodeRabbitAction(
  options: CodeRabbitUpdateWorkerPolicyOptions,
  args: {
    externalKey: string;
    status: WorkerActionStatus;
    pullNumber: number;
    summary: string;
    payload?: Record<string, unknown>;
    mapping?: ReviewGateMapping;
    consumeAttempt?: boolean;
    sessionId?: string;
  },
): WorkerActionRecord {
  const existing = getExistingAction(options, args.externalKey);
  const now = new Date().toISOString();
  const attemptCount = args.consumeAttempt
    ? (existing?.attemptCount ?? 0) + 1
    : existing?.attemptCount ?? 0;
  const write: WorkerActionWrite = {
    id: existing?.id ?? actionIdForKey(args.externalKey),
    workerKind: CODERABBIT_UPDATE_WORKER_KIND,
    actionType: CODERABBIT_ACTION_TYPE,
    workflowId: args.mapping?.workflowId,
    taskId: args.mapping?.mergeTaskId,
    subjectType: 'pull_request',
    subjectId: String(args.pullNumber),
    externalKey: args.externalKey,
    status: args.status,
    attemptCount,
    agentName: options.executionAgent ?? DEFAULT_CODERABBIT_EXECUTION_AGENT,
    executionModel: options.executionModel,
    sessionId: args.sessionId,
    summary: args.summary,
    payload: {
      pullNumber: args.pullNumber,
      targetRepo: options.targetRepo ?? DEFAULT_CODERABBIT_TARGET_REPO,
      login: options.login ?? DEFAULT_CODERABBIT_LOGIN,
      maxAttempts: options.maxAttempts ?? DEFAULT_CODERABBIT_MAX_ATTEMPTS,
      ...(args.mapping ? {
        workflowId: args.mapping.workflowId,
        mergeTaskId: args.mapping.mergeTaskId,
        workflowGeneration: args.mapping.workflowGeneration,
      } : {}),
      ...(args.payload ?? {}),
    },
    updatedAt: now,
    ...(args.status === 'completed' || args.status === 'failed' || args.status === 'skipped'
      ? { completedAt: now }
      : {}),
  };
  const saved = options.store.upsertWorkerAction(write);
  logWorkerAction(options, saved, `coderabbit-update-${args.status}`);
  return saved;
}

function shouldSkipExistingAction(
  options: CodeRabbitUpdateWorkerPolicyOptions,
  externalKey: string,
): boolean {
  const existing = getExistingAction(options, externalKey);
  return existing ? OPEN_OR_DONE_STATUSES.has(existing.status) : false;
}

function normalizeMaxAttempts(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CODERABBIT_MAX_ATTEMPTS;
  if (!Number.isFinite(value)) return DEFAULT_CODERABBIT_MAX_ATTEMPTS;
  return Math.max(0, Math.floor(value));
}

function readMapping(
  store: WorkerStateStore,
  pullNumber: number,
): ReviewGateMapping | undefined {
  const record = store.findReviewGateByPr?.(String(pullNumber));
  if (!record?.workflowId || !record.mergeTaskId) return undefined;
  return {
    workflowId: record.workflowId,
    mergeTaskId: record.mergeTaskId,
    workflowGeneration: record.workflowGeneration ?? 0,
  };
}

async function handleCodeRabbitPullRequest(
  options: CodeRabbitUpdateWorkerPolicyOptions,
  repo: RepoParts,
  pr: WorkerGitHubPullRequest,
): Promise<boolean> {
  const targetRepo = options.targetRepo ?? DEFAULT_CODERABBIT_TARGET_REPO;
  const login = options.login ?? DEFAULT_CODERABBIT_LOGIN;
  const comments = await collectCodeRabbitComments(options.github, repo, pr.number, login);
  const latestMarker = maxUpdatedAt(comments);
  if (!latestMarker) return false;

  const externalKey = codeRabbitActionKey({ targetRepo, pullNumber: pr.number, latestMarker });
  if (shouldSkipExistingAction(options, externalKey)) {
    options.logger.debug?.(`[worker:${CODERABBIT_UPDATE_WORKER_KIND}] skip already recorded CodeRabbit marker`, {
      module: 'coderabbit-update-worker',
      pullNumber: pr.number,
      latestMarker,
    });
    return false;
  }

  const mapping = readMapping(options.store, pr.number);
  if (!mapping) {
    recordCodeRabbitAction(options, {
      externalKey,
      status: 'skipped',
      pullNumber: pr.number,
      summary: 'Skipped CodeRabbit update because PR has no Invoker workflow mapping',
      payload: { reason: 'review-gate-mapping-not-found', latestMarker },
    });
    return false;
  }

  const maxAttempts = normalizeMaxAttempts(options.maxAttempts);
  const existing = getExistingAction(options, externalKey);
  if ((existing?.attemptCount ?? 0) >= maxAttempts) {
    recordCodeRabbitAction(options, {
      externalKey,
      status: 'skipped',
      pullNumber: pr.number,
      mapping,
      summary: 'Skipped CodeRabbit update because attempt cap is exhausted',
      payload: { reason: 'attempt-cap-exhausted', latestMarker },
    });
    return false;
  }

  const currentPr = await options.github.getPullRequest({
    ...repo,
    pullNumber: pr.number,
  });
  if (!currentPr) {
    recordCodeRabbitAction(options, {
      externalKey,
      status: 'skipped',
      pullNumber: pr.number,
      mapping,
      summary: 'Skipped CodeRabbit update because PR no longer exists',
      payload: { reason: 'pull-request-not-found', latestMarker },
    });
    return false;
  }

  const expectedHeadSha = pr.headSha ?? currentPr.headSha;
  if (expectedHeadSha && currentPr.headSha && currentPr.headSha !== expectedHeadSha) {
    recordCodeRabbitAction(options, {
      externalKey,
      status: 'skipped',
      pullNumber: pr.number,
      mapping,
      summary: 'Skipped CodeRabbit update because PR head SHA changed before mutation',
      payload: {
        reason: 'head-sha-changed',
        latestMarker,
        expectedHeadSha,
        currentHeadSha: currentPr.headSha,
      },
    });
    return false;
  }

  recordCodeRabbitAction(options, {
    externalKey,
    status: 'running',
    pullNumber: pr.number,
    mapping,
    consumeAttempt: true,
    summary: 'Running CodeRabbit feedback update',
    payload: {
      latestMarker,
      commentCount: comments.length,
      headSha: expectedHeadSha ?? null,
    },
  });

  const context: CodeRabbitUpdateContext = {
    targetRepo,
    pullRequest: { ...pr, ...currentPr },
    latestMarker,
    comments,
    invokerTasks: options.store.loadTasks(mapping.workflowId),
    workflowId: mapping.workflowId,
    mergeTaskId: mapping.mergeTaskId,
    workDir: options.workDir ?? DEFAULT_CODERABBIT_WORK_DIR,
    executionAgent: options.executionAgent ?? DEFAULT_CODERABBIT_EXECUTION_AGENT,
    executionModel: options.executionModel,
    timeoutMs: options.timeoutMs ?? DEFAULT_CODERABBIT_TIMEOUT_MS,
    expectedHeadSha,
  };

  let result: CodeRabbitUpdateResult;
  try {
    result = await options.updateAgent.addressFeedback(context);
  } catch (err) {
    recordCodeRabbitAction(options, {
      externalKey,
      status: 'failed',
      pullNumber: pr.number,
      mapping,
      summary: 'CodeRabbit feedback update failed',
      payload: {
        latestMarker,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return true;
  }

  recordCodeRabbitAction(options, {
    externalKey,
    status: result.ok ? 'completed' : 'failed',
    pullNumber: pr.number,
    mapping,
    summary: result.summary ?? (result.ok
      ? 'CodeRabbit feedback update completed'
      : 'CodeRabbit feedback update failed'),
    sessionId: result.sessionId,
    payload: {
      latestMarker,
      headSha: expectedHeadSha ?? null,
      ok: result.ok,
    },
  });
  return true;
}

export function createCodeRabbitUpdateTick(options: CodeRabbitUpdateWorkerPolicyOptions): WorkerTick {
  return async () => {
    if (!options.github.listPullRequests) {
      options.logger.debug?.(`[worker:${CODERABBIT_UPDATE_WORKER_KIND}] GitHub listPullRequests unavailable`, {
        module: 'coderabbit-update-worker',
      });
      return;
    }

    const targetRepo = options.targetRepo ?? DEFAULT_CODERABBIT_TARGET_REPO;
    const repo = parseTargetRepo(targetRepo);
    const prs = await options.github.listPullRequests({
      ...repo,
      author: options.author ?? DEFAULT_CODERABBIT_AUTHOR,
      state: 'open',
      limit: 100,
    });

    for (const pr of prs) {
      const handled = await handleCodeRabbitPullRequest(options, repo, pr);
      if (handled) return;
    }
  };
}

export function createCodeRabbitUpdateWorker(options: CodeRabbitUpdateWorkerOptions): WorkerRuntime {
  const onTick = options.onTick ?? (
    options.coderabbit
      ? createCodeRabbitUpdateTick({ ...options.coderabbit, logger: options.logger })
      : (() => {})
  );
  return createWorkerRuntime({
    kind: CODERABBIT_UPDATE_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_CODERABBIT_UPDATE_WORKER_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick,
  });
}

export function registerCodeRabbitUpdateWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: CODERABBIT_UPDATE_WORKER_KIND,
    note: 'Addresses new CodeRabbit PR feedback for Invoker-mapped review-gate PRs.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createCodeRabbitUpdateWorker({
        logger: deps.logger,
        intervalMs: deps.prMaintenance?.coderabbit?.pollIntervalMs,
        coderabbit: deps.github && deps.codeRabbitUpdateAgent
          ? {
              store: deps.store,
              github: deps.github,
              updateAgent: deps.codeRabbitUpdateAgent,
              targetRepo: deps.prMaintenance?.targetRepo,
              author: deps.prMaintenance?.author,
              login: deps.prMaintenance?.coderabbit?.login,
              maxAttempts: deps.prMaintenance?.coderabbit?.maxAttempts,
              workDir: deps.prMaintenance?.coderabbit?.workDir,
              executionAgent: deps.prMaintenance?.coderabbit?.executionAgent,
              executionModel: deps.prMaintenance?.coderabbit?.executionModel,
              timeoutMs: deps.prMaintenance?.coderabbit?.timeoutMs,
            }
          : undefined,
      }),
  });
  return registry;
}
