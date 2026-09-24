import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_LOGIN_WATCH_WORKER_KIND,
  createWorkerRegistry,
  registerAgentLoginWatchWorker,
  type WorkerRuntimeDependencies,
} from '@invoker/execution-engine';
import type { MessageBus } from '@invoker/transport';

import {
  ALWAYS_AUTO_STARTED_OWNER_WORKER_KINDS,
  autoStartedOwnerWorkerKinds,
  BUILT_IN_WORKER_KINDS,
  createWorkerRuntimeController,
} from '../worker-control.js';

function persistence(initialDesired: Record<string, boolean> = {}) {
  const desired = new Map(Object.entries(initialDesired));
  return {
    listWorkerActions: vi.fn(() => []),
    getWorkerDesiredState: vi.fn((workerKind: string) => (
      desired.has(workerKind)
        ? { workerKind, desiredEnabled: desired.get(workerKind) === true, updatedAt: '2026-01-01T00:00:00.000Z' }
        : undefined
    )),
    setWorkerDesiredState: vi.fn((workerKind: string, desiredEnabled: boolean) => {
      desired.set(workerKind, desiredEnabled);
      return { workerKind, desiredEnabled, updatedAt: '2026-01-01T00:00:00.000Z' };
    }),
    listWorkerDesiredStates: vi.fn(() => Array.from(desired.entries()).map(([workerKind, desiredEnabled]) => ({
      workerKind,
      desiredEnabled,
      updatedAt: '2026-01-01T00:00:00.000Z',
    }))),
  };
}

function fakeMessageBus(): MessageBus {
  return {
    publish: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    request: vi.fn(),
    onRequest: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as MessageBus;
}

function runtimeDeps(messageBus: MessageBus): WorkerRuntimeDependencies {
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
    agentLoginWatch: {
      enabled: true,
      remoteTargets: [
        { name: 'do1', connection: { host: 'do1.example.com', user: 'root' } },
      ],
    },
  } as WorkerRuntimeDependencies;
}

describe('agent-login-watch worker control wiring', () => {
  it('is on the built-in worker allowlist', () => {
    expect(BUILT_IN_WORKER_KINDS.has(AGENT_LOGIN_WATCH_WORKER_KIND)).toBe(true);
  });

  it('is not in the always-auto-started list, so its desired state defaults to off', () => {
    expect(ALWAYS_AUTO_STARTED_OWNER_WORKER_KINDS).not.toContain(AGENT_LOGIN_WATCH_WORKER_KIND);
    expect(autoStartedOwnerWorkerKinds()).not.toContain(AGENT_LOGIN_WATCH_WORKER_KIND);
  });

  it('does not start on boot while a sibling always-auto-started worker still does', () => {
    const registry = createWorkerRegistry<WorkerRuntimeDependencies>();
    registerAgentLoginWatchWorker(registry);
    let siblingStarted = false;
    registry.register({
      kind: 'sibling-worker',
      note: 'sibling test worker',
      factory: () => {
        siblingStarted = true;
        return {
          identity: { kind: 'sibling-worker', instanceId: 'sibling-worker-instance' },
          start: vi.fn(),
          wake: vi.fn(),
          tick: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
          isRunning: vi.fn(() => true),
        };
      },
    });

    const store = persistence();
    const controller = createWorkerRuntimeController({
      registry,
      deps: runtimeDeps(fakeMessageBus()),
      autoStartKinds: ['sibling-worker'],
      persistence: store as never,
      canControl: () => true,
    });

    controller.startAutoStartedWorkers('boot');

    expect(siblingStarted).toBe(true);
    const entry = controller.snapshot().workers.find((worker) => worker.kind === AGENT_LOGIN_WATCH_WORKER_KIND);
    expect(entry?.lifecycle).toBe('stopped');
    expect(entry?.autoStarts).toBe(false);
  });

  it('starts with remoteTargets and messageBus wired through once explicitly enabled', () => {
    const registry = createWorkerRegistry<WorkerRuntimeDependencies>();
    registerAgentLoginWatchWorker(registry);
    const messageBus = fakeMessageBus();
    const deps = runtimeDeps(messageBus);

    const store = persistence();
    const controller = createWorkerRuntimeController({
      registry,
      deps,
      autoStartKinds: [],
      persistence: store as never,
      canControl: () => true,
    });

    expect(() => controller.start(AGENT_LOGIN_WATCH_WORKER_KIND)).not.toThrow();
    const entry = controller.snapshot().workers.find((worker) => worker.kind === AGENT_LOGIN_WATCH_WORKER_KIND);
    expect(entry?.lifecycle).toBe('running');
    expect(deps.agentLoginWatch?.remoteTargets).toHaveLength(1);
    expect(deps.messageBus).toBe(messageBus);
  });
});
