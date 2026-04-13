import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@invoker/contracts';
import { MutationPipe, createMutationCommand } from '../mutation-pipe.js';

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

    const first = pipe.submit(createMutationCommand('gui', 'first', {}));
    const second = pipe.submit(createMutationCommand('headless', 'second', {}));

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
      pipe.submit(createMutationCommand('gui', 'third', {})),
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

    await expect(pipe.submit(createMutationCommand('gui', 'ok', {}))).resolves.toBe('ok');
    await expect(pipe.submit(createMutationCommand('headless', 'fail', {}))).rejects.toThrow('boom');

    const snapshot = pipe.snapshot();
    expect(snapshot.running).toBeNull();
    expect(snapshot.queued).toEqual([]);
    expect(snapshot.recent).toHaveLength(1);
    expect(snapshot.recent[0]?.kind).toBe('fail');
    expect(snapshot.recent[0]?.status).toBe('failed');

    expect(logger.info).toHaveBeenCalledWith(
      'mutation.owner_acquired',
      expect.objectContaining({ module: 'mutation-pipe' }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      'mutation.enqueued',
      expect.objectContaining({ kind: 'ok' }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      'mutation.started',
      expect.objectContaining({ kind: 'ok' }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      'mutation.completed',
      expect.objectContaining({ kind: 'ok' }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      'mutation.failed',
      expect.objectContaining({ kind: 'fail', error: 'boom' }),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      'mutation.dropped',
      expect.objectContaining({ kind: 'ok', status: 'completed' }),
    );
  });
});
