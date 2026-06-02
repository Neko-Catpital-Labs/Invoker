import { describe, expect, it } from 'vitest';
import type { WorkflowMutationIntent } from '@invoker/data-store';
import {
  appendAutoFixFlag,
  hasOpenFixIntentForTask,
  isAutoFixHeadlessFixArgs,
  isFixIntentForTask,
  listOpenFixIntentsForTask,
  makeAutoFixContext,
  normalizeFixWithAgentOptions,
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

describe('auto-fix-intents', () => {
  it('matches invoker:fix-with-agent intents for the exact task', () => {
    expect(isFixIntentForTask(makeIntent({ args: ['wf-1/task-1'] }), 'wf-1/task-1')).toBe(true);
    expect(isFixIntentForTask(makeIntent({ args: ['task-1'] }), 'wf-1/task-1')).toBe(true);
    expect(isFixIntentForTask(makeIntent({ args: ['wf-1/task-2'] }), 'wf-1/task-1')).toBe(false);
  });

  it('matches headless fix intents for the exact task', () => {
    const headless = makeIntent({
      channel: 'headless.exec',
      args: [{ args: ['fix', 'wf-1/task-1', 'claude', '--auto-fix'] }],
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

  it('parses explicit headless auto-fix context without treating the flag as an agent', () => {
    expect(parseHeadlessFixArgs(['fix', 'wf-1/task-1', '--auto-fix'])).toEqual({
      taskId: 'wf-1/task-1',
      agentName: undefined,
      autoFixContext: { source: 'auto-fix' },
    });
    expect(parseHeadlessFixArgs(['fix', 'wf-1/task-1', 'codex', '--auto-fix'])).toEqual({
      taskId: 'wf-1/task-1',
      agentName: 'codex',
      autoFixContext: { source: 'auto-fix' },
    });
  });

  it('normalizes typed fix-with-agent auto-fix options', () => {
    expect(normalizeFixWithAgentOptions({ autoFixContext: makeAutoFixContext(true) })).toEqual({
      autoFixContext: { source: 'auto-fix', attemptAccepted: true },
    });
    expect(normalizeFixWithAgentOptions({ autoFix: true })).toEqual({
      autoFixContext: { source: 'auto-fix' },
    });
  });

  it('appends and detects the headless auto-fix flag', () => {
    expect(appendAutoFixFlag(['fix', 'wf-1/task-1'], makeAutoFixContext())).toEqual([
      'fix',
      'wf-1/task-1',
      '--auto-fix',
    ]);
    expect(isAutoFixHeadlessFixArgs(['fix', 'wf-1/task-1', '--auto-fix'])).toBe(true);
    expect(isAutoFixHeadlessFixArgs(['fix', 'wf-1/task-1'])).toBe(false);
  });

  it('filters open fix intents for a task', () => {
    const intents: WorkflowMutationIntent[] = [
      makeIntent({ id: 1, args: ['wf-1/task-1'] }),
      makeIntent({ id: 2, channel: 'headless.exec', args: [{ args: ['fix', 'wf-1/task-1'] }] }),
      makeIntent({ id: 3, args: ['wf-1/task-2'] }),
    ];

    expect(listOpenFixIntentsForTask(intents, 'wf-1/task-1').map((intent) => intent.id)).toEqual([1, 2]);
    expect(hasOpenFixIntentForTask(intents, 'wf-1/task-1')).toBe(true);
    expect(hasOpenFixIntentForTask(intents, 'wf-1/task-1', { excludeIntentId: 1 })).toBe(true);
    expect(hasOpenFixIntentForTask(intents, 'wf-1/task-1', { excludeIntentId: 2 })).toBe(true);
    expect(listOpenFixIntentsForTask(intents, 'wf-1/task-1', { excludeIntentId: 1 }).map((intent) => intent.id)).toEqual([2]);
  });
});
