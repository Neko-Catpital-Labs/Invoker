import { describe, expect, it, vi } from 'vitest';

import {
  createPrQueueDequeuePublisherTick,
  parseMergifyDequeuedComment,
} from '../workers/pr-queue-dequeue-publisher-worker.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };

describe('pr queue-dequeue publisher worker', () => {
  const body = [
    'Left the queue `admin-bypass` at `abc1234`.',
    '-*- Mergify Payload -*-',
    '{"state":"dequeued","queue_rule_name":"admin-bypass"}',
    '',
    'Failing checks',
    '- quality / TypeScript Types',
  ].join('\n');

  it('parses a current-head Mergify dequeue comment', () => {
    expect(parseMergifyDequeuedComment({
      id: '900',
      body,
      updatedAt: '2026-01-02T00:00:00Z',
    })).toEqual({
      headSha: 'abc1234',
      failedChecks: ['quality / TypeScript Types'],
    });
  });

  it('publishes only a dequeue that belongs to the current PR head', async () => {
    const publish = vi.fn();
    const github = {
      listOpenPullRequests: vi.fn(async () => [{
        number: 42,
        headRefOid: 'abc1234',
        baseRefName: 'master',
        labels: [{ name: 'admin-bypass' }],
      }]),
      fetchIssueComments: vi.fn(async () => [{ id: '900', body, updatedAt: '2026-01-02T00:00:00Z' }]),
    };
    const tick = createPrQueueDequeuePublisherTick({
      store: { findReviewGateByPr: () => ({ workflowId: 'wf-42' }) },
      publish,
      logger,
      repo: 'owner/repo',
      author: 'author',
      github: github as never,
    });

    await tick({ identity: { kind: 'test', instanceId: 'test' }, reason: 'wake', tickNumber: 1, signal: new AbortController().signal });

    expect(publish).toHaveBeenCalledWith({
      repo: 'owner/repo',
      prNumber: 42,
      headSha: 'abc1234',
      dequeueCommentId: '900',
      failedChecks: ['quality / TypeScript Types'],
      workflowId: 'wf-42',
      baseRef: 'master',
      labelsJson: '[{"name":"admin-bypass"}]',
    });
  });
});
