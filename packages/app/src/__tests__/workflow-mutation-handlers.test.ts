import { describe, expect, it, vi } from 'vitest';
import {
  IDLE_TASK_CLEANUP_RETIRE_WORKFLOW_CHANNEL,
  planIdleTaskCleanup,
  WORKER_SUBMITTED_MUTATION_CHANNELS,
  WORKFLOW_RESUME_COMMAND_CHANNEL,
} from '@invoker/execution-engine';

import { assertAllWorkerMutationChannelsRegistered, buildWorkerMutationHandlers } from '../workflow-mutation-handlers.js';

function fakeDeps() {
  return {
    orchestrator: {} as never,
    commandService: {} as never,
    logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} } as never,
    runHeadlessCommand: async () => ({ ok: true }),
    getTaskExecutor: () => ({}) as never,
    getMutationTiming: () => undefined,
    idleTaskCleanup: {
      store: { listWorkflows: () => [], loadTasks: () => [] },
      now: () => Date.now(),
      idleThresholdMs: 48 * 60 * 60_000,
    },
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

  it('routes a checked cleanup workflow ID through CommandService workflow retirement', async () => {
    const deleteWorkflow = vi.fn(async () => ({ ok: true, data: undefined }));
    const handlers = buildWorkerMutationHandlers({
      ...fakeDeps(),
      commandService: { deleteWorkflow } as never,
      idleTaskCleanup: {
        store: {
          listWorkflows: () => [{
            id: 'wf-retire',
            name: 'retire',
            status: 'completed',
            updatedAt: '2026-08-30T00:00:00.000Z',
          }],
          loadTasks: () => [],
        },
        now: () => new Date('2026-08-31T00:00:00.000Z').getTime(),
        idleThresholdMs: 48 * 60 * 60_000,
      },
    });
    const retire = handlers.get(IDLE_TASK_CLEANUP_RETIRE_WORKFLOW_CHANNEL)!;

    await expect(retire('wf-retire')).resolves.toEqual({ ok: true });
    expect(deleteWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: 'idle-task-cleanup-retire-workflow',
        source: 'surface',
        scope: 'workflow',
        payload: { workflowId: 'wf-retire' },
      }),
    );

    await expect(retire('  ')).rejects.toThrow(/requires a workflow ID/);
    expect(deleteWorkflow).toHaveBeenCalledTimes(1);
  });

  it.each(['running', 'fixing_with_ai', 'future_task_state'])(
    'revalidates a queued age-based retirement against current %s task state',
    async (currentStatus) => {
      const workflow = {
        id: 'wf-stale-retirement',
        name: 'stale retirement',
        status: 'failed',
        updatedAt: '2026-08-28T00:00:00.000Z',
      };
      let tasks = [{ status: 'pending' }] as never[];
      const store = {
        listWorkflows: () => [workflow],
        loadTasks: () => tasks,
      };
      const now = new Date('2026-08-31T00:00:00.000Z').getTime();
      expect(planIdleTaskCleanup([workflow], store.loadTasks, { now })).toHaveLength(1);

      const deleteWorkflow = vi.fn(async () => ({ ok: true, data: undefined }));
      const handlers = buildWorkerMutationHandlers({
        ...fakeDeps(),
        commandService: { deleteWorkflow } as never,
        idleTaskCleanup: { store, now: () => now, idleThresholdMs: 48 * 60 * 60_000 },
      });
      tasks = [{ status: currentStatus }] as never[];

      await expect(
        handlers.get(IDLE_TASK_CLEANUP_RETIRE_WORKFLOW_CHANNEL)!('wf-stale-retirement'),
      ).resolves.toEqual({ ok: true });
      expect(deleteWorkflow).not.toHaveBeenCalled();
    },
  );
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
