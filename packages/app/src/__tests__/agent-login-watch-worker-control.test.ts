import { describe, expect, it, vi } from 'vitest';
import { Channels, type MessageBus } from '@invoker/transport';
import {
  createWorkerRegistry,
  registerBuiltinWorkers,
  type WorkerRuntimeDependencies,
} from '@invoker/execution-engine';
import { resolveAgentLoginWatchWorkerConfig } from '../config.js';
import {
  AGENT_LOGIN_WATCH_WORKER_KIND,
  ALWAYS_AUTO_STARTED_OWNER_WORKER_KINDS,
  BUILT_IN_WORKER_KINDS,
  createLocalWorkerStatusSnapshot,
} from '../worker-control.js';

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => silentLogger,
};

const emptyStore: WorkerRuntimeDependencies['store'] = {
  listWorkflows: () => [],
  loadTasks: () => [],
  listWorkflowMutationIntents: () => [],
  recordWorkerAction: vi.fn(),
  getWorkerAction: vi.fn(),
};

function persistence() {
  return {
    listWorkerActions: vi.fn(() => []),
    listTaskEvents: vi.fn(() => []),
    listWorkflows: vi.fn(() => []),
    loadTasks: vi.fn(() => []),
    getEvents: vi.fn(() => []),
    getEventsByTypes: vi.fn(() => []),
    countEventsByTypes: vi.fn(() => []),
    getWorkerDesiredState: vi.fn(() => undefined),
  };
}

describe('agent-login-watch owner worker control', () => {
  it('lists agent-login-watch as a built-in worker without enabling it by default', () => {
    const registry = registerBuiltinWorkers(createWorkerRegistry<WorkerRuntimeDependencies>());
    const snapshot = createLocalWorkerStatusSnapshot({
      registry,
      persistence: persistence(),
      autoStartKinds: [...ALWAYS_AUTO_STARTED_OWNER_WORKER_KINDS],
    });
    const worker = snapshot.workers.find((entry) => entry.kind === AGENT_LOGIN_WATCH_WORKER_KIND);

    expect(registry.get(AGENT_LOGIN_WATCH_WORKER_KIND)).toBeDefined();
    expect(BUILT_IN_WORKER_KINDS.has(AGENT_LOGIN_WATCH_WORKER_KIND)).toBe(true);
    expect([...ALWAYS_AUTO_STARTED_OWNER_WORKER_KINDS]).not.toContain(AGENT_LOGIN_WATCH_WORKER_KIND);
    expect(worker?.desiredEnabled).toBe(false);
    expect(worker?.autoStarts).toBe(false);
  });

  it('builds the owner runtime with resolved config, remote targets, and message bus', async () => {
    const publish = vi.fn();
    const messageBus = { publish } as unknown as MessageBus;
    const runProbe = vi.fn(async (request: { host: string }) => ({
      exitCode: request.host === 'do1' ? 1 : 0,
      output: request.host === 'do1'
        ? 'Your access token could not be refreshed because your refresh token was revoked.'
        : 'ok',
    }));
    const registry = registerBuiltinWorkers(createWorkerRegistry<WorkerRuntimeDependencies>());
    const definition = registry.get(AGENT_LOGIN_WATCH_WORKER_KIND);

    const runtime = definition?.factory({
      store: emptyStore,
      submitter: { submit: vi.fn(() => 1) },
      logger: silentLogger,
      messageBus,
      agentLoginWatch: {
        ...resolveAgentLoginWatchWorkerConfig({ agentLoginWatch: { intervalMinutes: 5 } } as never),
        enabled: true,
        tickOnStart: false,
        runProbe,
        remoteTargets: [{
          name: 'do1',
          connection: {
            host: '203.0.113.10',
            user: 'invoker',
            sshKeyPath: '/tmp/id_ed25519',
            port: 22,
          },
        }],
      },
    });

    expect(runtime?.identity.kind).toBe(AGENT_LOGIN_WATCH_WORKER_KIND);

    await runtime?.tick('manual');

    expect(runProbe.mock.calls.map(([request]) => request.host).sort()).toEqual(['do1', 'do1', 'owner', 'owner']);
    expect(publish).toHaveBeenCalledWith(Channels.SURFACE_EVENT, expect.objectContaining({
      type: 'alert',
      alert: expect.objectContaining({
        source: AGENT_LOGIN_WATCH_WORKER_KIND,
        alertKey: 'agent-login:do1:claude',
      }),
    }));
  });
});
