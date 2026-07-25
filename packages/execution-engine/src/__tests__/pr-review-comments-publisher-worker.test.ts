import { describe, expect, it, vi } from 'vitest';

import { createPrReviewCommentsPublisherTick } from '../workers/pr-review-comments-publisher-worker.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };

describe('pr review-comments publisher worker', () => {
  it('publishes the newest CodeRabbit marker for each open PR', async () => {
    const publish = vi.fn();
    const github = {
      listOpenPullRequests: vi.fn(async () => [{
        number: 42,
        headRefOid: 'head-42',
        baseRefName: 'master',
        labels: [{ name: 'admin-bypass' }],
      }]),
      fetchCoderabbitComments: vi.fn(async () => [
        { body: 'old', updatedAt: '2026-01-01T00:00:00Z', path: null, htmlUrl: 'https://example.invalid/old' },
        { body: 'new', updatedAt: '2026-01-02T00:00:00Z', path: null, htmlUrl: 'https://example.invalid/new' },
      ]),
    };
    const tick = createPrReviewCommentsPublisherTick({
      store: { findReviewGateByPr: () => ({ workflowId: 'wf-42' }) },
      publish,
      logger,
      repo: 'owner/repo',
      author: 'author',
      botLogin: 'coderabbitai[bot]',
      github: github as never,
    });

    await tick({ identity: { kind: 'test', instanceId: 'test' }, reason: 'wake', tickNumber: 1, signal: new AbortController().signal });

    expect(publish).toHaveBeenCalledWith({
      repo: 'owner/repo',
      prNumber: 42,
      headSha: 'head-42',
      commentMarker: '2026-01-02T00:00:00Z',
      commentUrls: ['https://example.invalid/old', 'https://example.invalid/new'],
      workflowId: 'wf-42',
      baseRef: 'master',
      labelsJson: '[{"name":"admin-bypass"}]',
    });
  });
});
