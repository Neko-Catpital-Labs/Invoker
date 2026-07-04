import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Logger } from '@invoker/contracts';
import type { ReviewGateLookup, WorkerActionRecord, WorkerActionStatus } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import { OmpExecutionAgent } from '../agents/omp-execution-agent.js';
import { cleanElectronEnv, killProcessGroup } from '../process-utils.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';
import type { WorkerGitHubPullRequest, WorkerStateStore } from '../worker-types.js';

export const CODERABBIT_UPDATE_WORKER_KIND = 'coderabbit-update';
export const DEFAULT_CODERABBIT_UPDATE_WORKER_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_CODERABBIT_TARGET_REPO = 'Neko-Catpital-Labs/Invoker';
export const DEFAULT_CODERABBIT_AUTHOR = 'EdbertChan';
export const DEFAULT_CODERABBIT_LOGIN = 'coderabbitai[bot]';
export const DEFAULT_CODERABBIT_MAX_ATTEMPTS = 3;
export const DEFAULT_CODERABBIT_WORKDIR = join(homedir(), '.invoker', 'pr-cron-work');
export const DEFAULT_CODERABBIT_EXECUTION_AGENT = 'omp';
export const DEFAULT_CODERABBIT_TIMEOUT_MS = 45 * 60_000;

const CODERABBIT_ACTION_TYPE = 'address-coderabbit-feedback';
const OPEN_ACTION_STATUSES = new Set<WorkerActionStatus>(['queued', 'pending', 'running']);
const FINAL_MARKER_STATUSES = new Set<WorkerActionStatus>(['completed', 'skipped']);

export interface CodeRabbitComment {
  body: string;
  updatedAt: string;
  userLogin?: string;
  path?: string;
  htmlUrl?: string;
}

export interface CodeRabbitGitHubClient {
  listOpenPullRequests(args: {
    owner: string;
    repo: string;
    author: string;
    limit?: number;
  }): Promise<WorkerGitHubPullRequest[]>;
  listPullRequestComments(args: {
    owner: string;
    repo: string;
    pullNumber: number;
  }): Promise<CodeRabbitComment[]>;
  getPullRequest(args: {
    owner: string;
    repo: string;
    pullNumber: number;
  }): Promise<WorkerGitHubPullRequest | undefined>;
}

export interface CodeRabbitUpdateWorkerConfig {
  enabled?: boolean;
  targetRepo?: string;
  author?: string;
  login?: string;
  maxAttempts?: number;
  workDir?: string;
  executionAgent?: string;
  executionModel?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface ResolvedCodeRabbitUpdateWorkerConfig {
  enabled: boolean;
  targetRepo: string;
  author: string;
  login: string;
  maxAttempts: number;
  workDir: string;
  executionAgent: string;
  executionModel?: string;
  timeoutMs: number;
  pollIntervalMs: number;
}

export interface CodeRabbitUpdateRunnerContext {
  config: ResolvedCodeRabbitUpdateWorkerConfig;
  owner: string;
  repo: string;
  pullRequest: WorkerGitHubPullRequest;
  workflow: ReviewGateLookup;
  tasks: TaskState[];
  comments: CodeRabbitComment[];
  latestUpdatedAt: string;
  expectedHeadSha: string;
}

export interface CodeRabbitUpdateRunnerResult {
  status: 'completed' | 'failed' | 'skipped';
  summary?: string;
  sessionId?: string;
  payload?: Record<string, unknown>;
}

export interface CodeRabbitUpdateRunner {
  run(context: CodeRabbitUpdateRunnerContext): Promise<CodeRabbitUpdateRunnerResult>;
}

export interface CodeRabbitUpdateWorkerPolicyOptions {
  store: WorkerStateStore;
  logger: Logger;
  github?: CodeRabbitGitHubClient;
  runner?: CodeRabbitUpdateRunner;
  config?: CodeRabbitUpdateWorkerConfig;
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

interface ProcessResult {
  stdout: string;
  stderr: string;
}

function expandHomePath(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function parseDurationMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().toLowerCase();
  const match = trimmed.match(/^(\d+)(ms|s|m|h)?$/);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2] ?? 'ms';
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  switch (unit) {
    case 'h':
      return amount * 60 * 60_000;
    case 'm':
      return amount * 60_000;
    case 's':
      return amount * 1_000;
    default:
      return amount;
  }
}

function envFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

export function resolveCodeRabbitUpdateWorkerRuntimeConfig(
  config: CodeRabbitUpdateWorkerConfig = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedCodeRabbitUpdateWorkerConfig {
  const workDir = env.INVOKER_PR_CRON_WORKDIR
    ?? config.workDir
    ?? DEFAULT_CODERABBIT_WORKDIR;
  const executionModel = env.INVOKER_PR_CRON_OMP_MODEL ?? config.executionModel;
  return {
    enabled: envFlag(env.INVOKER_PR_CODERABBIT_ENABLED, config.enabled ?? true),
    targetRepo: env.INVOKER_GITHUB_TARGET_REPO ?? config.targetRepo ?? DEFAULT_CODERABBIT_TARGET_REPO,
    author: env.INVOKER_PR_CRON_AUTHOR ?? config.author ?? DEFAULT_CODERABBIT_AUTHOR,
    login: env.INVOKER_CODERABBIT_LOGIN ?? config.login ?? DEFAULT_CODERABBIT_LOGIN,
    maxAttempts: parsePositiveInteger(env.INVOKER_PR_CODERABBIT_MAX_ATTEMPTS)
      ?? config.maxAttempts
      ?? DEFAULT_CODERABBIT_MAX_ATTEMPTS,
    workDir: expandHomePath(workDir),
    executionAgent: env.INVOKER_PR_CODERABBIT_EXECUTION_AGENT
      ?? config.executionAgent
      ?? DEFAULT_CODERABBIT_EXECUTION_AGENT,
    ...(executionModel ? { executionModel } : {}),
    timeoutMs: parseDurationMs(env.INVOKER_PR_CRON_OMP_TIMEOUT)
      ?? config.timeoutMs
      ?? DEFAULT_CODERABBIT_TIMEOUT_MS,
    pollIntervalMs: config.pollIntervalMs ?? DEFAULT_CODERABBIT_UPDATE_WORKER_INTERVAL_MS,
  };
}

export function splitTargetRepo(targetRepo: string): { owner: string; repo: string } {
  const [owner, repo] = targetRepo.split('/');
  if (!owner || !repo) {
    throw new Error(`Invalid targetRepo "${targetRepo}". Expected "owner/repo".`);
  }
  return { owner, repo };
}

export function latestCodeRabbitCommentUpdatedAt(comments: readonly CodeRabbitComment[]): string | undefined {
  const markers = comments
    .map((comment) => comment.updatedAt)
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .sort();
  return markers.at(-1);
}

export function codeRabbitActionKey(targetRepo: string, pullNumber: number, latestUpdatedAt: string): string {
  return `coderabbit:${targetRepo}:${pullNumber}:${latestUpdatedAt}`;
}

function codeRabbitActionPrefix(targetRepo: string, pullNumber: number): string {
  return `coderabbit:${targetRepo}:${pullNumber}:`;
}

function actionIdForKey(externalKey: string): string {
  const hash = createHash('sha256').update(externalKey).digest('hex').slice(0, 16);
  return `${CODERABBIT_UPDATE_WORKER_KIND}:${hash}`;
}

function markerFromAction(action: WorkerActionRecord, prefix: string): string | undefined {
  if (!action.externalKey.startsWith(prefix)) return undefined;
  return action.externalKey.slice(prefix.length);
}

function latestRecordedFinalMarker(
  options: CodeRabbitUpdateWorkerPolicyOptions,
  targetRepo: string,
  pullNumber: number,
): string | undefined {
  const prefix = codeRabbitActionPrefix(targetRepo, pullNumber);
  const markers = options.store
    .listWorkerActions({ workerKind: CODERABBIT_UPDATE_WORKER_KIND })
    .filter((action) => action.actionType === CODERABBIT_ACTION_TYPE && FINAL_MARKER_STATUSES.has(action.status))
    .map((action) => markerFromAction(action, prefix))
    .filter((marker): marker is string => !!marker)
    .sort();
  return markers.at(-1);
}

function recordCodeRabbitAction(
  options: CodeRabbitUpdateWorkerPolicyOptions,
  args: {
    workflow: ReviewGateLookup;
    pullRequest: WorkerGitHubPullRequest;
    latestUpdatedAt: string;
    status: WorkerActionStatus;
    summary: string;
    payload?: Record<string, unknown>;
    countAttempt?: boolean;
    intentId?: string | number;
    sessionId?: string;
  },
): WorkerActionRecord | undefined {
  const config = resolveCodeRabbitUpdateWorkerRuntimeConfig(options.config);
  const externalKey = codeRabbitActionKey(config.targetRepo, args.pullRequest.number, args.latestUpdatedAt);
  const existing = options.store.getWorkerAction(CODERABBIT_UPDATE_WORKER_KIND, externalKey);
  const now = new Date().toISOString();
  return options.store.upsertWorkerAction({
    id: existing?.id ?? actionIdForKey(externalKey),
    workerKind: CODERABBIT_UPDATE_WORKER_KIND,
    actionType: CODERABBIT_ACTION_TYPE,
    workflowId: args.workflow.workflowId,
    taskId: args.workflow.mergeTaskId,
    subjectType: 'pull_request',
    subjectId: String(args.pullRequest.number),
    externalKey,
    status: args.status,
    attemptCount: (existing?.attemptCount ?? 0) + (args.countAttempt ? 1 : 0),
    ...(args.intentId !== undefined ? { intentId: String(args.intentId) } : {}),
    agentName: config.executionAgent,
    executionModel: config.executionModel,
    sessionId: args.sessionId,
    summary: args.summary,
    payload: {
      targetRepo: config.targetRepo,
      prNumber: args.pullRequest.number,
      prUrl: args.pullRequest.url,
      latestUpdatedAt: args.latestUpdatedAt,
      headSha: args.pullRequest.headSha ?? null,
      branch: args.pullRequest.branch ?? null,
      workflowId: args.workflow.workflowId,
      workflowGeneration: args.workflow.workflowGeneration,
      mergeTaskId: args.workflow.mergeTaskId,
      ...args.payload,
    },
    updatedAt: now,
    ...(args.status === 'completed' || args.status === 'failed' || args.status === 'skipped'
      ? { completedAt: now }
      : {}),
  });
}

function logCodeRabbitWorkerAction(
  options: CodeRabbitUpdateWorkerPolicyOptions,
  args: {
    workflow: ReviewGateLookup;
    pullRequest: WorkerGitHubPullRequest;
    phase: string;
    latestUpdatedAt?: string;
    action?: WorkerActionRecord;
    details?: Record<string, unknown>;
  },
): void {
  const payload = {
    worker: CODERABBIT_UPDATE_WORKER_KIND,
    actionType: CODERABBIT_ACTION_TYPE,
    phase: args.phase,
    workflowId: args.workflow.workflowId,
    prNumber: args.pullRequest.number,
    prUrl: args.pullRequest.url,
    latestUpdatedAt: args.latestUpdatedAt ?? null,
    actionId: args.action?.id ?? null,
    status: args.action?.status ?? null,
    ...args.details,
  };
  options.store.logEvent?.(args.workflow.mergeTaskId, 'task.worker_action', payload);
  options.logger.debug?.(`[worker:${CODERABBIT_UPDATE_WORKER_KIND}] ${args.phase}`, {
    module: 'coderabbit-update-worker',
    taskId: args.workflow.mergeTaskId,
    ...payload,
  });
}

function normalizeComment(raw: Record<string, unknown>): CodeRabbitComment | undefined {
  const body = typeof raw.body === 'string' ? raw.body : '';
  const updatedAt = typeof raw.updated_at === 'string'
    ? raw.updated_at
    : (typeof raw.updatedAt === 'string' ? raw.updatedAt : '');
  if (!updatedAt) return undefined;
  const user = raw.user && typeof raw.user === 'object' ? raw.user as Record<string, unknown> : undefined;
  return {
    body,
    updatedAt,
    userLogin: typeof raw.userLogin === 'string'
      ? raw.userLogin
      : (typeof user?.login === 'string' ? user.login : undefined),
    path: typeof raw.path === 'string' ? raw.path : undefined,
    htmlUrl: typeof raw.html_url === 'string'
      ? raw.html_url
      : (typeof raw.htmlUrl === 'string' ? raw.htmlUrl : undefined),
  };
}

async function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<ProcessResult> {
  return await new Promise<ProcessResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: true,
      env: cleanElectronEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      fn();
    };
    const timeout = options.timeoutMs
      ? setTimeout(() => {
        killProcessGroup(child, 'SIGTERM');
        finish(() => reject(new Error(`${command} timed out after ${options.timeoutMs}ms`)));
      }, options.timeoutMs)
      : undefined;
    timeout?.unref?.();
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (code, signal) => {
      finish(() => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        reject(new Error(`${command} ${args.join(' ')} exited ${code ?? signal ?? 'unknown'}: ${stderr || stdout}`));
      });
    });
  });
}

async function runJson(command: string, args: string[]): Promise<unknown> {
  const { stdout } = await runProcess(command, args);
  const trimmed = stdout.trim();
  return trimmed ? JSON.parse(trimmed) : null;
}

function flattenGhPages(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  if (raw.every((page) => Array.isArray(page))) {
    return raw.flatMap((page) => page as unknown[]);
  }
  return raw;
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function createGhCodeRabbitGitHubClient(): CodeRabbitGitHubClient {
  return {
    async listOpenPullRequests(args) {
      const raw = await runJson('gh', [
        'pr',
        'list',
        '--repo',
        `${args.owner}/${args.repo}`,
        '--author',
        args.author,
        '--state',
        'open',
        '--json',
        'number,url,headRefName,baseRefName,title,headRefOid',
        '--limit',
        String(args.limit ?? 100),
      ]);
      if (!Array.isArray(raw)) return [];
      return raw
        .map((item) => item && typeof item === 'object' ? item as Record<string, unknown> : undefined)
        .filter((item): item is Record<string, unknown> => !!item)
        .map((item) => ({
          owner: args.owner,
          repo: args.repo,
          number: numberField(item, 'number') ?? 0,
          url: stringField(item, 'url') ?? '',
          state: 'open',
          title: stringField(item, 'title'),
          branch: stringField(item, 'headRefName'),
          baseBranch: stringField(item, 'baseRefName'),
          headSha: stringField(item, 'headRefOid'),
        }))
        .filter((pr) => pr.number > 0);
    },
    async listPullRequestComments(args) {
      const pullEndpoint = `repos/${args.owner}/${args.repo}/pulls/${args.pullNumber}/comments`;
      const issueEndpoint = `repos/${args.owner}/${args.repo}/issues/${args.pullNumber}/comments`;
      const [pullRaw, issueRaw] = await Promise.all([
        runJson('gh', ['api', pullEndpoint, '--paginate', '--slurp']).catch(() => []),
        runJson('gh', ['api', issueEndpoint, '--paginate', '--slurp']).catch(() => []),
      ]);
      return [...flattenGhPages(pullRaw), ...flattenGhPages(issueRaw)]
        .map((item) => item && typeof item === 'object' ? normalizeComment(item as Record<string, unknown>) : undefined)
        .filter((comment): comment is CodeRabbitComment => !!comment);
    },
    async getPullRequest(args) {
      const raw = await runJson('gh', [
        'pr',
        'view',
        String(args.pullNumber),
        '--repo',
        `${args.owner}/${args.repo}`,
        '--json',
        'number,url,headRefName,baseRefName,title,headRefOid,state',
      ]).catch(() => undefined);
      if (!raw || typeof raw !== 'object') return undefined;
      const item = raw as Record<string, unknown>;
      const number = numberField(item, 'number');
      if (!number) return undefined;
      return {
        owner: args.owner,
        repo: args.repo,
        number,
        url: stringField(item, 'url') ?? '',
        state: stringField(item, 'state') ?? '',
        title: stringField(item, 'title'),
        branch: stringField(item, 'headRefName'),
        baseBranch: stringField(item, 'baseRefName'),
        headSha: stringField(item, 'headRefOid'),
      };
    },
  };
}

function buildCodeRabbitPrompt(context: CodeRabbitUpdateRunnerContext, contextPath: string): string {
  return [
    `You are addressing CodeRabbit review feedback on GitHub PR #${context.pullRequest.number} in repository ${context.config.targetRepo}.`,
    `You are running inside a checkout of the PR head branch (${context.pullRequest.branch ?? 'unknown'}).`,
    `The context JSON is at ${contextPath}.`,
    '',
    'Read the CodeRabbit comments, the PR diff, the branch commits, and the Invoker task context.',
    'For each distinct CodeRabbit concern, fix only genuine correctness or safety issues.',
    'For each valid concern, add a bash repro under scripts/repro/ that fails before the fix and passes after it.',
    'If no concern is valid, make no commit and exit successfully without pushing.',
    '',
    `Before any git push, confirm the PR head SHA is still ${context.expectedHeadSha}.`,
    'A pre-push hook is installed to reject stale pushes, but you should also check explicitly.',
  ].join('\n');
}

function installHeadShaPrePushHook(checkoutDir: string, targetRepo: string, pullNumber: number, expectedHeadSha: string): void {
  const hooksDir = join(checkoutDir, '.git', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, 'pre-push');
  writeFileSync(hookPath, [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `expected=${JSON.stringify(expectedHeadSha)}`,
    `repo=${JSON.stringify(targetRepo)}`,
    `pr=${JSON.stringify(String(pullNumber))}`,
    'current="$(gh pr view "$pr" --repo "$repo" --json headRefOid --jq .headRefOid)"',
    'if [ "$current" != "$expected" ]; then',
    '  echo "Invoker CodeRabbit worker refusing stale push: PR head is $current, expected $expected" >&2',
    '  exit 1',
    'fi',
  ].join('\n') + '\n', 'utf8');
  chmodSync(hookPath, 0o755);
}

export function createOmpCodeRabbitUpdateRunner(): CodeRabbitUpdateRunner {
  return {
    async run(context) {
      if (context.config.executionAgent !== 'omp') {
        return {
          status: 'failed',
          summary: `Unsupported CodeRabbit executionAgent "${context.config.executionAgent}"`,
        };
      }

      mkdirSync(context.config.workDir, { recursive: true });
      const checkoutDir = join(context.config.workDir, String(context.pullRequest.number));
      if (!existsSync(join(checkoutDir, '.git'))) {
        rmSync(checkoutDir, { recursive: true, force: true });
        await runProcess('gh', [
          'repo',
          'clone',
          context.config.targetRepo,
          checkoutDir,
          '--',
          '--quiet',
        ], { timeoutMs: 5 * 60_000 });
      } else {
        await runProcess('git', ['reset', '--hard'], { cwd: checkoutDir, timeoutMs: 60_000 });
        await runProcess('git', ['clean', '-fd'], { cwd: checkoutDir, timeoutMs: 60_000 });
      }

      await runProcess('git', ['fetch', '--quiet', '--all'], { cwd: checkoutDir, timeoutMs: 5 * 60_000 });
      await runProcess('gh', [
        'pr',
        'checkout',
        String(context.pullRequest.number),
        '--repo',
        context.config.targetRepo,
      ], { cwd: checkoutDir, timeoutMs: 5 * 60_000 });
      await runProcess('git', ['reset', '--hard'], { cwd: checkoutDir, timeoutMs: 60_000 });
      await runProcess('git', ['clean', '-fd'], { cwd: checkoutDir, timeoutMs: 60_000 });
      const head = (await runProcess('git', ['rev-parse', 'HEAD'], { cwd: checkoutDir, timeoutMs: 60_000 })).stdout.trim();
      if (head !== context.expectedHeadSha) {
        return {
          status: 'skipped',
          summary: `Skipped CodeRabbit update because checkout head changed (${head} != ${context.expectedHeadSha})`,
          payload: { checkoutHeadSha: head },
        };
      }

      installHeadShaPrePushHook(
        checkoutDir,
        context.config.targetRepo,
        context.pullRequest.number,
        context.expectedHeadSha,
      );

      const contextPath = join(checkoutDir, '.git', 'invoker-coderabbit-context.json');
      writeFileSync(contextPath, JSON.stringify({
        pr: context.pullRequest,
        workflow: context.workflow,
        tasks: context.tasks,
        coderabbitComments: context.comments,
        latestUpdatedAt: context.latestUpdatedAt,
        expectedHeadSha: context.expectedHeadSha,
      }, null, 2), 'utf8');

      const agent = new OmpExecutionAgent();
      const spec = agent.buildFixCommand?.(
        buildCodeRabbitPrompt(context, contextPath),
        { executionModel: context.config.executionModel },
      ) ?? agent.buildCommand(
        buildCodeRabbitPrompt(context, contextPath),
        { executionModel: context.config.executionModel },
      );
      await runProcess(spec.cmd, spec.args, { cwd: checkoutDir, timeoutMs: context.config.timeoutMs });
      return {
        status: 'completed',
        summary: 'CodeRabbit update runner completed',
        sessionId: spec.sessionId,
        payload: { checkoutDir },
      };
    },
  };
}

function statusFromRunnerStatus(status: CodeRabbitUpdateRunnerResult['status']): WorkerActionStatus {
  return status === 'completed' ? 'completed' : (status === 'skipped' ? 'skipped' : 'failed');
}

async function processCodeRabbitPullRequest(
  options: CodeRabbitUpdateWorkerPolicyOptions,
  config: ResolvedCodeRabbitUpdateWorkerConfig,
  github: CodeRabbitGitHubClient,
  runner: CodeRabbitUpdateRunner,
  pr: WorkerGitHubPullRequest,
): Promise<boolean> {
  const comments = (await github.listPullRequestComments({
    owner: pr.owner,
    repo: pr.repo,
    pullNumber: pr.number,
  })).filter((comment) => comment.userLogin === config.login);
  const latestUpdatedAt = latestCodeRabbitCommentUpdatedAt(comments);
  if (!latestUpdatedAt) return false;

  const workflow = options.store.findReviewGateByPr?.(String(pr.number));
  if (!workflow) {
    options.logger.debug?.(`[worker:${CODERABBIT_UPDATE_WORKER_KIND}] PR #${pr.number} has no Invoker workflow mapping; skip`, {
      module: 'coderabbit-update-worker',
      prNumber: pr.number,
    });
    return false;
  }

  const finalMarker = latestRecordedFinalMarker(options, config.targetRepo, pr.number);
  if (finalMarker && latestUpdatedAt <= finalMarker) {
    logCodeRabbitWorkerAction(options, {
      workflow,
      pullRequest: pr,
      phase: 'worker-coderabbit-skip',
      latestUpdatedAt,
      details: { reason: 'no-new-comments', finalMarker },
    });
    return false;
  }

  const externalKey = codeRabbitActionKey(config.targetRepo, pr.number, latestUpdatedAt);
  const existing = options.store.getWorkerAction(CODERABBIT_UPDATE_WORKER_KIND, externalKey);
  if (existing && (OPEN_ACTION_STATUSES.has(existing.status) || existing.status === 'completed')) {
    logCodeRabbitWorkerAction(options, {
      workflow,
      pullRequest: pr,
      phase: 'worker-coderabbit-skip',
      latestUpdatedAt,
      action: existing,
      details: { reason: 'already-recorded', existingStatus: existing.status },
    });
    return false;
  }
  if (existing && existing.attemptCount >= config.maxAttempts) {
    const action = recordCodeRabbitAction(options, {
      workflow,
      pullRequest: pr,
      latestUpdatedAt,
      status: 'skipped',
      summary: 'Skipped CodeRabbit update because retry budget is exhausted',
      payload: { reason: 'retry-budget-exhausted', maxAttempts: config.maxAttempts },
    });
    logCodeRabbitWorkerAction(options, {
      workflow,
      pullRequest: pr,
      phase: 'worker-coderabbit-skip',
      latestUpdatedAt,
      action,
      details: { reason: 'retry-budget-exhausted', maxAttempts: config.maxAttempts },
    });
    return false;
  }

  const fresh = await github.getPullRequest({ owner: pr.owner, repo: pr.repo, pullNumber: pr.number });
  const expectedHeadSha = fresh?.headSha;
  if (!expectedHeadSha) {
    const action = recordCodeRabbitAction(options, {
      workflow,
      pullRequest: pr,
      latestUpdatedAt,
      status: 'skipped',
      summary: 'Skipped CodeRabbit update because PR head SHA is unavailable',
      payload: { reason: 'missing-head-sha' },
    });
    logCodeRabbitWorkerAction(options, {
      workflow,
      pullRequest: pr,
      phase: 'worker-coderabbit-skip',
      latestUpdatedAt,
      action,
      details: { reason: 'missing-head-sha' },
    });
    return false;
  }
  if (pr.headSha && pr.headSha !== expectedHeadSha) {
    const action = recordCodeRabbitAction(options, {
      workflow,
      pullRequest: { ...pr, headSha: expectedHeadSha },
      latestUpdatedAt,
      status: 'skipped',
      summary: 'Skipped CodeRabbit update because PR head changed before runner launch',
      payload: { reason: 'head-sha-changed', listedHeadSha: pr.headSha, currentHeadSha: expectedHeadSha },
    });
    logCodeRabbitWorkerAction(options, {
      workflow,
      pullRequest: pr,
      phase: 'worker-coderabbit-stale',
      latestUpdatedAt,
      action,
      details: { reason: 'head-sha-changed', listedHeadSha: pr.headSha, currentHeadSha: expectedHeadSha },
    });
    return false;
  }

  const running = recordCodeRabbitAction(options, {
    workflow,
    pullRequest: { ...pr, headSha: expectedHeadSha },
    latestUpdatedAt,
    status: 'running',
    summary: 'Running CodeRabbit update agent',
    payload: { commentCount: comments.length },
    countAttempt: true,
  });
  logCodeRabbitWorkerAction(options, {
    workflow,
    pullRequest: { ...pr, headSha: expectedHeadSha },
    phase: 'worker-coderabbit-started',
    latestUpdatedAt,
    action: running,
    details: { commentCount: comments.length },
  });

  try {
    const result = await runner.run({
      config,
      owner: pr.owner,
      repo: pr.repo,
      pullRequest: { ...pr, headSha: expectedHeadSha },
      workflow,
      tasks: options.store.loadTasks(workflow.workflowId),
      comments,
      latestUpdatedAt,
      expectedHeadSha,
    });
    const action = recordCodeRabbitAction(options, {
      workflow,
      pullRequest: { ...pr, headSha: expectedHeadSha },
      latestUpdatedAt,
      status: statusFromRunnerStatus(result.status),
      summary: result.summary ?? `CodeRabbit update ${result.status}`,
      payload: result.payload,
      sessionId: result.sessionId,
    });
    logCodeRabbitWorkerAction(options, {
      workflow,
      pullRequest: { ...pr, headSha: expectedHeadSha },
      phase: `worker-coderabbit-${result.status}`,
      latestUpdatedAt,
      action,
      details: result.payload,
    });
  } catch (err) {
    const action = recordCodeRabbitAction(options, {
      workflow,
      pullRequest: { ...pr, headSha: expectedHeadSha },
      latestUpdatedAt,
      status: 'failed',
      summary: `CodeRabbit update failed: ${err instanceof Error ? err.message : String(err)}`,
      payload: { error: err instanceof Error ? err.message : String(err) },
    });
    logCodeRabbitWorkerAction(options, {
      workflow,
      pullRequest: { ...pr, headSha: expectedHeadSha },
      phase: 'worker-coderabbit-failed',
      latestUpdatedAt,
      action,
      details: { error: err instanceof Error ? err.message : String(err) },
    });
  }
  return true;
}

export function createCodeRabbitUpdateTick(options: CodeRabbitUpdateWorkerPolicyOptions): WorkerTick {
  return async () => {
    const config = resolveCodeRabbitUpdateWorkerRuntimeConfig(options.config);
    if (!config.enabled) return;
    const { owner, repo } = splitTargetRepo(config.targetRepo);
    const github = options.github ?? createGhCodeRabbitGitHubClient();
    const runner = options.runner ?? createOmpCodeRabbitUpdateRunner();
    let prs: WorkerGitHubPullRequest[];
    try {
      prs = await github.listOpenPullRequests({ owner, repo, author: config.author, limit: 100 });
    } catch (err) {
      options.logger.warn?.(`[worker:${CODERABBIT_UPDATE_WORKER_KIND}] could not list PRs: ${err instanceof Error ? err.message : String(err)}`, {
        module: 'coderabbit-update-worker',
      });
      return;
    }

    for (const pr of prs) {
      const processed = await processCodeRabbitPullRequest(options, config, github, runner, pr);
      if (processed) return;
    }
  };
}

export function createCodeRabbitUpdateWorker(options: CodeRabbitUpdateWorkerOptions): WorkerRuntime {
  const policy = options.coderabbit
    ? createCodeRabbitUpdateTick({
      ...options.coderabbit,
      logger: options.logger,
    })
    : (() => {});
  const config = resolveCodeRabbitUpdateWorkerRuntimeConfig(options.coderabbit?.config);
  return createWorkerRuntime({
    kind: CODERABBIT_UPDATE_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? config.pollIntervalMs,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick: options.onTick ?? policy,
  });
}
