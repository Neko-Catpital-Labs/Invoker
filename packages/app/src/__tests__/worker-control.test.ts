import { describe, expect, it, vi } from 'vitest';
import { LocalBus, type MessageBus } from '@invoker/transport';
import {
  AUTO_FIX_WORKER_KIND,
  CI_FAILURE_WORKER_KIND,
  createWorkerRegistry,
  PR_STATUS_WORKER_KIND,
  type WorkerRuntime,
  type WorkerRuntimeDependencies,
  type WorkerSubscriptionFactory,
} from '@invoker/execution-engine';

import {
  AUTO_STARTED_OWNER_WORKER_KINDS,
  createWorkerRuntimeController,
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

function deps(messageBus?: MessageBus): WorkerRuntimeDependencies {
  return {
    store: {} as WorkerRuntimeDependencies['store'],
    submitter: { submit: vi.fn(() => 1) },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    messageBus,
  } as WorkerRuntimeDependencies;
}

function controller(messageBus?: MessageBus) {
  const registry = createWorkerRegistry<WorkerRuntimeDependencies>();
  const runtimes = new Map<string, TestWorkerRuntime[]>();
  const register = (
    kind: string,
    note: string,
    runtimeKind = kind,
    subscriptions?: WorkerSubscriptionFactory<WorkerRuntimeDependencies>,
  ) => {
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
      ...(subscriptions ? { subscriptions } : {}),
    });
  };
  register(AUTO_FIX_WORKER_KIND, 'Auto-fixes failed tasks.', 'recovery');
  register(PR_STATUS_WORKER_KIND, 'Checks pull request status.');
  register(CI_FAILURE_WORKER_KIND, 'Repairs failed CI.');
  register('external-preview', 'External preview worker.');

  return {
    registry,
    runtimes,
    controller: createWorkerRuntimeController({
      registry,
      deps: deps(messageBus),
      autoStartKinds: AUTO_STARTED_OWNER_WORKER_KINDS,
      persistence: persistence() as never,
      canControl: () => true,
    }),
  };
}

describe('createWorkerRuntimeController', () => {
  it('auto-start starts only pr-status and ci-failure', () => {
    const setup = controller();

    setup.controller.startAutoStartedWorkers();
    const snapshot = setup.controller.snapshot();

    expect(snapshot.workers.find((worker) => worker.kind === PR_STATUS_WORKER_KIND)?.lifecycle).toBe('running');
    expect(snapshot.workers.find((worker) => worker.kind === CI_FAILURE_WORKER_KIND)?.lifecycle).toBe('running');
    expect(snapshot.workers.find((worker) => worker.kind === AUTO_FIX_WORKER_KIND)?.lifecycle).toBe('stopped');
    expect(snapshot.workers.find((worker) => worker.kind === 'external-preview')?.lifecycle).toBe('stopped');
  });

  it('autofix remains stopped until explicitly started', () => {
    const setup = controller();

    setup.controller.startAutoStartedWorkers();
    expect(setup.runtimes.get(AUTO_FIX_WORKER_KIND)).toBeUndefined();

    const row = setup.controller.start(AUTO_FIX_WORKER_KIND);

    expect(row.lifecycle).toBe('running');
    expect(row.runtimeKind).toBe('recovery');
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
  it('wakes subscribed workers on matching bus messages', () => {
    const bus = new LocalBus();
    const setup = controller(bus);
    setup.registry.register({
      kind: 'subscribed-worker',
      note: 'Wakes on matching test messages.',
      factory: () => {
        const created = runtime('subscribed-worker');
        const list = setup.runtimes.get('subscribed-worker') ?? [];
        list.push(created);
        setup.runtimes.set('subscribed-worker', list);
        return created;
      },
      subscriptions: () => [{
        channel: 'test.channel',
        shouldWake: (message: { kind?: string }) => message.kind === 'wake-me',
      }],
    });

    setup.controller.start('subscribed-worker');
    const created = setup.runtimes.get('subscribed-worker')?.[0];
    expect(created).toBeDefined();

    bus.publish('test.channel', { kind: 'ignore-me' });
    bus.publish('test.channel', { kind: 'wake-me' });

    expect(created?.wake).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes worker wake handlers on stop', async () => {
    const bus = new LocalBus();
    const setup = controller(bus);
    setup.registry.register({
      kind: 'stoppable-worker',
      note: 'Stops listening after stop.',
      factory: () => {
        const created = runtime('stoppable-worker');
        const list = setup.runtimes.get('stoppable-worker') ?? [];
        list.push(created);
        setup.runtimes.set('stoppable-worker', list);
        return created;
      },
      subscriptions: () => [{
        channel: 'test.channel',
        shouldWake: (message: { wake?: boolean }) => message.wake === true,
      }],
    });

    setup.controller.start('stoppable-worker');
    const created = setup.runtimes.get('stoppable-worker')?.[0];
    expect(created).toBeDefined();

    await setup.controller.stop('stoppable-worker');
    bus.publish('test.channel', { wake: true });

    expect(created?.wake).not.toHaveBeenCalled();
  });
});
