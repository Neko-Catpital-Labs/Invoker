import { describe, expect, it } from 'vitest';
import type { WorkflowMutationIntent } from '@invoker/data-store';
import type { ReviewGateCiFailureTrigger } from '@invoker/execution-engine';
import {
  isFixIntentForTask,
  listOpenFixIntentsForTask,
  hasOpenFixIntentForTask,
  parseHeadlessFixArgs,
  encodeFixMutationOptions,
  decodeFixMutationOptions,
  encodeReviewGateCiContext,
  decodeReviewGateCiContext,
  buildHeadlessFixArgs,
} from '../auto-fix-intents.js';

function makeReviewGateCi(
  overrides: Partial<ReviewGateCiFailureTrigger> = {},
): ReviewGateCiFailureTrigger {
  return {
    taskId: 'wf-1/task-1',
    workflowId: 'wf-1',
    reviewId: 'review-9',
    reviewUrl: 'https://example.test/pr/9',
    generation: 2,
    selectedAttemptId: 'att-7',
    branch: 'inv/task-1',
    failedChecks: [{ name: 'ci', conclusion: 'failure' }] as ReviewGateCiFailureTrigger['failedChecks'],
    statusText: 'failing',
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

  it('detects a duplicate open fix intent for both IPC and headless shapes', () => {
    const ipcOnly: WorkflowMutationIntent[] = [makeIntent({ args: ['wf-1/task-1'] })];
    const headlessOnly: WorkflowMutationIntent[] = [
      makeIntent({ channel: 'headless.exec', args: [{ args: ['fix', 'wf-1/task-1', '--auto-fix'] }] }),
    ];
    const none: WorkflowMutationIntent[] = [makeIntent({ args: ['wf-1/task-2'] })];

    expect(hasOpenFixIntentForTask(ipcOnly, 'wf-1/task-1')).toBe(true);
    expect(hasOpenFixIntentForTask(headlessOnly, 'wf-1/task-1')).toBe(true);
    expect(hasOpenFixIntentForTask(none, 'wf-1/task-1')).toBe(false);
  });

  it('still matches headless fix intents that carry an --auto-fix flag', () => {
    const headlessAuto = makeIntent({
      channel: 'headless.exec',
      args: [{ args: ['fix', 'wf-1/task-1', 'claude', '--auto-fix'] }],
    });
    expect(isFixIntentForTask(headlessAuto, 'wf-1/task-1')).toBe(true);
  });
});

describe('parseHeadlessFixArgs', () => {
  it('parses a manual fix with no auto-fix marker', () => {
    expect(parseHeadlessFixArgs(['fix', 'wf-1/task-1', 'claude'])).toEqual({
      isFix: true,
      taskId: 'wf-1/task-1',
      agent: 'claude',
      autoFix: false,
    });
  });

  it('parses an auto-fix request with the flag in any position', () => {
    const withTrailingFlag = parseHeadlessFixArgs(['fix', 'wf-1/task-1', 'codex', '--auto-fix']);
    expect(withTrailingFlag).toMatchObject({ taskId: 'wf-1/task-1', agent: 'codex', autoFix: true });

    const flagBeforeAgent = parseHeadlessFixArgs(['fix', 'wf-1/task-1', '--auto-fix']);
    expect(flagBeforeAgent).toMatchObject({ taskId: 'wf-1/task-1', agent: undefined, autoFix: true });
  });

  it('returns isFix=false for non-fix commands', () => {
    expect(parseHeadlessFixArgs(['retry-task', 'wf-1/task-1']).isFix).toBe(false);
  });

  it('round-trips a review-gate CI context through the headless argv', () => {
    const context = makeReviewGateCi();
    const args = buildHeadlessFixArgs('wf-1/task-1', 'claude', { autoFix: true, reviewGateCi: context });
    const parsed = parseHeadlessFixArgs(args);

    expect(parsed.autoFix).toBe(true);
    expect(parsed.taskId).toBe('wf-1/task-1');
    expect(parsed.agent).toBe('claude');
    expect(parsed.reviewGateCi).toEqual(context);
  });
});

describe('fix mutation options', () => {
  it('encodes nothing for a plain manual fix', () => {
    expect(encodeFixMutationOptions(undefined)).toBeUndefined();
    expect(encodeFixMutationOptions({ autoFix: false })).toBeUndefined();
  });

  it('round-trips structured auto-fix options including review-gate context', () => {
    const context = makeReviewGateCi();
    const encoded = encodeFixMutationOptions({ autoFix: true, reviewGateCi: context });
    expect(encoded).toBeDefined();

    const decoded = decodeFixMutationOptions(encoded);
    expect(decoded.autoFix).toBe(true);
    expect(decoded.reviewGateCi).toEqual(context);
  });

  it('decodes a missing/legacy options arg as a non-auto-fix no-op', () => {
    expect(decodeFixMutationOptions(undefined)).toEqual({ autoFix: false });
    expect(decodeFixMutationOptions('garbage')).toEqual({ autoFix: false });
  });
});

describe('review-gate CI context encode/decode', () => {
  it('round-trips a context through the JSON envelope', () => {
    const context = makeReviewGateCi();
    const token = encodeReviewGateCiContext(context);
    expect(decodeReviewGateCiContext(token)).toEqual(context);
  });

  it('rejects malformed or untagged tokens', () => {
    expect(decodeReviewGateCiContext('not json')).toBeUndefined();
    expect(decodeReviewGateCiContext(JSON.stringify({ kind: 'other', context: {} }))).toBeUndefined();
    expect(decodeReviewGateCiContext(undefined)).toBeUndefined();
  });
});

