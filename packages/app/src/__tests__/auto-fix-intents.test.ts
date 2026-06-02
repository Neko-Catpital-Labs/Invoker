import { describe, expect, it, vi } from 'vitest';
import type { WorkflowMutationIntent } from '@invoker/data-store';
import {
  AUTO_FIX_CONTEXT,
  MANUAL_FIX_CONTEXT,
  hasOpenFixIntentForTask,
  isFixIntentForTask,
  listOpenFixIntentsForTask,
  recordAutoFixAttempt,
  selectFixAgent,
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
});

describe('hasOpenFixIntentForTask', () => {
  it('detects an open fix intent across both intent shapes', () => {
    const ipc = [makeIntent({ id: 1, args: ['wf-1/task-1'] })];
    const headless = [
      makeIntent({ id: 7, channel: 'headless.exec', args: [{ args: ['fix', 'wf-1/task-1'] }] }),
    ];
    expect(hasOpenFixIntentForTask(ipc, 'wf-1/task-1')).toBe(true);
    expect(hasOpenFixIntentForTask(headless, 'wf-1/task-1')).toBe(true);
    expect(hasOpenFixIntentForTask(ipc, 'wf-1/task-2')).toBe(false);
    expect(hasOpenFixIntentForTask([], 'wf-1/task-1')).toBe(false);
  });

  it('excludes the caller\'s own intent so a fix does not match itself', () => {
    const intents = [makeIntent({ id: 42, args: ['wf-1/task-1'] })];
    expect(hasOpenFixIntentForTask(intents, 'wf-1/task-1', 42)).toBe(false);
    // A second, different open fix intent is still detected.
    const withDuplicate = [
      ...intents,
      makeIntent({ id: 43, channel: 'headless.exec', args: [{ args: ['fix', 'wf-1/task-1'] }] }),
    ];
    expect(hasOpenFixIntentForTask(withDuplicate, 'wf-1/task-1', 42)).toBe(true);
  });
});

describe('recordAutoFixAttempt', () => {
  it('increments autoFixAttempts exactly once and persists the new count', () => {
    const orchestrator = {
      getTask: () => ({ execution: { autoFixAttempts: 2 } }),
    };
    const updateTask = vi.fn();
    const result = recordAutoFixAttempt('wf-1/task-1', orchestrator, { updateTask });
    expect(result).toEqual({ attemptsBefore: 2, attemptsAfter: 3 });
    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(updateTask).toHaveBeenCalledWith('wf-1/task-1', { execution: { autoFixAttempts: 3 } });
  });

  it('treats a missing attempt count as zero', () => {
    const orchestrator = { getTask: () => ({ execution: {} }) };
    const updateTask = vi.fn();
    expect(recordAutoFixAttempt('wf-1/task-1', orchestrator, { updateTask })).toEqual({
      attemptsBefore: 0,
      attemptsAfter: 1,
    });
  });
});

describe('selectFixAgent', () => {
  it('prefers an explicitly requested agent regardless of context', () => {
    expect(selectFixAgent(MANUAL_FIX_CONTEXT, 'codex', 'claude')).toBe('codex');
    expect(selectFixAgent(AUTO_FIX_CONTEXT, 'codex', 'claude')).toBe('codex');
  });

  it('falls back to the configured auto-fix agent only for auto-fix submissions', () => {
    expect(selectFixAgent(AUTO_FIX_CONTEXT, undefined, ' codex ')).toBe('codex');
    expect(selectFixAgent(MANUAL_FIX_CONTEXT, undefined, 'codex')).toBeUndefined();
  });

  it('returns undefined when no agent is requested or configured', () => {
    expect(selectFixAgent(AUTO_FIX_CONTEXT, undefined, undefined)).toBeUndefined();
    expect(selectFixAgent(AUTO_FIX_CONTEXT, '   ', '   ')).toBeUndefined();
  });
});

