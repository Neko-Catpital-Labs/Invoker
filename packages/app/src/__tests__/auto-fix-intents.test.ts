import { describe, expect, it } from 'vitest';
import type { WorkflowMutationIntent } from '@invoker/data-store';
import {
  AUTO_FIX_FLAG,
  evaluateFixSubmission,
  intentCarriesAutoFixContext,
  isFixIntentForTask,
  listOpenFixIntentsForTask,
  parseFixCommandTokens,
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

  it('still matches headless fix intents that carry the auto-fix flag', () => {
    const autoIntent = makeIntent({
      channel: 'headless.exec',
      args: [{ args: ['fix', 'wf-1/task-1', 'codex', AUTO_FIX_FLAG] }],
    });
    expect(isFixIntentForTask(autoIntent, 'wf-1/task-1')).toBe(true);
  });
});

describe('parseFixCommandTokens', () => {
  it('parses taskId and agent without the auto-fix flag', () => {
    expect(parseFixCommandTokens(['wf-1/task-1', 'codex'])).toEqual({
      taskId: 'wf-1/task-1',
      agentName: 'codex',
      autoFix: false,
    });
  });

  it('detects the auto-fix flag in any position', () => {
    expect(parseFixCommandTokens(['wf-1/task-1', AUTO_FIX_FLAG])).toEqual({
      taskId: 'wf-1/task-1',
      agentName: undefined,
      autoFix: true,
    });
    expect(parseFixCommandTokens(['wf-1/task-1', 'claude', AUTO_FIX_FLAG])).toEqual({
      taskId: 'wf-1/task-1',
      agentName: 'claude',
      autoFix: true,
    });
    expect(parseFixCommandTokens([AUTO_FIX_FLAG, 'wf-1/task-1', 'claude'])).toEqual({
      taskId: 'wf-1/task-1',
      agentName: 'claude',
      autoFix: true,
    });
  });

  it('ignores undefined tokens', () => {
    expect(parseFixCommandTokens([undefined, 'wf-1/task-1', undefined])).toEqual({
      taskId: 'wf-1/task-1',
      agentName: undefined,
      autoFix: false,
    });
  });
});

describe('intentCarriesAutoFixContext', () => {
  it('is true only for headless fix intents carrying the flag', () => {
    expect(
      intentCarriesAutoFixContext(
        makeIntent({ channel: 'headless.exec', args: [{ args: ['fix', 'wf-1/task-1', AUTO_FIX_FLAG] }] }),
      ),
    ).toBe(true);
    expect(
      intentCarriesAutoFixContext(
        makeIntent({ channel: 'headless.exec', args: [{ args: ['fix', 'wf-1/task-1', 'claude'] }] }),
      ),
    ).toBe(false);
    // Manual right-click intents are never auto-fix.
    expect(intentCarriesAutoFixContext(makeIntent({ args: ['wf-1/task-1'] }))).toBe(false);
  });
});

describe('evaluateFixSubmission', () => {
  it('accepts an auto-fix submission with no competing open intents', () => {
    expect(
      evaluateFixSubmission({ taskId: 'wf-1/task-1', autoFix: true, openIntents: [], shouldAutoFix: true }),
    ).toEqual({ accepted: true });
  });

  it('skips when a duplicate open fix intent exists (either shape)', () => {
    const manualOpen = makeIntent({ id: 7, args: ['wf-1/task-1'] });
    const headlessOpen = makeIntent({
      id: 9,
      channel: 'headless.exec',
      args: [{ args: ['fix', 'wf-1/task-1'] }],
    });

    expect(
      evaluateFixSubmission({
        taskId: 'wf-1/task-1',
        autoFix: true,
        openIntents: [manualOpen],
        shouldAutoFix: true,
      }),
    ).toEqual({ accepted: false, reason: 'duplicate-open-intent', openIntentIds: [7] });

    expect(
      evaluateFixSubmission({
        taskId: 'wf-1/task-1',
        autoFix: true,
        openIntents: [headlessOpen],
        shouldAutoFix: true,
      }),
    ).toEqual({ accepted: false, reason: 'duplicate-open-intent', openIntentIds: [9] });
  });

  it('excludes the currently-executing intent from suppression', () => {
    const self = makeIntent({
      id: 42,
      channel: 'headless.exec',
      args: [{ args: ['fix', 'wf-1/task-1', AUTO_FIX_FLAG] }],
    });
    expect(
      evaluateFixSubmission({
        taskId: 'wf-1/task-1',
        autoFix: true,
        openIntents: [self],
        excludeIntentId: 42,
        shouldAutoFix: true,
      }),
    ).toEqual({ accepted: true });
  });

  it('skips an auto-fix submission when shouldAutoFix is false', () => {
    expect(
      evaluateFixSubmission({
        taskId: 'wf-1/task-1',
        autoFix: true,
        openIntents: [],
        shouldAutoFix: false,
      }),
    ).toEqual({ accepted: false, reason: 'should-not-auto-fix', openIntentIds: [] });
  });

  it('does not gate manual submissions on shouldAutoFix', () => {
    expect(
      evaluateFixSubmission({
        taskId: 'wf-1/task-1',
        autoFix: false,
        openIntents: [],
        shouldAutoFix: false,
      }),
    ).toEqual({ accepted: true });
  });
});

