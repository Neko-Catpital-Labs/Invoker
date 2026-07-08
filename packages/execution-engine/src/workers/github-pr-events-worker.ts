import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { Logger } from '@invoker/contracts';
import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import { Channels, type MessageBus } from '@invoker/transport';

import type { GitHubPrEvent, GitHubPrEventChange } from '../pr-maintenance-events.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';

export const GITHUB_PR_EVENTS_WORKER_KIND = 'github-pr-events';
export const DEFAULT_GITHUB_PR_EVENTS_INTERVAL_MS = 300_000;
const CODERABBIT_LOGIN = 'coderabbitai[bot]';
const MERGIFY_LOGIN = 'mergify[bot]';
const SNAPSHOT_EXTERNAL_KEY_PREFIX = 'snapshot:';

interface GitHubPrListItem {
  number: number;
  headRefName?: string;
  mergeStateStatus?: string;
  labels?: Array<{ name?: string | null }>;
}

interface GitHubComment {
  updated_at?: string;
  user?: { login?: string | null };
}

export interface GitHubPrSnapshot {
  readonly prNumber: number;
  readonly repo: string;
  readonly author: string;
  readonly headRefName: string;
  readonly mergeState: 'clean' | 'dirty' | 'unknown';
  readonly labels: readonly string[];
  readonly coderabbitCommentUpdatedAt?: string;
  readonly mergifyCommentUpdatedAt?: string;
  readonly open: boolean;
}

export interface GitHubPrEventsStore {
  getWorkerAction(workerKind: string, externalKey: string): WorkerActionRecord | undefined;
  upsertWorkerAction(action: WorkerActionWrite): WorkerActionRecord;
  listWorkerActions(filters?: { workerKind?: string; status?: string; limit?: number }): WorkerActionRecord[];
}

export interface GitHubPrEventsConfig {
  readonly repo: string;
  readonly author: string;
  readonly coderabbitLogin?: string;
  readonly mergifyLogin?: string;
  readonly intervalMs?: number;
}

export interface GitHubPrClient {
  listOpenPullRequests(repo: string, author: string): readonly GitHubPrListItem[];
  listIssueComments(repo: string, prNumber: number): readonly GitHubComment[];
  listReviewComments(repo: string, prNumber: number): readonly GitHubComment[];
}

export interface GitHubPrEventsTickOptions {
  readonly logger: Logger;
  readonly store: GitHubPrEventsStore;
  readonly messageBus: MessageBus;
  readonly config: GitHubPrEventsConfig;
  readonly client?: GitHubPrClient;
  readonly now?: () => Date;
}

export interface GitHubPrEventsWorkerOptions extends GitHubPrEventsTickOptions {
  readonly instanceId?: string;
  readonly installSignalHandlers?: boolean;
  readonly tickOnStart?: boolean;
  readonly onTick?: WorkerTick;
}

function parseJsonArray<T>(command: string[], logger: Logger): readonly T[] {
  try {
    const stdout = execFileSync('gh', command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const parsed = JSON.parse(stdout) as unknown;
    return Array.isArray(parsed) ? parsed as readonly T[] : [];
  } catch (error) {
    logger.warn?.('[worker:github-pr-events] gh command failed', {
      module: 'github-pr-events-worker',
      command,
      error,
    });
    return [];
  }
}

export function createGitHubPrClient(logger: Logger): GitHubPrClient {
  return {
    listOpenPullRequests(repo: string, author: string): readonly GitHubPrListItem[] {
      return parseJsonArray<GitHubPrListItem>([
        'pr', 'list',
        '--repo', repo,
        '--author', author,
        '--state', 'open',
        '--limit', '100',
        '--json', 'number,headRefName,mergeStateStatus,labels',
      ], logger);
    },
    listIssueComments(repo: string, prNumber: number): readonly GitHubComment[] {
      return parseJsonArray<GitHubComment>([
        'api',
        `repos/${repo}/issues/${prNumber}/comments`,
        '--paginate',
      ], logger);
    },
    listReviewComments(repo: string, prNumber: number): readonly GitHubComment[] {
      return parseJsonArray<GitHubComment>([
        'api',
        `repos/${repo}/pulls/${prNumber}/comments`,
        '--paginate',
      ], logger);
    },
  };
}

function normalizeMergeState(raw: string | undefined): 'clean' | 'dirty' | 'unknown' {
  if (raw === 'CLEAN') return 'clean';
  if (raw === 'DIRTY' || raw === 'CONFLICTING') return 'dirty';
  return 'unknown';
}

function latestCommentUpdatedAt(comments: readonly GitHubComment[], login: string): string | undefined {
  let latest: string | undefined;
  for (const comment of comments) {
    if (comment.user?.login !== login || typeof comment.updated_at !== 'string') continue;
    if (!latest || comment.updated_at > latest) latest = comment.updated_at;
  }
  return latest;
}

function snapshotExternalKey(prNumber: number): string {
  return `${SNAPSHOT_EXTERNAL_KEY_PREFIX}${prNumber}`;
}

function loadSnapshot(record: WorkerActionRecord | undefined): GitHubPrSnapshot | undefined {
  if (!record?.payload || typeof record.payload !== 'object') return undefined;
  const payload = record.payload as Record<string, unknown>;
  const labels = payload.labels;
  if (!Array.isArray(labels) || !labels.every((entry) => typeof entry === 'string')) return undefined;
  if (typeof payload.prNumber !== 'number' || typeof payload.repo !== 'string' || typeof payload.author !== 'string') {
    return undefined;
  }
  if (typeof payload.headRefName !== 'string' || (payload.mergeState !== 'clean' && payload.mergeState !== 'dirty' && payload.mergeState !== 'unknown')) {
    return undefined;
  }
  return {
    prNumber: payload.prNumber,
    repo: payload.repo,
    author: payload.author,
    headRefName: payload.headRefName,
    mergeState: payload.mergeState,
    labels,
    coderabbitCommentUpdatedAt: typeof payload.coderabbitCommentUpdatedAt === 'string' ? payload.coderabbitCommentUpdatedAt : undefined,
    mergifyCommentUpdatedAt: typeof payload.mergifyCommentUpdatedAt === 'string' ? payload.mergifyCommentUpdatedAt : undefined,
    open: payload.open !== false,
  };
}

function createEventKey(snapshot: GitHubPrSnapshot, changes: readonly GitHubPrEventChange[]): string {
  const marker = [
    snapshot.headRefName,
    snapshot.mergeState,
    snapshot.coderabbitCommentUpdatedAt ?? 'no-coderabbit',
    snapshot.mergifyCommentUpdatedAt ?? 'no-mergify',
    snapshot.labels.join(','),
    snapshot.open ? 'open' : 'closed',
  ].join('|');
  return `${snapshot.repo}#${snapshot.prNumber}:${changes.join(',')}:${marker}`;
}

function saveSnapshot(
  store: GitHubPrEventsStore,
  snapshot: GitHubPrSnapshot,
  existing: WorkerActionRecord | undefined,
  nowIso: string,
): void {
  store.upsertWorkerAction({
    id: existing?.id ?? randomUUID(),
    workerKind: GITHUB_PR_EVENTS_WORKER_KIND,
    actionType: 'snapshot',
    subjectType: 'pull_request',
    subjectId: String(snapshot.prNumber),
    externalKey: snapshotExternalKey(snapshot.prNumber),
    status: 'completed',
    summary: `${snapshot.repo}#${snapshot.prNumber} ${snapshot.open ? 'open' : 'closed'} ${snapshot.mergeState}`,
    payload: snapshot,
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
    completedAt: nowIso,
  });
}

function buildSnapshot(
  pr: GitHubPrListItem,
  comments: readonly GitHubComment[],
  repo: string,
  author: string,
  coderabbitLogin: string,
  mergifyLogin: string,
): GitHubPrSnapshot {
  const labels: string[] = [];
  for (const label of pr.labels ?? []) {
    if (typeof label.name === 'string' && label.name.length > 0) labels.push(label.name);
  }
  labels.sort();
  return {
    prNumber: pr.number,
    repo,
    author,
    headRefName: pr.headRefName ?? '',
    mergeState: normalizeMergeState(pr.mergeStateStatus),
    labels,
    coderabbitCommentUpdatedAt: latestCommentUpdatedAt(comments, coderabbitLogin),
    mergifyCommentUpdatedAt: latestCommentUpdatedAt(comments, mergifyLogin),
    open: true,
  };
}

export function buildGitHubPrEvent(
  previous: GitHubPrSnapshot | undefined,
  current: GitHubPrSnapshot,
  nowIso: string,
): GitHubPrEvent | undefined {
  const changes: GitHubPrEventChange[] = [];
  if (!previous) {
    changes.push('opened');
  } else {
    if (previous.headRefName !== current.headRefName) changes.push('head_ref_changed');
    if (previous.mergeState !== current.mergeState) changes.push('merge_state_changed');
    if (previous.coderabbitCommentUpdatedAt !== current.coderabbitCommentUpdatedAt) changes.push('coderabbit_comment');
    if (previous.mergifyCommentUpdatedAt !== current.mergifyCommentUpdatedAt) changes.push('mergify_comment');
    if (previous.labels.join('\u0000') !== current.labels.join('\u0000')) changes.push('labels_changed');
  }
  if (changes.length === 0) return undefined;
  return {
    eventKey: createEventKey(current, changes),
    repo: current.repo,
    prNumber: current.prNumber,
    author: current.author,
    headRefName: current.headRefName,
    mergeState: current.mergeState,
    labels: [...current.labels],
    coderabbitCommentUpdatedAt: current.coderabbitCommentUpdatedAt,
    mergifyCommentUpdatedAt: current.mergifyCommentUpdatedAt,
    changes,
    createdAt: nowIso,
  };
}

export function buildClosedGitHubPrEvent(previous: GitHubPrSnapshot, nowIso: string): GitHubPrEvent {
  const current: GitHubPrSnapshot = { ...previous, open: false };
  return {
    eventKey: createEventKey(current, ['closed']),
    repo: previous.repo,
    prNumber: previous.prNumber,
    author: previous.author,
    headRefName: previous.headRefName,
    mergeState: previous.mergeState,
    labels: [...previous.labels],
    coderabbitCommentUpdatedAt: previous.coderabbitCommentUpdatedAt,
    mergifyCommentUpdatedAt: previous.mergifyCommentUpdatedAt,
    changes: ['closed'],
    createdAt: nowIso,
  };
}

export function createGitHubPrEventsTick(options: GitHubPrEventsTickOptions): WorkerTick {
  const client = options.client ?? createGitHubPrClient(options.logger);
  const coderabbitLogin = options.config.coderabbitLogin ?? CODERABBIT_LOGIN;
  const mergifyLogin = options.config.mergifyLogin ?? MERGIFY_LOGIN;
  return async () => {
    const nowIso = (options.now ?? (() => new Date()))().toISOString();
    const currentByPr = new Map<number, GitHubPrSnapshot>();
    const prs = client.listOpenPullRequests(options.config.repo, options.config.author);

    for (const pr of prs) {
      const comments = [
        ...client.listIssueComments(options.config.repo, pr.number),
        ...client.listReviewComments(options.config.repo, pr.number),
      ];
      const snapshot = buildSnapshot(pr, comments, options.config.repo, options.config.author, coderabbitLogin, mergifyLogin);
      currentByPr.set(snapshot.prNumber, snapshot);
      const existing = options.store.getWorkerAction(GITHUB_PR_EVENTS_WORKER_KIND, snapshotExternalKey(snapshot.prNumber));
      const previous = loadSnapshot(existing);
      const event = buildGitHubPrEvent(previous, snapshot, nowIso);
      if (event) {
        options.messageBus.publish(Channels.GITHUB_PR_EVENT, event);
      }
      saveSnapshot(options.store, snapshot, existing, nowIso);
    }

    for (const action of options.store.listWorkerActions({ workerKind: GITHUB_PR_EVENTS_WORKER_KIND })) {
      if (!action.externalKey.startsWith(SNAPSHOT_EXTERNAL_KEY_PREFIX)) continue;
      const previous = loadSnapshot(action);
      if (!previous || !previous.open || currentByPr.has(previous.prNumber)) continue;
      options.messageBus.publish(Channels.GITHUB_PR_EVENT, buildClosedGitHubPrEvent(previous, nowIso));
      saveSnapshot(options.store, { ...previous, open: false }, action, nowIso);
    }
  };
}

export function createGitHubPrEventsWorker(options: GitHubPrEventsWorkerOptions): WorkerRuntime {
  return createWorkerRuntime({
    kind: GITHUB_PR_EVENTS_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.config.intervalMs ?? DEFAULT_GITHUB_PR_EVENTS_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? true,
    installSignalHandlers: options.installSignalHandlers,
    onTick: options.onTick ?? createGitHubPrEventsTick(options),
  });
}
export function registerGitHubPrEventsWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: GITHUB_PR_EVENTS_WORKER_KIND,
    note: 'Polls GitHub once and publishes shared PR maintenance wake events.',
    factory: (deps) => {
      const config = deps.prMaintenance?.githubPrEvents;
      if (!config?.enabled || !deps.messageBus) {
        return createWorkerRuntime({
          kind: GITHUB_PR_EVENTS_WORKER_KIND,
          logger: deps.logger,
          intervalMs: 0,
          tickOnStart: false,
          onTick: async () => {},
        });
      }
      return createGitHubPrEventsWorker({
        logger: deps.logger,
        store: deps.store,
        messageBus: deps.messageBus,
        config,
      });
    },
  });
  return registry;
}
