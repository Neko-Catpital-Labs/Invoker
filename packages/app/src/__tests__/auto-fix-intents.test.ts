import { describe, expect, it } from 'vitest';
import type { WorkflowMutationIntent } from '@invoker/data-store';
import type { ReviewGateCiFailureTrigger } from '@invoker/execution-engine';
import {
  buildFixWithAgentMutationArgs,
  buildHeadlessFixArgs,
  decodeReviewGateCiContext,
  encodeReviewGateCiContext,
  isFixIntentForTask,
  listOpenFixIntentsForTask,
  parseFixWithAgentMutationArgs,
  parseHeadlessFixArgs,
} from '../auto-fix-intents.js';

function makeReviewGateContext(
  overrides: Partial<ReviewGateCiFailureTrigger> = {},
): ReviewGateCiFailureTrigger {
  return {
    taskId: 'wf-1/task-1',
    workflowId: 'wf-1',
    reviewId: 'review-42',
    reviewUrl: 'https://example.test/pr/42',
    generation: 3,
    selectedAttemptId: 'att-1',
    branch: 'experiment/foo',
    statusText: 'failure',
    failedChecks: [{ name: 'unit', conclusion: 'failure' }] as ReviewGateCiFailureTrigger['failedChecks'],
    ...overrides,
  };
}

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

  it('detects duplicate auto-fix intents for both IPC and headless shapes', () => {
    // IPC shape carries structured options as a third positional; the
    // headless shape carries the `--auto-fix` flag in its argv. Both must be
    // recognized as open fix intents for the same task so duplicates are
    // suppressed regardless of which boundary submitted them.
    const ipcAutoFix = makeIntent({
      id: 10,
      channel: 'invoker:fix-with-agent',
      status: 'running',
      args: buildFixWithAgentMutationArgs('wf-1/task-1', 'claude', { autoFix: true }),
    });
    const headlessAutoFix = makeIntent({
      id: 11,
      channel: 'headless.exec',
      args: [{ args: buildHeadlessFixArgs('wf-1/task-1', 'claude', { autoFix: true }) }],
    });
    const otherTask = makeIntent({
      id: 12,
      channel: 'headless.exec',
      args: [{ args: buildHeadlessFixArgs('wf-1/task-2', 'claude', { autoFix: true }) }],
    });

    expect(isFixIntentForTask(ipcAutoFix, 'wf-1/task-1')).toBe(true);
    expect(isFixIntentForTask(headlessAutoFix, 'wf-1/task-1')).toBe(true);
    expect(
      listOpenFixIntentsForTask([ipcAutoFix, headlessAutoFix, otherTask], 'wf-1/task-1').map((i) => i.id),
    ).toEqual([10, 11]);
  });
});

describe('parseHeadlessFixArgs', () => {
  it('keeps manual fix defaults: no auto-fix accounting', () => {
    expect(parseHeadlessFixArgs(['wf-1/task-1'])).toEqual({
      taskId: 'wf-1/task-1',
      agentName: undefined,
      options: {},
    });
    expect(parseHeadlessFixArgs(['wf-1/task-1', 'codex'])).toEqual({
      taskId: 'wf-1/task-1',
      agentName: 'codex',
      options: {},
    });
  });

  it('marks an explicit --auto-fix request', () => {
    expect(parseHeadlessFixArgs(['wf-1/task-1', 'claude', '--auto-fix'])).toEqual({
      taskId: 'wf-1/task-1',
      agentName: 'claude',
      options: { autoFix: true },
    });
    // Flag may precede the optional agent and still leave the agent positional intact.
    expect(parseHeadlessFixArgs(['wf-1/task-1', '--auto-fix'])).toEqual({
      taskId: 'wf-1/task-1',
      agentName: undefined,
      options: { autoFix: true },
    });
  });

  it('decodes a review-gate CI context flag and implies auto-fix', () => {
    const context = makeReviewGateContext();
    const parsed = parseHeadlessFixArgs(buildHeadlessFixArgs('wf-1/task-1', 'claude', {
      reviewGateCiContext: context,
    }).slice(1));

    expect(parsed.taskId).toBe('wf-1/task-1');
    expect(parsed.agentName).toBe('claude');
    expect(parsed.options.autoFix).toBe(true);
    expect(parsed.options.reviewGateCiContext).toEqual(context);
  });

  it('ignores a malformed review-gate CI flag instead of throwing', () => {
    const parsed = parseHeadlessFixArgs(['wf-1/task-1', '--review-gate-ci=not-base64-json']);
    expect(parsed.taskId).toBe('wf-1/task-1');
    expect(parsed.options.reviewGateCiContext).toBeUndefined();
    expect(parsed.options.autoFix).toBeUndefined();
  });
});

describe('buildHeadlessFixArgs', () => {
  it('produces a plain manual fix argv with no flags', () => {
    expect(buildHeadlessFixArgs('wf-1/task-1')).toEqual(['fix', 'wf-1/task-1']);
    expect(buildHeadlessFixArgs('wf-1/task-1', 'codex')).toEqual(['fix', 'wf-1/task-1', 'codex']);
  });

  it('round-trips structured options through parseHeadlessFixArgs', () => {
    const context = makeReviewGateContext();
    const argv = buildHeadlessFixArgs('wf-1/task-1', 'claude', {
      autoFix: true,
      reviewGateCiContext: context,
    });
    expect(argv[0]).toBe('fix');
    const parsed = parseHeadlessFixArgs(argv.slice(1));
    expect(parsed).toEqual({
      taskId: 'wf-1/task-1',
      agentName: 'claude',
      options: { autoFix: true, reviewGateCiContext: context },
    });
  });
});

describe('fix-with-agent mutation args', () => {
  it('stays byte-compatible with the legacy [taskId, agent] shape for manual fixes', () => {
    expect(buildFixWithAgentMutationArgs('wf-1/task-1', 'claude')).toEqual(['wf-1/task-1', 'claude']);
    expect(buildFixWithAgentMutationArgs('wf-1/task-1')).toEqual(['wf-1/task-1', undefined]);
  });

  it('adds a structured options positional only for auto-fix requests', () => {
    expect(buildFixWithAgentMutationArgs('wf-1/task-1', 'claude', { autoFix: true })).toEqual([
      'wf-1/task-1',
      'claude',
      { autoFix: true },
    ]);
  });

  it('round-trips auto-fix and review-gate context through parse', () => {
    const context = makeReviewGateContext();
    const args = buildFixWithAgentMutationArgs('wf-1/task-1', 'codex', { reviewGateCiContext: context });
    expect(parseFixWithAgentMutationArgs(args)).toEqual({
      taskId: 'wf-1/task-1',
      agentName: 'codex',
      options: { autoFix: true, reviewGateCiContext: context },
    });
  });

  it('tolerates the legacy two-arg shape on parse', () => {
    expect(parseFixWithAgentMutationArgs(['wf-1/task-1', 'claude'])).toEqual({
      taskId: 'wf-1/task-1',
      agentName: 'claude',
      options: {},
    });
  });
});

describe('review-gate CI context encode/decode', () => {
  it('round-trips a context through base64', () => {
    const context = makeReviewGateContext();
    const decoded = decodeReviewGateCiContext(encodeReviewGateCiContext(context));
    expect(decoded).toEqual(context);
  });

  it('returns undefined for malformed or non-context payloads', () => {
    expect(decodeReviewGateCiContext('@@@not-base64@@@')).toBeUndefined();
    expect(decodeReviewGateCiContext(Buffer.from('{"foo":1}').toString('base64'))).toBeUndefined();
  });
});

