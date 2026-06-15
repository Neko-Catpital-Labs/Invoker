import { describe, expect, it } from 'vitest';
import type { WorkflowMutationIntent } from '@invoker/data-store';
import {
  buildFixWithAgentMutationArgs,
  buildHeadlessFixArgs,
  decodeReviewGateCiContext,
  encodeReviewGateCiContext,
  hasOpenFixIntentForTask,
  isFixIntentForTask,
  isReviewGateCiContextStale,
  listOpenFixIntentsForTask,
  parseFixWithAgentMutationArgs,
  parseHeadlessFixArgs,
  type ReviewGateCiContext,
} from '../auto-fix-intents.js';

function makeIntent(overrides: Partial<WorkflowMutationIntent>): WorkflowMutationIntent {
  return {
    id: 1,
    workflowId: 'wf-1',
    channel: 'invoker:fix-with-agent',
    args: ['wf-1/task-1'],
    priority: 'normal',
    status: 'queued',
    ownerId: null,
    error: null,
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

describe('auto-fix-intents', () => {
  it('matches invoker:fix-with-agent intents for the exact task', () => {
    expect(isFixIntentForTask(makeIntent({ args: ['wf-1/task-1'] }), 'wf-1/task-1')).toBe(true);
    expect(isFixIntentForTask(makeIntent({ args: ['wf-1/task-2'] }), 'wf-1/task-1')).toBe(false);
  });

  it('matches headless fix intents for the exact task', () => {
    const headless = makeIntent({
      channel: 'headless.exec',
      args: [{ args: ['fix', 'wf-1/task-1', 'claude'] }],
    });
    const differentTask = makeIntent({
      channel: 'headless.exec',
      args: [{ args: ['fix', 'wf-1/task-2'] }],
    });
    const differentCommand = makeIntent({
      channel: 'headless.exec',
      args: [{ args: ['retry-task', 'wf-1/task-1'] }],
    });

    expect(isFixIntentForTask(headless, 'wf-1/task-1')).toBe(true);
    expect(isFixIntentForTask(differentTask, 'wf-1/task-1')).toBe(false);
    expect(isFixIntentForTask(differentCommand, 'wf-1/task-1')).toBe(false);
  });

  it('filters open fix intents for a task', () => {
    const intents: WorkflowMutationIntent[] = [
      makeIntent({ id: 1, args: ['wf-1/task-1'] }),
      makeIntent({ id: 2, channel: 'headless.exec', args: [{ args: ['fix', 'wf-1/task-1'] }] }),
      makeIntent({ id: 3, args: ['wf-1/task-2'] }),
    ];

    expect(listOpenFixIntentsForTask(intents, 'wf-1/task-1').map((intent) => intent.id)).toEqual([1, 2]);
  });

  it('detects duplicate open fix intents across IPC and headless shapes', () => {
    const ipcIntent = makeIntent({ args: ['wf-1/task-1'] });
    const headlessIntent = makeIntent({
      channel: 'headless.exec',
      args: [{ args: ['fix', 'wf-1/task-1', 'claude', '--auto-fix'] }],
    });
    const otherTask = makeIntent({ args: ['wf-1/task-2'] });

    expect(hasOpenFixIntentForTask([ipcIntent], 'wf-1/task-1')).toBe(true);
    expect(hasOpenFixIntentForTask([headlessIntent], 'wf-1/task-1')).toBe(true);
    expect(hasOpenFixIntentForTask([otherTask], 'wf-1/task-1')).toBe(false);
    expect(hasOpenFixIntentForTask([], 'wf-1/task-1')).toBe(false);
  });

  it('matches structured auto-fix IPC intents (taskId stays first) for dedup', () => {
    const structured = makeIntent({
      args: buildFixWithAgentMutationArgs('wf-1/task-1', 'claude', { autoFix: true }) as WorkflowMutationIntent['args'],
    });
    expect(isFixIntentForTask(structured, 'wf-1/task-1')).toBe(true);
    expect(isFixIntentForTask(structured, 'wf-1/task-2')).toBe(false);
  });
});

describe('parseHeadlessFixArgs', () => {
  it('parses a manual fix without auto-fix context', () => {
    expect(parseHeadlessFixArgs(['fix', 'wf-1/task-1', 'codex'])).toEqual({
      taskId: 'wf-1/task-1',
      agentName: 'codex',
      autoFix: false,
      reviewGateContext: undefined,
    });
  });

  it('parses the --auto-fix flag without disturbing positional args', () => {
    expect(parseHeadlessFixArgs(['fix', 'wf-1/task-1', 'claude', '--auto-fix'])).toEqual({
      taskId: 'wf-1/task-1',
      agentName: 'claude',
      autoFix: true,
      reviewGateContext: undefined,
    });
  });

  it('parses an encoded review-gate CI context and implies auto-fix', () => {
    const ctx: ReviewGateCiContext = {
      reviewId: 'review-9',
      generation: 2,
      selectedAttemptId: 'attempt-7',
      branch: 'experiment/foo',
    };
    const parsed = parseHeadlessFixArgs([
      'fix', 'wf-1/task-1', '--review-gate-ci', encodeReviewGateCiContext(ctx),
    ]);
    expect(parsed.taskId).toBe('wf-1/task-1');
    expect(parsed.autoFix).toBe(true);
    expect(parsed.reviewGateContext).toEqual(ctx);
  });

  it('ignores a malformed review-gate context payload', () => {
    const parsed = parseHeadlessFixArgs(['fix', 'wf-1/task-1', '--review-gate-ci', 'not-json']);
    expect(parsed.reviewGateContext).toBeUndefined();
    expect(parsed.autoFix).toBe(false);
  });
});

describe('buildHeadlessFixArgs', () => {
  it('builds a manual fix command unchanged', () => {
    expect(buildHeadlessFixArgs('wf-1/task-1', 'claude')).toEqual(['fix', 'wf-1/task-1', 'claude']);
    expect(buildHeadlessFixArgs('wf-1/task-1', undefined)).toEqual(['fix', 'wf-1/task-1']);
  });

  it('appends --auto-fix and review-gate context that round-trips through parsing', () => {
    const ctx: ReviewGateCiContext = { reviewId: 'r1', generation: 3, selectedAttemptId: 'a1' };
    const args = buildHeadlessFixArgs('wf-1/task-1', 'codex', { autoFix: true, reviewGateContext: ctx });
    expect(args.slice(0, 4)).toEqual(['fix', 'wf-1/task-1', 'codex', '--auto-fix']);
    const parsed = parseHeadlessFixArgs(args);
    expect(parsed).toEqual({
      taskId: 'wf-1/task-1',
      agentName: 'codex',
      autoFix: true,
      reviewGateContext: ctx,
    });
  });
});

describe('fix-with-agent mutation options', () => {
  it('omits the options arg for a manual fix', () => {
    expect(buildFixWithAgentMutationArgs('wf-1/task-1', 'claude')).toEqual(['wf-1/task-1', 'claude']);
  });

  it('round-trips structured auto-fix options through build/parse', () => {
    const ctx: ReviewGateCiContext = { reviewId: 'r1', generation: 1 };
    const args = buildFixWithAgentMutationArgs('wf-1/task-1', 'codex', { autoFix: true, reviewGateContext: ctx });
    expect(parseFixWithAgentMutationArgs(args)).toEqual({
      taskId: 'wf-1/task-1',
      agentName: 'codex',
      context: { autoFix: true, reviewGateContext: ctx },
    });
  });

  it('parses legacy two-argument calls as non-auto-fix', () => {
    expect(parseFixWithAgentMutationArgs(['wf-1/task-1', 'claude'])).toEqual({
      taskId: 'wf-1/task-1',
      agentName: 'claude',
      context: { autoFix: false, reviewGateContext: undefined },
    });
    expect(parseFixWithAgentMutationArgs(['wf-1/task-1'])).toEqual({
      taskId: 'wf-1/task-1',
      agentName: undefined,
      context: { autoFix: false, reviewGateContext: undefined },
    });
  });
});

describe('review-gate CI context staleness', () => {
  const ctx: ReviewGateCiContext = {
    reviewId: 'review-1',
    generation: 2,
    selectedAttemptId: 'attempt-1',
    branch: 'experiment/foo',
  };

  it('treats matching lineage as current', () => {
    expect(isReviewGateCiContextStale(ctx, {
      reviewId: 'review-1',
      generation: 2,
      selectedAttemptId: 'attempt-1',
      branch: 'experiment/foo',
    })).toBe(false);
  });

  it('flags a moved selected attempt, generation, review, or branch as stale', () => {
    expect(isReviewGateCiContextStale(ctx, { reviewId: 'review-1', generation: 2, selectedAttemptId: 'attempt-2', branch: 'experiment/foo' })).toBe(true);
    expect(isReviewGateCiContextStale(ctx, { reviewId: 'review-1', generation: 3, selectedAttemptId: 'attempt-1', branch: 'experiment/foo' })).toBe(true);
    expect(isReviewGateCiContextStale(ctx, { reviewId: 'review-2', generation: 2, selectedAttemptId: 'attempt-1', branch: 'experiment/foo' })).toBe(true);
    expect(isReviewGateCiContextStale(ctx, { reviewId: 'review-1', generation: 2, selectedAttemptId: 'attempt-1', branch: 'experiment/bar' })).toBe(true);
  });

  it('defaults a missing generation to 0 when comparing', () => {
    const zeroGen: ReviewGateCiContext = { reviewId: 'r', generation: 0 };
    expect(isReviewGateCiContextStale(zeroGen, { reviewId: 'r' })).toBe(false);
  });
});

describe('review-gate CI context encode/decode', () => {
  it('round-trips a full context', () => {
    const ctx: ReviewGateCiContext = {
      reviewId: 'r1',
      generation: 4,
      selectedAttemptId: 'a1',
      branch: 'b1',
      headSha: 'deadbeef',
      fixContext: 'fix the failing checks',
    };
    expect(decodeReviewGateCiContext(encodeReviewGateCiContext(ctx))).toEqual(ctx);
  });

  it('returns undefined for empty, non-string, or invalid payloads', () => {
    expect(decodeReviewGateCiContext(undefined)).toBeUndefined();
    expect(decodeReviewGateCiContext('')).toBeUndefined();
    expect(decodeReviewGateCiContext(42)).toBeUndefined();
    expect(decodeReviewGateCiContext('{not json')).toBeUndefined();
    expect(decodeReviewGateCiContext(JSON.stringify({ generation: 1 }))).toBeUndefined();
    expect(decodeReviewGateCiContext(JSON.stringify({ reviewId: 'r' }))).toBeUndefined();
  });
});

