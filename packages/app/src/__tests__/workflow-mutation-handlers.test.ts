import { describe, expect, it } from 'vitest';
import { WORKER_SUBMITTED_MUTATION_CHANNELS, WORKFLOW_RESUME_COMMAND_CHANNEL } from '@invoker/execution-engine';

import { assertAllWorkerMutationChannelsRegistered, buildWorkerMutationHandlers } from '../workflow-mutation-handlers.js';

function fakeDeps() {
  return {
    orchestrator: {} as never,
    commandService: {} as never,
    logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} } as never,
    runHeadlessCommand: async () => ({ ok: true }),
    getTaskExecutor: () => ({}) as never,
    getMutationTiming: () => undefined,
    contextLabel: 'test',
  };
}

describe('buildWorkerMutationHandlers', () => {
  it('returns a handler for every worker-submitted channel except invoker:start-ready', () => {
    const handlers = buildWorkerMutationHandlers(fakeDeps());
    for (const channel of WORKER_SUBMITTED_MUTATION_CHANNELS) {
      if (channel === WORKFLOW_RESUME_COMMAND_CHANNEL) continue;
      expect(handlers.has(channel)).toBe(true);
    }
    expect(handlers.has(WORKFLOW_RESUME_COMMAND_CHANNEL)).toBe(false);
  });
});

describe('assertAllWorkerMutationChannelsRegistered', () => {
  it('passes silently when the dispatcher has every canonical channel', () => {
    const dispatcher = new Map(WORKER_SUBMITTED_MUTATION_CHANNELS.map((channel) => [channel, async () => {}]));
    expect(() => assertAllWorkerMutationChannelsRegistered(dispatcher, 'test')).not.toThrow();
  });

  it('throws naming every missing channel when the dispatcher has gaps', () => {
    const [first, second, ...rest] = WORKER_SUBMITTED_MUTATION_CHANNELS;
    const dispatcher = new Map(rest.map((channel) => [channel, async () => {}]));
    expect(() => assertAllWorkerMutationChannelsRegistered(dispatcher, 'test')).toThrow(
      new RegExp(`\\[test\\].*${first}.*${second}`, 's'),
    );
  });

  it('throws when the dispatcher is completely empty', () => {
    expect(() => assertAllWorkerMutationChannelsRegistered(new Map(), 'standalone')).toThrow(/\[standalone\]/);
  });
});
