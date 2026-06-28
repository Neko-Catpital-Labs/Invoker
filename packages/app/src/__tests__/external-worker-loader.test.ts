import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createWorkerRegistry, type WorkerRuntimeDependencies } from '@invoker/execution-engine';

import { isExternalWorkerRuntime, registerExternalWorkers } from '../external-worker-loader.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const externalWorkers = [{
  kind: 'preview',
  launch: {
    executable: '/usr/local/bin/invoker-preview-worker',
    args: ['--stdio'],
  },
}];

const spawnMock = vi.mocked(spawn);

type FakeChildProcess = EventEmitter & Pick<ChildProcess, 'exitCode' | 'killed' | 'kill'>;

function createFakeChildProcess(): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess;
  child.exitCode = null;
  child.killed = false;
  child.kill = vi.fn((signal?: NodeJS.Signals | number) => {
    child.killed = true;
    child.exitCode = 0;
    queueMicrotask(() => child.emit('exit', 0, signal));
    return true;
  });
  return child;
}

function makeLogger() {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger;
}

function makeDeps(logger = makeLogger()): WorkerRuntimeDependencies {
  return { store: {} as never, submitter: {} as never, logger };
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe('registerExternalWorkers', () => {
  it('registers configured external workers by kind', () => {
    const registry = registerExternalWorkers(createWorkerRegistry(), externalWorkers);

    const definition = registry.get('preview');
    expect(definition).toBeDefined();
    expect(definition?.kind).toBe('preview');
    expect(definition?.note).toContain('/usr/local/bin/invoker-preview-worker');
    expect(registry.list().map((worker) => worker.kind)).toEqual(['preview']);
  });

  it('defaults to no registered external workers when config is absent', () => {
    const registry = registerExternalWorkers(createWorkerRegistry(), undefined);

    expect(registry.list()).toEqual([]);
    expect(registry.get('preview')).toBeUndefined();
  });

  it('rejects duplicate external worker kinds', () => {
    const registry = createWorkerRegistry();

    expect(() => registerExternalWorkers(registry, [externalWorkers[0], externalWorkers[0]])).toThrow(
      'External worker kind is already registered: preview',
    );
  });

  it('starts, waits for, and stops the spawned process without leaking args or env', async () => {
    const logger = makeLogger();
    const child = createFakeChildProcess();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const previousSecret = process.env.EXTERNAL_WORKER_TEST_SECRET;
    process.env.EXTERNAL_WORKER_TEST_SECRET = 'secret-value';

    try {
      const registry = registerExternalWorkers(createWorkerRegistry(), [{
        kind: 'preview',
        launch: {
          executable: '/usr/local/bin/invoker-preview-worker',
          args: ['--token=secret-value'],
          cwd: '/srv/invoker',
        },
      }]);
      const runtime = registry.get('preview')!.factory(makeDeps(logger));
      expect(isExternalWorkerRuntime(runtime)).toBe(true);
      if (!isExternalWorkerRuntime(runtime)) throw new Error('Expected external worker runtime');

      runtime.start();

      expect(runtime.isRunning()).toBe(true);
      expect(logger.info).toHaveBeenCalledWith('Starting external worker process', {
        executable: '/usr/local/bin/invoker-preview-worker',
        argCount: 1,
        cwd: '/srv/invoker',
      });
      const loggedFields = logger.info.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(loggedFields.args).toBeUndefined();
      expect(spawnMock).toHaveBeenCalledWith('/usr/local/bin/invoker-preview-worker', ['--token=secret-value'], {
        cwd: '/srv/invoker',
        env: expect.not.objectContaining({ EXTERNAL_WORKER_TEST_SECRET: 'secret-value' }),
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      const spawnOptions = spawnMock.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv };
      expect(spawnOptions.env).not.toBe(process.env);

      const waitForExit = runtime.waitForExit();
      await runtime.stop();
      await waitForExit;

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(runtime.isRunning()).toBe(false);
    } finally {
      if (previousSecret === undefined) {
        delete process.env.EXTERNAL_WORKER_TEST_SECRET;
      } else {
        process.env.EXTERNAL_WORKER_TEST_SECRET = previousSecret;
      }
    }
  });
});
