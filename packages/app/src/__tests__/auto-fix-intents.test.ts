import { describe, expect, it } from 'vitest';
import type { WorkflowMutationIntent } from '@invoker/data-store';
import {
  fixWithAgentMutationArgs,
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

describe('auto-fix-intents', () => {
  it('matches invoker:fix-with-agent intents for the exact task', () => {
    expect(isFixIntentForTask(makeIntent({ args: ['wf-1/task-1'] }), 'wf-1/task-1')).toBe(true);
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

  it('parses explicit auto-fix context for invoker fix-with-agent args', () => {
    expect(fixWithAgentMutationArgs('wf-1/task-1', 'codex')).toEqual(['wf-1/task-1', 'codex']);
    expect(fixWithAgentMutationArgs('wf-1/task-1', 'codex', { autoFix: true })).toEqual([
      'wf-1/task-1',
      'codex',
      { autoFix: true },
    ]);
    expect(parseFixWithAgentMutationOptions({ autoFix: true })).toEqual({ autoFix: true });
    expect(parseFixWithAgentMutationOptions(undefined)).toEqual({ autoFix: false });
  });

  it('parses headless fix auto-fix context without consuming the agent arg', () => {
    expect(parseHeadlessFixArgs(['fix', 'wf-1/task-1', 'codex', '--auto-fix'])).toEqual({
      taskId: 'wf-1/task-1',
      agentName: 'codex',
      autoFix: true,
    });
    expect(parseHeadlessFixArgs(['fix', 'wf-1/task-1', '--auto-fix'])).toEqual({
      taskId: 'wf-1/task-1',
      agentName: undefined,
      autoFix: true,
    });
    expect(parseHeadlessFixArgs(['fix', 'wf-1/task-1', 'claude'])).toEqual({
      taskId: 'wf-1/task-1',
      agentName: 'claude',
      autoFix: false,
    });
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
