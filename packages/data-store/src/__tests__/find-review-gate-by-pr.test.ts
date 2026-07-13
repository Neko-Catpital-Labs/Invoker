import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import type { Workflow } from '../adapter.js';
import type { TaskState } from '@invoker/workflow-core';

/**
 * findReviewGateByPr maps a published GitHub PR back to its Invoker workflow via
 * the merge node (`is_merge_node = 1`), matching on either the bare PR number
 * (review_id) or the full PR URL (review_url). Workflow status is a derived
 * rollup, not a column, so the multi-candidate tie-break is computed in JS.
 */
describe('SQLiteAdapter.findReviewGateByPr', () => {
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  function makeWorkflow(id: string, overrides: Partial<Workflow> = {}): Workflow {
    return {
      id,
      name: `Workflow ${id}`,
      status: 'running',
      baseBranch: 'main',
      generation: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  function makeMergeTask(
    workflowId: string,
    overrides: { status?: TaskState['status']; reviewId?: string; reviewUrl?: string; branch?: string } = {},
  ): TaskState {
    return {
      id: `__merge__${workflowId}`,
      description: `Merge ${workflowId}`,
      status: overrides.status ?? 'completed',
      dependencies: [],
      createdAt: new Date(),
      config: { workflowId, isMergeNode: true },
      execution: {
        reviewId: overrides.reviewId,
        reviewUrl: overrides.reviewUrl,
        branch: overrides.branch,
      },
      taskStateVersion: 1,
    };
  }

  it('resolves a PR by review_id to its workflow', () => {
    adapter.saveWorkflow(makeWorkflow('wf-1', { baseBranch: 'develop' }));
    adapter.saveTask('wf-1', makeMergeTask('wf-1', {
      status: 'running',
      reviewId: '999',
      reviewUrl: 'https://github.com/owner/repo/pull/999',
      branch: 'stack/edbert/plan/feature--abc',
    }));

    const result = adapter.findReviewGateByPr('999');
    expect(result).toBeDefined();
    expect(result?.workflowId).toBe('wf-1');
    expect(result?.mergeTaskId).toBe('__merge__wf-1');
    expect(result?.reviewId).toBe('999');
    expect(result?.branch).toBe('stack/edbert/plan/feature--abc');
    expect(result?.baseBranch).toBe('develop');
    expect(result?.workflowStatus).toBe('running');
  });

  it('resolves a PR by review_url when review_id is absent', () => {
    adapter.saveWorkflow(makeWorkflow('wf-url'));
    adapter.saveTask('wf-url', makeMergeTask('wf-url', {
      reviewUrl: 'https://github.com/owner/repo/pull/4242',
    }));

    const result = adapter.findReviewGateByPr('4242');
    expect(result?.workflowId).toBe('wf-url');
    expect(result?.reviewUrl).toBe('https://github.com/owner/repo/pull/4242');
  });

  it('does not match a numeric prefix via the URL LIKE clause', () => {
    adapter.saveWorkflow(makeWorkflow('wf-prefix'));
    adapter.saveTask('wf-prefix', makeMergeTask('wf-prefix', {
      reviewUrl: 'https://github.com/owner/repo/pull/4242',
    }));

    expect(adapter.findReviewGateByPr('424')).toBeUndefined();
  });

  it('ignores non-merge tasks that happen to carry a review id', () => {
    adapter.saveWorkflow(makeWorkflow('wf-nonmerge'));
    const task = makeMergeTask('wf-nonmerge', { reviewId: '555' });
    task.id = 'task-regular';
    task.config = { workflowId: 'wf-nonmerge', isMergeNode: false };
    adapter.saveTask('wf-nonmerge', task);

    expect(adapter.findReviewGateByPr('555')).toBeUndefined();
  });

  it('returns undefined for an unknown PR', () => {
    adapter.saveWorkflow(makeWorkflow('wf-1'));
    adapter.saveTask('wf-1', makeMergeTask('wf-1', { reviewId: '999' }));

    expect(adapter.findReviewGateByPr('123456')).toBeUndefined();
    expect(adapter.findReviewGateByPr('nope')).toBeUndefined();
  });

  it('prefers the non-terminal workflow when a PR was re-published', () => {
    // Same PR number on two merge nodes: an old completed workflow and a live one.
    adapter.saveWorkflow(makeWorkflow('wf-old', { generation: 5 }));
    adapter.saveTask('wf-old', makeMergeTask('wf-old', { status: 'completed', reviewId: '700' }));

    adapter.saveWorkflow(makeWorkflow('wf-live', { generation: 1 }));
    adapter.saveTask('wf-live', makeMergeTask('wf-live', { status: 'running', reviewId: '700' }));

    const result = adapter.findReviewGateByPr('700');
    expect(result?.workflowId).toBe('wf-live');
    expect(result?.workflowStatus).toBe('running');
  });

  it('breaks ties between terminal workflows by highest generation', () => {
    adapter.saveWorkflow(makeWorkflow('wf-gen1', { generation: 1 }));
    adapter.saveTask('wf-gen1', makeMergeTask('wf-gen1', { status: 'completed', reviewId: '800' }));

    adapter.saveWorkflow(makeWorkflow('wf-gen3', { generation: 3 }));
    adapter.saveTask('wf-gen3', makeMergeTask('wf-gen3', { status: 'completed', reviewId: '800' }));

    const result = adapter.findReviewGateByPr('800');
    expect(result?.workflowId).toBe('wf-gen3');
    expect(result?.workflowGeneration).toBe(3);
  });
});
