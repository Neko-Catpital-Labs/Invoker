import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@invoker/contracts';
import {
  MutationPipe,
  createMutationCommand,
  flattenActiveMutationSnapshot,
  normalizeActiveMutationSnapshot,
} from '../mutation-pipe.js';

function createLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => createLogger()),
  };
}

describe('MutationPipe', () => {
  it('executes queued commands in FIFO order', async () => {
    const logger = createLogger();
    const started: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const pipe = new MutationPipe<string>({
      logger,
      dispatch: async (command) => {
        started.push(command.kind);
        if (command.kind === 'first') {
          await firstGate;
        }
        return command.kind;
      },
    });

    const first = pipe.submit(createMutationCommand('gui', 'first', {}, { type: 'workflow', workflowId: 'wf-1' }));
    const second = pipe.submit(createMutationCommand('headless', 'second', {}, { type: 'workflow', workflowId: 'wf-1' }));

    await Promise.resolve();
    expect(started).toEqual(['first']);

    releaseFirst();

    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(started).toEqual(['first', 'second']);
  });

  it('rejects submissions when the queue reaches the configured bound', async () => {
    const logger = createLogger();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const pipe = new MutationPipe<void>({
      logger,
      maxQueuedCommands: 1,
      dispatch: async () => {
        await firstGate;
      },
    });

    const first = pipe.submit(createMutationCommand('gui', 'first', {}));
    const second = pipe.submit(createMutationCommand('gui', 'second', {}));

    await expect(
      pipe.submit(createMutationCommand('gui', 'third', {}, { type: 'global' })),
    ).rejects.toThrow('Mutation queue is full (1)');

    releaseFirst();
    await first;
    await second;
  });

  it('logs lifecycle transitions and keeps recent history', async () => {
    const logger = createLogger();
    const pipe = new MutationPipe<string>({
      logger,
      maxRecentCommands: 1,
      dispatch: async (command) => {
        if (command.kind === 'fail') {
          throw new Error('boom');
        }
        return 'ok';
      },
    });

    await expect(pipe.submit(createMutationCommand('gui', 'ok', {}, { type: 'global' }))).resolves.toBe('ok');
    await expect(pipe.submit(createMutationCommand('headless', 'fail', {}, { type: 'global' }))).rejects.toThrow('boom');

    const snapshot = pipe.snapshot();
    expect(snapshot.globalRunning).toBeNull();
    expect(snapshot.globalQueued).toEqual([]);
    expect(snapshot.workflowRunning).toEqual({});
    expect(snapshot.queuedByWorkflow).toEqual({});
    expect(snapshot.recent).toHaveLength(1);
    expect(snapshot.recent[0]?.kind).toBe('fail');
    expect(snapshot.recent[0]?.status).toBe('failed');

    expect(logger.info).toHaveBeenCalledWith(
      'mutation.owner_acquired',
      expect.objectContaining({ module: 'mutation-pipe' }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      'mutation.enqueued',
      expect.objectContaining({ kind: 'ok', scopeType: 'global' }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      'mutation.started',
      expect.objectContaining({ kind: 'ok', scopeType: 'global' }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      'mutation.completed',
      expect.objectContaining({ kind: 'ok', scopeType: 'global' }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      'mutation.failed',
      expect.objectContaining({ kind: 'fail', error: 'boom', scopeType: 'global' }),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      'mutation.dropped',
      expect.objectContaining({ kind: 'ok', status: 'completed' }),
    );
  });

  it('runs different workflow lanes concurrently', async () => {
    const logger = createLogger();
    const started: string[] = [];
    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    const gateB = new Promise<void>((resolve) => { releaseB = resolve; });
    const pipe = new MutationPipe<string>({
      logger,
      dispatch: async (command) => {
        started.push(`${command.kind}:${command.scope.type === 'workflow' ? command.scope.workflowId : 'global'}`);
        if (command.kind === 'first') await gateA;
        if (command.kind === 'second') await gateB;
        return command.kind;
      },
    });

    const first = pipe.submit(createMutationCommand('gui', 'first', {}, { type: 'workflow', workflowId: 'wf-a' }));
    const second = pipe.submit(createMutationCommand('headless', 'second', {}, { type: 'workflow', workflowId: 'wf-b' }));

    await Promise.resolve();
    expect(started).toEqual(['first:wf-a', 'second:wf-b']);

    releaseA();
    releaseB();

    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
  });

  it('blocks workflow lanes while a global mutation is queued', async () => {
    const logger = createLogger();
    const started: string[] = [];
    let releaseFirst!: () => void;
    let releaseGlobal!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const globalGate = new Promise<void>((resolve) => { releaseGlobal = resolve; });
    const pipe = new MutationPipe<string>({
      logger,
      dispatch: async (command) => {
        started.push(command.kind);
        if (command.kind === 'first') await firstGate;
        if (command.kind === 'global') await globalGate;
        return command.kind;
      },
    });

    const first = pipe.submit(createMutationCommand('gui', 'first', {}, { type: 'workflow', workflowId: 'wf-a' }));
    const global = pipe.submit(createMutationCommand('gui', 'global', {}, { type: 'global' }));
    const third = pipe.submit(createMutationCommand('gui', 'third', {}, { type: 'workflow', workflowId: 'wf-b' }));

    await Promise.resolve();
    expect(started).toEqual(['first']);

    releaseFirst();
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(['first', 'global']);

    releaseGlobal();
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(['first', 'global', 'third']);

    await expect(first).resolves.toBe('first');
    await expect(global).resolves.toBe('global');
    await expect(third).resolves.toBe('third');
  });

  it('normalizes only active commands from running and queued lanes', async () => {
    const logger = createLogger();
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const pipe = new MutationPipe<string>({
      logger,
      dispatch: async (command) => {
        if (command.kind === 'workflow-running' || command.kind === 'workflow-running-2') await secondGate;
        return command.kind;
      },
    });

    const workflowRunning = pipe.submit(createMutationCommand('headless', 'workflow-running', {}, { type: 'workflow', workflowId: 'wf-1' }));
    const secondWorkflowRunning = pipe.submit(createMutationCommand('gui', 'workflow-running-2', {}, { type: 'workflow', workflowId: 'wf-2' }));
    const globalQueued = pipe.submit(createMutationCommand('gui', 'global-queued', {}, { type: 'global' }));
    const workflowQueued = pipe.submit(createMutationCommand('headless', 'workflow-queued', {}, { type: 'workflow', workflowId: 'wf-1' }));

    await Promise.resolve();

    const snapshot = normalizeActiveMutationSnapshot(pipe.snapshot());
    expect(snapshot.globalRunning).toBeNull();
    expect(snapshot.workflowRunning['wf-1']?.kind).toBe('workflow-running');
    expect(snapshot.workflowRunning['wf-2']?.kind).toBe('workflow-running-2');
    expect(snapshot.globalQueued.map((entry) => entry.kind)).toEqual(['global-queued']);
    expect(snapshot.queuedByWorkflow['wf-1']?.map((entry) => entry.kind)).toEqual(['workflow-queued']);

    const flattened = flattenActiveMutationSnapshot(snapshot);
    expect(flattened.map((entry) => entry.group)).toEqual([
      'workflowRunning',
      'workflowRunning',
      'globalQueued',
      'workflowQueued',
    ]);
    expect(flattened.every((entry) => entry.createdAt.endsWith('Z'))).toBe(true);

    releaseSecond();
    await workflowRunning;
    await secondWorkflowRunning;
    await globalQueued;
    await workflowQueued;

    const drained = normalizeActiveMutationSnapshot(pipe.snapshot());
    expect(drained).toEqual({
      globalRunning: null,
      workflowRunning: {},
      globalQueued: [],
      queuedByWorkflow: {},
    });
  });
});
