import { describe, expect, it, vi } from 'vitest';
import {
  AUTO_FIX_WORKER_KIND,
  CI_FAILURE_WORKER_KIND,
  createWorkerRegistry,
  PR_STATUS_WORKER_KIND,
  type WorkerRuntime,
  type WorkerRuntimeDependencies,
} from '@invoker/execution-engine';

import {
  AUTO_STARTED_OWNER_WORKER_KINDS,
  createWorkerRuntimeController,
  createLocalWorkerStatusSnapshot,
} from '../worker-control.js';

interface TestWorkerRuntime extends WorkerRuntime {
  forceExit: () => void;
  readonly starts: number;
  readonly stops: number;
}

function runtime(kind: string): TestWorkerRuntime {
  let running = false;
  let starts = 0;
  let stops = 0;
  return {
    identity: { kind, instanceId: `${kind}-instance` },
    start: vi.fn(() => {
      starts += 1;
      running = true;
    }),
    wake: vi.fn(),
    tick: vi.fn(async () => {}),
    stop: vi.fn(async () => {
      stops += 1;
      running = false;
    }),
    isRunning: vi.fn(() => running),
    forceExit: () => { running = false; },
    get starts() { return starts; },
    get stops() { return stops; },
  };
}

function persistence() {
  return {
    listWorkerActions: vi.fn(() => []),
    listWorkflows: vi.fn(() => []),
    loadTasks: vi.fn(() => []),
    getEvents: vi.fn(() => []),
  };
}

function deps(): WorkerRuntimeDependencies {
  return {
    store: {} as WorkerRuntimeDependencies['store'],
    submitter: { submit: vi.fn(() => 1) },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  } as WorkerRuntimeDependencies;
}

function controller() {
  const registry = createWorkerRegistry<WorkerRuntimeDependencies>();
  const runtimes = new Map<string, TestWorkerRuntime[]>();
  const register = (kind: string, note: string, runtimeKind = kind) => {
    registry.register({
      kind,
      note,
      factory: () => {
        const created = runtime(runtimeKind);
        const list = runtimes.get(kind) ?? [];
        list.push(created);
        runtimes.set(kind, list);
        return created;
      },
    });
  };
  register(AUTO_FIX_WORKER_KIND, 'Auto-fixes failed tasks.', 'recovery');
  register(PR_STATUS_WORKER_KIND, 'Checks pull request status.');
  register(CI_FAILURE_WORKER_KIND, 'Repairs failed CI.');
  register('external-preview', 'External preview worker.');

  return {
    runtimes,
    controller: createWorkerRuntimeController({
      registry,
      deps: deps(),
      autoStartKinds: AUTO_STARTED_OWNER_WORKER_KINDS,
      persistence: persistence() as never,
      canControl: () => true,
    }),
  };
}

describe('createWorkerRuntimeController', () => {
  it('auto-start starts every built-in owner worker', () => {
    const setup = controller();

    setup.controller.startAutoStartedWorkers();
    const snapshot = setup.controller.snapshot();

    expect(snapshot.workers.find((worker) => worker.kind === AUTO_FIX_WORKER_KIND)).toMatchObject({
      lifecycle: 'running',
      source: 'built-in',
      availability: 'available',
      running: true,
    });
    expect(snapshot.workers.find((worker) => worker.kind === PR_STATUS_WORKER_KIND)?.lifecycle).toBe('running');
    expect(snapshot.workers.find((worker) => worker.kind === CI_FAILURE_WORKER_KIND)?.lifecycle).toBe('running');
    expect(snapshot.workers.find((worker) => worker.kind === 'external-preview')).toMatchObject({
      lifecycle: 'stopped',
      source: 'external',
    });
  });

  it('duplicate start is idempotent', () => {
    const setup = controller();

    setup.controller.start(PR_STATUS_WORKER_KIND);
    setup.controller.start(PR_STATUS_WORKER_KIND);

    expect(setup.runtimes.get(PR_STATUS_WORKER_KIND)).toHaveLength(1);
  });

  it('stop is idempotent', async () => {
    const setup = controller();

    const stoppedBeforeStart = await setup.controller.stop(PR_STATUS_WORKER_KIND);
    expect(stoppedBeforeStart.lifecycle).toBe('stopped');

    setup.controller.start(PR_STATUS_WORKER_KIND);
    const stopped = await setup.controller.stop(PR_STATUS_WORKER_KIND);
    const stoppedAgain = await setup.controller.stop(PR_STATUS_WORKER_KIND);

    expect(stopped.lifecycle).toBe('stopped');
    expect(stoppedAgain.lifecycle).toBe('stopped');
    expect(setup.runtimes.get(PR_STATUS_WORKER_KIND)?.[0]?.stops).toBe(1);
  });

  it('retry budget policy does not disable worker starts', () => {
    const setup = controller();

    const autoFix = setup.controller.start(AUTO_FIX_WORKER_KIND);
    const ciFailure = setup.controller.start(CI_FAILURE_WORKER_KIND);

    expect(autoFix).toMatchObject({
      lifecycle: 'running',
      policy: 'enabled',
      startable: false,
    });
    expect(ciFailure).toMatchObject({
      lifecycle: 'running',
      policy: 'enabled',
      startable: false,
    });
  });

  it('an exited external worker row reports exited', () => {
    const setup = controller();

    setup.controller.start('external-preview');
    setup.runtimes.get('external-preview')?.[0]?.forceExit();

    expect(setup.controller.snapshot().workers.find((worker) => worker.kind === 'external-preview')).toMatchObject({
      lifecycle: 'exited',
      policy: 'unknown',
    });
  });

  it('combines worker action rows and auto-fix task events in recent logs', () => {
    const registry = createWorkerRegistry<WorkerRuntimeDependencies>();
    registry.register({
      kind: AUTO_FIX_WORKER_KIND,
      note: 'Auto-fixes failed tasks.',
      source: 'built-in',
      factory: () => runtime('recovery'),
    });

    const snapshot = createLocalWorkerStatusSnapshot({
      registry,
      autoStartKinds: AUTO_STARTED_OWNER_WORKER_KINDS,
      persistence: {
        listWorkerActions: vi.fn(() => [{
          id: 'action-1',
          workerKind: AUTO_FIX_WORKER_KIND,
          actionType: 'fix-with-agent',
          workflowId: 'wf-1',
          taskId: 'wf-1/task-1',
          subjectType: 'task',
          subjectId: 'wf-1/task-1',
          externalKey: 'wf-1/task-1',
          status: 'queued',
          attemptCount: 1,
          payload: { reason: 'failed' },
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:01.000Z',
        }]),
        listTaskEvents: vi.fn(() => [{
          id: 7,
          taskId: 'wf-1/task-1',
          eventType: 'debug.auto-fix',
          payload: '{"phase":"worker-autofix-skip","reason":"not-eligible"}',
          createdAt: '2026-01-01T00:00:02.000Z',
        }]),
        listWorkflows: vi.fn(() => []),
        loadTasks: vi.fn(() => []),
        getEvents: vi.fn(() => []),
      } as never,
    });

    expect(snapshot.workers[0]?.recentLogs).toEqual([
      expect.objectContaining({
        source: 'task_events',
        eventType: 'debug.auto-fix',
        payload: expect.objectContaining({ phase: 'worker-autofix-skip' }),
      }),
      expect.objectContaining({
        source: 'worker_actions',
        actionType: 'fix-with-agent',
        status: 'queued',
      }),
    ]);
  });
});
