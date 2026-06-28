import { existsSync, mkdtempSync, readFileSync, rmSync, watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { Logger } from '@invoker/contracts';
import { createWorkerRegistry } from '@invoker/execution-engine';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerExternalWorkers } from '../external-worker-loader.js';
import { runHeadless, type HeadlessDeps } from '../headless.js';

const sampleWorkerPath = resolve(__dirname, 'fixtures/sample-external-worker.mjs');

type Marker = { pid: number; signal?: string; state: string };

const tempRoots: string[] = [];
let previousInvokerDbDir: string | undefined;

function makeLogger(): Logger {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger;
}

function makeDeps(homeRoot: string, readyPath: string, stoppedPath: string): HeadlessDeps {
  return {
    logger: makeLogger(),
    orchestrator: {} as never,
    persistence: {
      enqueueWorkflowMutationIntent: vi.fn(),
    } as never,
    executorRegistry: {} as never,
    messageBus: {} as never,
    commandService: {} as never,
    repoRoot: homeRoot,
    invokerConfig: {
      externalWorkers: [{
        kind: 'sample-external',
        launch: {
          executable: process.execPath,
          args: [sampleWorkerPath, '--ready', readyPath, '--stopped', stoppedPath],
        },
      }],
    },
    initServices: async () => {},
    wireSlackBot: async () => ({}),
  };
}

function readMarker(path: string): Marker {
  return JSON.parse(readFileSync(path, 'utf8')) as Marker;
}

async function waitForMarker(path: string, timeoutMs = 5_000): Promise<Marker> {
  if (existsSync(path)) return readMarker(path);

  const found = Promise.withResolvers<void>();
  const timeout = setTimeout(() => {
    found.reject(new Error(`Timed out waiting for marker: ${path}`));
  }, timeoutMs);
  const watcher = watch(dirname(path), (_event, filename) => {
    if (filename?.toString() === basename(path) && existsSync(path)) {
      found.resolve();
    }
  });
  watcher.once('error', found.reject);
  if (existsSync(path)) {
    clearTimeout(timeout);
    watcher.close();
    return readMarker(path);
  }

  try {
    await found.promise;
    return readMarker(path);
  } finally {
    clearTimeout(timeout);
    watcher.close();
  }
}

describe('external worker loader e2e', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    if (previousInvokerDbDir === undefined) {
      delete process.env.INVOKER_DB_DIR;
    } else {
      process.env.INVOKER_DB_DIR = previousInvokerDbDir;
    }
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('registers, starts, and stops a configured external worker through the headless worker door', async () => {
    const homeRoot = mkdtempSync(join(tmpdir(), 'invoker-external-worker-e2e-'));
    tempRoots.push(homeRoot);
    previousInvokerDbDir = process.env.INVOKER_DB_DIR;
    process.env.INVOKER_DB_DIR = homeRoot;

    const readyPath = join(homeRoot, 'sample-ready.json');
    const stoppedPath = join(homeRoot, 'sample-stopped.json');
    const deps = makeDeps(homeRoot, readyPath, stoppedPath);
    const registry = registerExternalWorkers(createWorkerRegistry(), deps.invokerConfig.externalWorkers);
    const definition = registry.get('sample-external');

    expect(definition).toBeDefined();
    expect(definition?.kind).toBe('sample-external');

    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    });

    const beforeSigintListeners = process.listenerCount('SIGINT');
    const beforeSigtermListeners = process.listenerCount('SIGTERM');
    const doorFinished = Promise.withResolvers<void>();
    const doorRun = runHeadless(['worker', 'sample-external'], deps);
    let doorSettled = false;
    let sigtermSent = false;
    let ready: Marker | undefined;
    doorRun.then(
      () => {
        doorSettled = true;
        doorFinished.resolve();
      },
      (error) => {
        doorSettled = true;
        doorFinished.reject(error);
      },
    );

    try {
      ready = await Promise.race([
        waitForMarker(readyPath),
        doorFinished.promise.then(() => {
          throw new Error('External worker door exited before the sample worker started');
        }),
      ]);
      expect(ready.state).toBe('ready');
      expect(ready.pid).toBeGreaterThan(0);
      expect(existsSync(join(homeRoot, 'locks', 'worker-sample-external.lock'))).toBe(true);

      process.emit('SIGTERM');
      sigtermSent = true;
      await doorRun;
    } finally {
      if (!sigtermSent && !doorSettled) process.emit('SIGTERM');
      if (!doorSettled) await doorRun.catch(() => undefined);
    }

    if (!ready) throw new Error('External worker did not report ready before shutdown');
    const stopped = await waitForMarker(stoppedPath);
    expect(stopped).toEqual({ pid: ready.pid, signal: 'SIGTERM', state: 'stopped' });
    expect(existsSync(join(homeRoot, 'locks', 'worker-sample-external.lock'))).toBe(false);
    expect(process.listenerCount('SIGINT')).toBe(beforeSigintListeners);
    expect(process.listenerCount('SIGTERM')).toBe(beforeSigtermListeners);
    expect(stdout).toContain('sample-external worker scan completed.');
  });
});
