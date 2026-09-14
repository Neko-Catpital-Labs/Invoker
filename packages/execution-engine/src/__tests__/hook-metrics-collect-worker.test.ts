import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

import type { WorkerActionWrite } from '@invoker/data-store';
import { describe, expect, it, vi } from 'vitest';

import { createWorkerRegistry } from '../worker-registry.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerDecisionStore } from '../worker-decision-ledger.js';
import {
  createHookMetricsCollectWorker,
  HOOK_METRICS_COLLECT_SCRIPT_PATH,
  HOOK_METRICS_COLLECT_WORKER_KIND,
  parseUncheckedMachineCount,
  registerHookMetricsCollectWorker,
  runHookMetricsCollectTick,
  type HookMetricsCollectSpawn,
  type HookMetricsCollectWorkerOptions,
} from '../workers/hook-metrics-collect-worker.js';

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as HookMetricsCollectWorkerOptions['logger'];
}

function makeStore(): { store: WorkerDecisionStore; rows: WorkerActionWrite[] } {
  const rows: WorkerActionWrite[] = [];
  return {
    rows,
    store: {
      getWorkerAction: () => undefined,
      upsertWorkerAction: (action) => {
        rows.push(action);
        return action as never;
      },
    },
  };
}

function makeSpawn(
  results: Array<{ code: number; stdout?: string; stderr?: string }>,
): HookMetricsCollectSpawn & ReturnType<typeof vi.fn> {
  const spawnCollector = vi.fn((() => {
    const result = results.shift();
    if (!result) throw new Error('unexpected spawn');

    const child = new EventEmitter() as ChildProcess;
    Object.defineProperty(child, 'stdout', { value: new EventEmitter() });
    Object.defineProperty(child, 'stderr', { value: new EventEmitter() });

    queueMicrotask(() => {
      if (result.stdout) child.stdout?.emit('data', result.stdout);
      if (result.stderr) child.stderr?.emit('data', result.stderr);
      child.emit('close', result.code);
    });

    return child;
  }) as HookMetricsCollectSpawn);
  return spawnCollector as HookMetricsCollectSpawn & ReturnType<typeof vi.fn>;
}

const noopSubmitter = { submit: () => 0 };

describe('hook-metrics-collect worker', () => {
  it('is registered but does not start without a hookMetricsCollect config entry', () => {
    const registry = registerHookMetricsCollectWorker(createWorkerRegistry<WorkerRuntimeDependencies>());
    const definition = registry.get(HOOK_METRICS_COLLECT_WORKER_KIND);

    expect(definition).toBeDefined();
    expect(() => definition?.factory({
      store: makeStore().store as never,
      submitter: noopSubmitter as never,
      logger: makeLogger(),
    })).toThrow(/hook-metrics-collect worker is not configured/);
  });

  it('runs the collector from the catstack checkout and records a completed decision row', async () => {
    const spawnCollector = makeSpawn([{ code: 0, stdout: '{"unchecked_machine_count":2}\n' }]);
    const { store, rows } = makeStore();

    await runHookMetricsCollectTick({
      logger: makeLogger(),
      catstackRepoPath: '/tmp/catstack',
      store,
      spawnCollector,
    });

    expect(spawnCollector).toHaveBeenCalledWith('python3', [HOOK_METRICS_COLLECT_SCRIPT_PATH], {
      cwd: '/tmp/catstack',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.workerKind).toBe(HOOK_METRICS_COLLECT_WORKER_KIND);
    expect(rows[0]?.actionType).toBe('hook-metrics-collect');
    expect(rows[0]?.subjectId).toBe('fleet');
    expect(rows[0]?.status).toBe('completed');
    expect(rows[0]?.payload).toMatchObject({
      exitStatus: 0,
      uncheckedMachineCount: 2,
      stdout: '{"unchecked_machine_count":2}\n',
    });
  });

  it('records non-zero exits as failed rows and keeps later ticks runnable', async () => {
    const spawnCollector = makeSpawn([
      { code: 7, stdout: 'unchecked machines: 4\n', stderr: 'collector failed\n' },
      { code: 0, stdout: 'unchecked machines: 0\n' },
    ]);
    const { store, rows } = makeStore();
    const worker = createHookMetricsCollectWorker({
      logger: makeLogger(),
      catstackRepoPath: '/tmp/catstack',
      tickOnStart: false,
      store,
      spawnCollector,
    });

    await worker.tick('manual');
    await worker.tick('manual');
    await worker.stop();

    expect(spawnCollector).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.status)).toEqual(['failed', 'completed']);
    expect(rows[0]?.payload).toMatchObject({
      exitStatus: 7,
      uncheckedMachineCount: 4,
      stderr: 'collector failed\n',
    });
    expect(rows[1]?.payload).toMatchObject({
      exitStatus: 0,
      uncheckedMachineCount: 0,
    });
    expect(rows[0]?.externalKey).not.toBe(rows[1]?.externalKey);
  });
});

describe('parseUncheckedMachineCount', () => {
  it('parses json, arrays, and human-readable stdout', () => {
    expect(parseUncheckedMachineCount('{"uncheckedMachineCount":3}')).toBe(3);
    expect(parseUncheckedMachineCount('{"unchecked_machines":["do1","do2"]}')).toBe(2);
    expect(parseUncheckedMachineCount('unchecked machines: 5')).toBe(5);
  });
});
