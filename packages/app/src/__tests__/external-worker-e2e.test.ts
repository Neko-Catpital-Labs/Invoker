import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createWorkerRegistry,
  type WorkerRuntimeDependencies,
} from '@invoker/execution-engine';
import { afterEach, describe, expect, it } from 'vitest';

import { registerExternalWorkersFromConfig } from '../external-worker-loader.js';
import { createWorkerRuntimeController } from '../worker-control.js';

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

const persistence = {
  listWorkerActions: () => [],
  listWorkflows: () => [],
  loadTasks: () => [],
  getEvents: () => [],
  getEventsByTypes: () => [],
  countEventsByTypes: () => [],
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

function readMarker(markerPath: string): { pid?: number; started?: boolean; stopped?: boolean } {
  return JSON.parse(readFileSync(markerPath, 'utf8')) as {
    pid?: number;
    started?: boolean;
    stopped?: boolean;
  };
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
      createWorkerRegistry<WorkerRuntimeDependencies>(),
    );

    const definition = registry.get('sample-external');
    expect(definition).toBeDefined();
    expect(registry.list().map((worker) => worker.kind)).toEqual(['sample-external']);

    const controller = createWorkerRuntimeController({
      registry,
      deps,
      autoStartKinds: [],
      persistence,
      canControl: () => true,
    });

    expect(controller.snapshot().workers.find((worker) => worker.kind === 'sample-external')?.lifecycle)
      .toBe('stopped');

    try {
      const started = controller.start('sample-external');
      expect(started.lifecycle).toBe('running');

      await waitFor(() => existsSync(markerPath), 'sample external worker did not launch');
      const launchMarker = readMarker(markerPath);
      expect(launchMarker).toEqual(expect.objectContaining({ started: true, stopped: false }));
      expect(typeof launchMarker.pid).toBe('number');

      expect(controller.snapshot().workers.find((worker) => worker.kind === 'sample-external')?.lifecycle)
        .toBe('running');
    } finally {
      const stopped = await controller.stop('sample-external');
      expect(stopped.lifecycle).toBe('stopped');
    }

    await waitFor(
      () => existsSync(markerPath) && readMarker(markerPath).stopped === true,
      'sample external worker did not stop cleanly',
    );
  });
});
