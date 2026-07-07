import { describe, expect, it } from 'vitest';
import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import { Channels, LocalBus } from '@invoker/transport';

import type { GitHubPrEvent } from '../pr-maintenance-events.js';
import { isGitHubPrEvent } from '../pr-maintenance-events.js';
import {
  GITHUB_PR_EVENTS_WORKER_KIND,
  buildClosedGitHubPrEvent,
  buildGitHubPrEvent,
  createGitHubPrEventsTick,
} from '../workers/github-pr-events-worker.js';

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => logger,
};

function createStore() {
  const byKey = new Map<string, WorkerActionRecord>();
  return {
    store: {
      getWorkerAction(workerKind: string, externalKey: string) {
        const action = byKey.get(`${workerKind}:${externalKey}`);
        return action ? { ...action } : undefined;
      },
      upsertWorkerAction(action: WorkerActionWrite) {
        const key = `${action.workerKind}:${action.externalKey}`;
        const existing = byKey.get(key);
        const record: WorkerActionRecord = {
          id: existing?.id ?? action.id,
          workerKind: action.workerKind,
          actionType: action.actionType,
          workflowId: action.workflowId,
          taskId: action.taskId,
          subjectType: action.subjectType,
          subjectId: action.subjectId,
          externalKey: action.externalKey,
          status: action.status,
          attemptCount: action.attemptCount ?? existing?.attemptCount ?? 0,
          intentId: action.intentId,
          agentName: action.agentName,
          executionModel: action.executionModel,
          sessionId: action.sessionId,
          summary: action.summary,
          payload: action.payload,
          createdAt: existing?.createdAt ?? action.createdAt ?? '2026-01-01T00:00:00.000Z',
          updatedAt: action.updatedAt ?? '2026-01-01T00:00:00.000Z',
          completedAt: action.completedAt,
        };
        byKey.set(key, record);
        return { ...record };
      },
      listWorkerActions(filters?: { workerKind?: string }) {
        return [...byKey.values()]
          .filter((action) => !filters?.workerKind || action.workerKind === filters.workerKind)
          .map((action) => ({ ...action }));
      },
    },
    byKey,
  };
}

describe('github PR maintenance events', () => {
  it('builds an opened event for a first-seen PR snapshot', () => {
    const event = buildGitHubPrEvent(undefined, {
      prNumber: 17,
      repo: 'owner/repo',
      author: 'octocat',
      headRefName: 'feature/red-ci',
      mergeState: 'clean',
      labels: ['queue'],
      coderabbitCommentUpdatedAt: '2026-07-07T00:00:00Z',
      mergifyCommentUpdatedAt: undefined,
      open: true,
    }, '2026-07-07T01:00:00Z');

    expect(event).toMatchObject({
      repo: 'owner/repo',
      prNumber: 17,
      changes: ['opened'],
    });
    expect(isGitHubPrEvent(event)).toBe(true);
  });

  it('builds delta events for merge-state, label, and bot-comment changes', () => {
    const event = buildGitHubPrEvent({
      prNumber: 17,
      repo: 'owner/repo',
      author: 'octocat',
      headRefName: 'feature/red-ci',
      mergeState: 'clean',
      labels: ['queue'],
      coderabbitCommentUpdatedAt: '2026-07-07T00:00:00Z',
      mergifyCommentUpdatedAt: '2026-07-07T00:10:00Z',
      open: true,
    }, {
      prNumber: 17,
      repo: 'owner/repo',
      author: 'octocat',
      headRefName: 'feature/red-ci',
      mergeState: 'dirty',
      labels: ['queue', 'needs-attention'],
      coderabbitCommentUpdatedAt: '2026-07-07T00:20:00Z',
      mergifyCommentUpdatedAt: '2026-07-07T00:10:00Z',
      open: true,
    }, '2026-07-07T01:00:00Z');

    expect(event?.changes).toEqual([
      'merge_state_changed',
      'coderabbit_comment',
      'labels_changed',
    ]);
  });

  it('publishes change and close events while persisting snapshots', async () => {
    const bus = new LocalBus();
    const events: GitHubPrEvent[] = [];
    bus.subscribe<GitHubPrEvent>(Channels.GITHUB_PR_EVENT, (event) => events.push(event));
    const store = createStore();

    const state = {
      prs: [{ number: 42, headRefName: 'feature/start', mergeStateStatus: 'CLEAN', labels: [{ name: 'queue' }] }],
      issueComments: [{ user: { login: 'coderabbitai[bot]' }, updated_at: '2026-07-07T00:00:00Z' }],
      reviewComments: [{ user: { login: 'mergify[bot]' }, updated_at: '2026-07-07T00:10:00Z' }],
    };

    const tick = createGitHubPrEventsTick({
      logger,
      store: store.store,
      messageBus: bus,
      config: { repo: 'owner/repo', author: 'octocat' },
      now: () => new Date('2026-07-07T01:00:00Z'),
      client: {
        listOpenPullRequests: () => state.prs,
        listIssueComments: () => state.issueComments,
        listReviewComments: () => state.reviewComments,
      },
    });

    await tick({ identity: { kind: GITHUB_PR_EVENTS_WORKER_KIND, instanceId: 'w1' }, reason: 'manual', tickNumber: 1 });
    expect(events).toHaveLength(1);
    expect(events[0]?.changes).toEqual(['opened']);
    expect(store.byKey.get(`${GITHUB_PR_EVENTS_WORKER_KIND}:snapshot:42`)?.payload).toMatchObject({
      mergeState: 'clean',
      open: true,
    });

    state.prs = [{ number: 42, headRefName: 'feature/start', mergeStateStatus: 'DIRTY', labels: [{ name: 'queue' }, { name: 'needs-attention' }] }];
    state.issueComments = [{ user: { login: 'coderabbitai[bot]' }, updated_at: '2026-07-07T00:20:00Z' }];
    await tick({ identity: { kind: GITHUB_PR_EVENTS_WORKER_KIND, instanceId: 'w1' }, reason: 'manual', tickNumber: 2 });
    expect(events[1]?.changes).toEqual([
      'merge_state_changed',
      'coderabbit_comment',
      'labels_changed',
    ]);

    state.prs = [];
    state.issueComments = [];
    state.reviewComments = [];
    await tick({ identity: { kind: GITHUB_PR_EVENTS_WORKER_KIND, instanceId: 'w1' }, reason: 'manual', tickNumber: 3 });
    expect(events[2]).toEqual(buildClosedGitHubPrEvent({
      prNumber: 42,
      repo: 'owner/repo',
      author: 'octocat',
      headRefName: 'feature/start',
      mergeState: 'dirty',
      labels: ['needs-attention', 'queue'],
      coderabbitCommentUpdatedAt: '2026-07-07T00:20:00Z',
      mergifyCommentUpdatedAt: '2026-07-07T00:10:00Z',
      open: true,
    }, '2026-07-07T01:00:00.000Z'));
    expect(store.byKey.get(`${GITHUB_PR_EVENTS_WORKER_KIND}:snapshot:42`)?.payload).toMatchObject({
      open: false,
    });
  });
});
