import { describe, expect, it } from 'vitest';
import type { WorkflowMutationIntent } from '@invoker/data-store';
import type { ReviewGateCiFailureTrigger } from '@invoker/execution-engine';
import {
  buildHeadlessFixArgs,
  decodeReviewGateCiContext,
  encodeReviewGateCiContext,
  isFixIntentForTask,
  listOpenFixIntentsForTask,
  parseFixWithAgentMutationOptions,
  parseHeadlessFixArgs,
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

function makeTrigger(overrides: Partial<ReviewGateCiFailureTrigger> = {}): ReviewGateCiFailureTrigger {
  return {
    taskId: 'wf-1/task-1',
    workflowId: 'wf-1',
    reviewId: '12',
    reviewUrl: 'https://github.com/acme/repo/pull/12',
    headSha: 'abc123',
    headRef: 'feature/x',
    branch: 'experiment/x',
    selectedAttemptId: 'attempt-1',
    generation: 2,
    failedChecks: [{ name: 'ci', conclusion: 'failure' }],
    statusText: '1 failing check',
    ...overrides,
  };
}

describe('auto-fix-intents', () => {
  it('matches invoker:fix-with-agent intents for the exact task', () => {
    expect(isFixIntentForTask(makeIntent({ args: ['wf-1/task-1'] }), 'wf-1/task-1')).toBe(true);
    expect(isFixIntentForTask(makeIntent({ args: ['wf-1/task-2'] }), 'wf-1/task-1')).toBe(false);
  });

  it('matches invoker:fix-with-agent intents that carry structured fix options', () => {
    const intent = makeIntent({ args: ['wf-1/task-1', 'claude', { autoFix: true }] });
    expect(isFixIntentForTask(intent, 'wf-1/task-1')).toBe(true);
    expect(isFixIntentForTask(intent, 'wf-1/task-2')).toBe(false);
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

  it('matches headless fix intents that carry auto-fix flags', () => {
    const autoFix = makeIntent({
      channel: 'headless.exec',
      args: [{ args: ['fix', 'wf-1/task-1', '--auto-fix'] }],
    });
    const withContext = makeIntent({
      channel: 'headless.exec',
      args: [{
        args: ['fix', 'wf-1/task-1', 'codex', '--auto-fix', '--review-gate-ci', encodeReviewGateCiContext(makeTrigger())],
      }],
    });
    const malformedContext = makeIntent({
      channel: 'headless.exec',
      args: [{ args: ['fix', 'wf-1/task-1', '--review-gate-ci', 'not-valid'] }],
    });

    expect(isFixIntentForTask(autoFix, 'wf-1/task-1')).toBe(true);
    expect(isFixIntentForTask(withContext, 'wf-1/task-1')).toBe(true);
    expect(isFixIntentForTask(withContext, 'wf-1/task-2')).toBe(false);
    expect(isFixIntentForTask(malformedContext, 'wf-1/task-1')).toBe(true);
  });

  it('filters open fix intents for a task', () => {
    const intents: WorkflowMutationIntent[] = [
      makeIntent({ id: 1, args: ['wf-1/task-1'] }),
      makeIntent({ id: 2, channel: 'headless.exec', args: [{ args: ['fix', 'wf-1/task-1'] }] }),
      makeIntent({ id: 3, args: ['wf-1/task-2'] }),
      makeIntent({ id: 4, args: ['wf-1/task-1', undefined, { autoFix: true }] }),
      makeIntent({ id: 5, channel: 'headless.exec', args: [{ args: ['fix', 'wf-1/task-1', 'claude', '--auto-fix'] }] }),
    ];

    expect(listOpenFixIntentsForTask(intents, 'wf-1/task-1').map((intent) => intent.id)).toEqual([1, 2, 4, 5]);
  });
});

describe('parseHeadlessFixArgs', () => {
  it('parses a manual fix without flags', () => {
    expect(parseHeadlessFixArgs(['wf-1/task-1'])).toEqual({
      taskId: 'wf-1/task-1',
      agentName: undefined,
      autoFix: false,
    });
    expect(parseHeadlessFixArgs(['wf-1/task-1', 'codex'])).toEqual({
      taskId: 'wf-1/task-1',
      agentName: 'codex',
      autoFix: false,
    });
  });

  it('parses --auto-fix with and without an agent', () => {
    expect(parseHeadlessFixArgs(['wf-1/task-1', '--auto-fix'])).toEqual({
      taskId: 'wf-1/task-1',
      agentName: undefined,
      autoFix: true,
    });
    expect(parseHeadlessFixArgs(['wf-1/task-1', 'claude', '--auto-fix'])).toEqual({
      taskId: 'wf-1/task-1',
      agentName: 'claude',
      autoFix: true,
    });
  });

  it('parses an encoded review-gate CI context', () => {
    const trigger = makeTrigger();
    const parsed = parseHeadlessFixArgs([
      'wf-1/task-1',
      '--auto-fix',
      '--review-gate-ci',
      encodeReviewGateCiContext(trigger),
    ]);
    expect(parsed.autoFix).toBe(true);
    expect(parsed.reviewGateCi).toEqual(trigger);
  });

  it('rejects unknown flags, missing context values, and extra positionals', () => {
    expect(() => parseHeadlessFixArgs(['wf-1/task-1', '--force'])).toThrow(/Unknown fix flag/);
    expect(() => parseHeadlessFixArgs(['wf-1/task-1', '--review-gate-ci'])).toThrow(/Missing value/);
    expect(() => parseHeadlessFixArgs(['wf-1/task-1', 'claude', 'extra'])).toThrow(/Too many arguments/);
  });
});

describe('buildHeadlessFixArgs', () => {
  it('keeps manual fix shapes unchanged', () => {
    expect(buildHeadlessFixArgs('wf-1/task-1')).toEqual(['fix', 'wf-1/task-1']);
    expect(buildHeadlessFixArgs('wf-1/task-1', 'codex')).toEqual(['fix', 'wf-1/task-1', 'codex']);
    expect(buildHeadlessFixArgs('wf-1/task-1', undefined, {})).toEqual(['fix', 'wf-1/task-1']);
  });

  it('round-trips auto-fix options through headless args', () => {
    const trigger = makeTrigger();
    const args = buildHeadlessFixArgs('wf-1/task-1', 'claude', { autoFix: true, reviewGateCi: trigger });
    expect(args.slice(0, 4)).toEqual(['fix', 'wf-1/task-1', 'claude', '--auto-fix']);
    expect(args[4]).toBe('--review-gate-ci');

    const parsed = parseHeadlessFixArgs(args.slice(1));
    expect(parsed).toEqual({
      taskId: 'wf-1/task-1',
      agentName: 'claude',
      autoFix: true,
      reviewGateCi: trigger,
    });
  });
});

describe('parseFixWithAgentMutationOptions', () => {
  it('returns empty options for missing or malformed values', () => {
    expect(parseFixWithAgentMutationOptions(undefined)).toEqual({});
    expect(parseFixWithAgentMutationOptions(null)).toEqual({});
    expect(parseFixWithAgentMutationOptions('claude')).toEqual({});
    expect(parseFixWithAgentMutationOptions(['claude'])).toEqual({});
    expect(parseFixWithAgentMutationOptions({ autoFix: 'yes' })).toEqual({});
  });

  it('accepts structured auto-fix options', () => {
    const trigger = makeTrigger();
    expect(parseFixWithAgentMutationOptions({ autoFix: true })).toEqual({ autoFix: true });
    expect(parseFixWithAgentMutationOptions({ autoFix: true, reviewGateCi: trigger })).toEqual({
      autoFix: true,
      reviewGateCi: trigger,
    });
  });

  it('rejects invalid review-gate CI context shapes', () => {
    expect(() => parseFixWithAgentMutationOptions({ reviewGateCi: { taskId: 'wf-1/task-1' } }))
      .toThrow(/Invalid review-gate CI context/);
  });
});

describe('review-gate CI context encoding', () => {
  it('round-trips a trigger through encode/decode', () => {
    const trigger = makeTrigger();
    expect(decodeReviewGateCiContext(encodeReviewGateCiContext(trigger))).toEqual(trigger);
  });

  it('rejects undecodable or invalid payloads', () => {
    expect(() => decodeReviewGateCiContext('!!!not-base64-json!!!')).toThrow(/Invalid review-gate CI context/);
    const missingFields = Buffer.from(JSON.stringify({ taskId: 'wf-1/task-1' }), 'utf8').toString('base64url');
    expect(() => decodeReviewGateCiContext(missingFields)).toThrow(/Invalid review-gate CI context/);
  });
});
