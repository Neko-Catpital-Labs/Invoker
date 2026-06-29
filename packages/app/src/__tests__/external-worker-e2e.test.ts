import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createWorkerRegistry,
  type ExternalWorkerRuntime,
  type WorkerRuntimeDependencies,
} from '@invoker/execution-engine';
import { afterEach, describe, expect, it } from 'vitest';

import { registerExternalWorkersFromConfig } from '../external-worker-loader.js';

const fixturePath = fileURLToPath(new URL('./fixtures/sample-external-worker.mjs', import.meta.url));

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

const deps: WorkerRuntimeDependencies = {
  logger: silentLogger,
  store: {
    listWorkflows: () => [],
    loadTasks: () => [],
    listWorkflowMutationIntents: () => [],
  },
  submitter: {
    submit: () => 0,
  },
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await delay(25);
  }
  throw new Error(message);
}

function isExternalWorkerRuntime(worker: unknown): worker is ExternalWorkerRuntime {
  return Boolean(
    worker
      && typeof worker === 'object'
      && 'finished' in worker
      && (worker as { finished?: unknown }).finished instanceof Promise,
  );
}

describe('external worker e2e', () => {
  const scratchDirs: string[] = [];

  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('registers, starts, and stops a configured sample external worker by kind', async () => {
    const scratchDir = mkdtempSync(join(tmpdir(), 'invoker-external-worker-e2e-'));
    scratchDirs.push(scratchDir);
    const markerPath = join(scratchDir, 'started.json');

    const registry = registerExternalWorkersFromConfig(
      [{
        kind: 'sample-external',
        launch: {
          executable: process.execPath,
          args: [fixturePath, markerPath],
          cwd: scratchDir,
        },
      }],
      createWorkerRegistry(),
    );

    const definition = registry.get('sample-external');
    expect(definition).toBeDefined();
    expect(registry.list().map((worker) => worker.kind)).toEqual(['sample-external']);

    const worker = definition!.factory(deps);
    expect(isExternalWorkerRuntime(worker)).toBe(true);
    expect(worker.identity.kind).toBe('sample-external');
    expect(worker.isRunning()).toBe(false);

    try {
      worker.start();
      await waitFor(() => existsSync(markerPath), 'sample external worker did not launch');

      expect(worker.isRunning()).toBe(true);
      expect(JSON.parse(readFileSync(markerPath, 'utf8'))).toEqual(
        expect.objectContaining({ started: true }),
      );
    } finally {
      await worker.stop();
      await worker.finished;
    }

    expect(worker.isRunning()).toBe(false);
  });
});
