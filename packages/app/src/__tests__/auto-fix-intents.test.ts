import { describe, expect, it } from 'vitest';
import type { WorkflowMutationIntent } from '@invoker/data-store';
import {
  AUTO_FIX_CONTEXT,
  AUTO_FIX_FLAG,
  fixRequestTaskId,
  isAutoFixContext,
  isFixIntentForTask,
  listOpenFixIntentsForTask,
  parseAutoFixArgs,
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

  it('still matches a fix intent that carries an auto-fix context or --auto-fix flag', () => {
    const withContext = makeIntent({ args: ['wf-1/task-1', 'claude', AUTO_FIX_CONTEXT] });
    const withFlag = makeIntent({
      channel: 'headless.exec',
      args: [{ args: ['fix', 'wf-1/task-1', 'claude', AUTO_FIX_FLAG] }],
    });
    expect(isFixIntentForTask(withContext, 'wf-1/task-1')).toBe(true);
    expect(isFixIntentForTask(withFlag, 'wf-1/task-1')).toBe(true);
  });
});

describe('isAutoFixContext', () => {
  it('recognizes the canonical context and rejects everything else', () => {
    expect(isAutoFixContext(AUTO_FIX_CONTEXT)).toBe(true);
    expect(isAutoFixContext({ autoFix: true })).toBe(true);
    expect(isAutoFixContext({ autoFix: false })).toBe(false);
    expect(isAutoFixContext('claude')).toBe(false);
    expect(isAutoFixContext(undefined)).toBe(false);
    expect(isAutoFixContext(null)).toBe(false);
  });
});

describe('parseAutoFixArgs', () => {
  it('extracts the --auto-fix flag and preserves positional args', () => {
    expect(parseAutoFixArgs([])).toEqual({ autoFix: false, rest: [] });
    expect(parseAutoFixArgs(['claude'])).toEqual({ autoFix: false, rest: ['claude'] });
    expect(parseAutoFixArgs(['claude', AUTO_FIX_FLAG])).toEqual({ autoFix: true, rest: ['claude'] });
    expect(parseAutoFixArgs([AUTO_FIX_FLAG, 'codex'])).toEqual({ autoFix: true, rest: ['codex'] });
    expect(parseAutoFixArgs([AUTO_FIX_FLAG])).toEqual({ autoFix: true, rest: [] });
  });
});

describe('fixRequestTaskId', () => {
  it('extracts the task id from the invoker:fix-with-agent shape', () => {
    expect(fixRequestTaskId('invoker:fix-with-agent', ['wf-1/task-1', 'claude'])).toBe('wf-1/task-1');
    expect(fixRequestTaskId('invoker:fix-with-agent', ['wf-1/task-1', 'claude', AUTO_FIX_CONTEXT])).toBe('wf-1/task-1');
    expect(fixRequestTaskId('invoker:fix-with-agent', [])).toBeNull();
  });

  it('extracts the task id from the headless.exec fix shape', () => {
    expect(fixRequestTaskId('headless.exec', [{ args: ['fix', 'wf-1/task-1'] }])).toBe('wf-1/task-1');
    expect(fixRequestTaskId('headless.exec', [{ args: ['fix', 'wf-1/task-1', 'claude', AUTO_FIX_FLAG] }])).toBe('wf-1/task-1');
  });

  it('returns null for non-fix requests', () => {
    expect(fixRequestTaskId('headless.exec', [{ args: ['retry-task', 'wf-1/task-1'] }])).toBeNull();
    expect(fixRequestTaskId('invoker:approve', ['wf-1/task-1'])).toBeNull();
  });
});

