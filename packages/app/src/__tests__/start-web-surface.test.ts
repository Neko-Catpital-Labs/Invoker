import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { AgentRegistry, ExecutorRegistry } from '@invoker/execution-engine';
import type { Orchestrator } from '@invoker/workflow-core';
import { OwnerCapabilityRegistry } from '../owner-capability-registry.js';

const mocks = vi.hoisted(() => {
  const bridgeClose = vi.fn(async () => undefined);
  const bridgeBroadcast = vi.fn();
  const terminalSessionDispose = vi.fn();
  const terminalSessionFlushPending = vi.fn();
  return {
    bridgeClose,
    bridgeBroadcast,
    startWebBridge: vi.fn(() => ({
      close: bridgeClose,
      whenReady: Promise.resolve(4200),
      broadcast: bridgeBroadcast,
      port: 4200,
    })),
    resolveWebUiDistDir: vi.fn(() => '/tmp/ui'),
    terminalSessionDispose,
    terminalSessionFlushPending,
    registerTerminalSessionPersistence: vi.fn(() => ({
      flushPending: terminalSessionFlushPending,
      dispose: terminalSessionDispose,
    })),
    createTaskTerminalAdapter: vi.fn(() => ({
      open: vi.fn(async () => ({ opened: true })),
      list: vi.fn(async () => []),
      write: vi.fn(async () => ({ ok: true })),
      resize: vi.fn(async () => ({ ok: true })),
      close: vi.fn(async () => ({ ok: true })),
    })),
    createEmbeddedTerminalBackend: vi.fn(() => ({
      name: 'bash',
      spawn: vi.fn(),
    })),
  };
});

vi.mock('../web/web-bridge-server.js', () => ({
  startWebBridge: mocks.startWebBridge,
  resolveWebUiDistDir: mocks.resolveWebUiDistDir,
}));

vi.mock('../terminal-session-ipc.js', () => ({
  registerTerminalSessionPersistence: mocks.registerTerminalSessionPersistence,
}));

vi.mock('../task-terminal-adapter.js', () => ({
  createTaskTerminalAdapter: mocks.createTaskTerminalAdapter,
}));

vi.mock('../embedded-terminal-backend.js', () => ({
  createEmbeddedTerminalBackend: mocks.createEmbeddedTerminalBackend,
}));

import {
  resolveWebToken,
  resolveWebHost,
  resolveWebPort,
  startHeadlessWebSurface,
  type StartHeadlessWebSurfaceDeps,
} from '../web/start-web-surface.js';

const ENV_KEYS = ['INVOKER_WEB_TOKEN', 'INVOKER_WEB_HOST', 'INVOKER_WEB_PORT'] as const;
const saved: Record<string, string | undefined> = {};

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeDeps(
  overrides: Partial<StartHeadlessWebSurfaceDeps> = {},
): StartHeadlessWebSurfaceDeps {
  return {
    logger: makeLogger(),
    orchestrator: {
      syncAllFromDb: vi.fn(),
      getAllTasks: vi.fn(() => []),
    } as unknown as Orchestrator,
    persistence: {
      listWorkflows: vi.fn(() => []),
      getActivityLogs: vi.fn(() => []),
      writeActivityLog: vi.fn(),
      listTerminalSessions: vi.fn(() => []),
      loadTask: vi.fn(() => undefined),
      deleteTerminalSession: vi.fn(),
      updateTerminalSession: vi.fn(),
      upsertTerminalSession: vi.fn(),
    } as unknown as SQLiteAdapter,
    messageBus: {
      subscribe: vi.fn(() => vi.fn()),
    } as unknown as StartHeadlessWebSurfaceDeps['messageBus'],
    agentRegistry: {} as AgentRegistry,
    mutations: {} as StartHeadlessWebSurfaceDeps['mutations'],
    deleteWorkflow: vi.fn(async () => undefined),
    detachWorkflow: vi.fn(async () => undefined),
    loadConfig: () => ({}),
    config: {},
    appRootDir: '/tmp/app',
    ...overrides,
  };
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  mocks.bridgeClose.mockClear();
  mocks.bridgeBroadcast.mockClear();
  mocks.startWebBridge.mockClear();
  mocks.resolveWebUiDistDir.mockClear();
  mocks.terminalSessionDispose.mockClear();
  mocks.terminalSessionFlushPending.mockClear();
  mocks.registerTerminalSessionPersistence.mockClear();
  mocks.createTaskTerminalAdapter.mockClear();
  mocks.createEmbeddedTerminalBackend.mockClear();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('web surface configuration resolution', () => {
  it('prefers env token over config and is undefined when neither is set', () => {
    expect(resolveWebToken({})).toBeUndefined();
    expect(resolveWebToken({ webToken: 'cfg' })).toBe('cfg');
    process.env.INVOKER_WEB_TOKEN = 'env';
    expect(resolveWebToken({ webToken: 'cfg' })).toBe('env');
  });

  it('resolves host/port with env precedence and sane defaults', () => {
    expect(resolveWebHost({})).toBe('127.0.0.1');
    expect(resolveWebHost({ webHost: '0.0.0.0' })).toBe('0.0.0.0');
    process.env.INVOKER_WEB_HOST = '10.0.0.1';
    expect(resolveWebHost({ webHost: '0.0.0.0' })).toBe('10.0.0.1');

    expect(resolveWebPort({})).toBe(4200);
    expect(resolveWebPort({ webPort: 5000 })).toBe(5000);
    process.env.INVOKER_WEB_PORT = '6000';
    expect(resolveWebPort({ webPort: 5000 })).toBe(6000);
  });
});

describe('startHeadlessWebSurface', () => {
  it('returns null and starts no server when no token is configured', () => {
    const deps = makeDeps();

    const result = startHeadlessWebSurface(deps);

    expect(result).toBeNull();
    expect(deps.messageBus.subscribe).not.toHaveBeenCalled();
    expect(deps.logger.info).toHaveBeenCalled();
    expect(mocks.startWebBridge).not.toHaveBeenCalled();
  });

  it('publishes a forced snapshot when the web refresh route runs', async () => {
    const tasks = [
      {
        id: 'wf-1/task-1',
        description: 'task 1',
        status: 'running',
        dependencies: [],
        createdAt: new Date('2026-01-01'),
        config: {},
        execution: {},
      },
    ];
    const workflows = [{ id: 'wf-1', name: 'Workflow 1', status: 'running' }];
    const deps = makeDeps({
      config: { webToken: 'secret' },
      orchestrator: {
        syncAllFromDb: vi.fn(),
        getAllTasks: vi.fn(() => tasks),
      } as unknown as Orchestrator,
      persistence: {
        listWorkflows: vi.fn(() => workflows),
        getActivityLogs: vi.fn(() => []),
        writeActivityLog: vi.fn(),
        listTerminalSessions: vi.fn(() => []),
        loadTask: vi.fn(() => undefined),
        deleteTerminalSession: vi.fn(),
        updateTerminalSession: vi.fn(),
        upsertTerminalSession: vi.fn(),
      } as unknown as SQLiteAdapter,
    });

    const result = startHeadlessWebSurface(deps);
    const dispatch = mocks.startWebBridge.mock.calls[0]?.[0].dispatch as (
      channel: string,
      args: unknown[],
    ) => Promise<unknown>;

    await expect(dispatch('invoker:refresh-task-graph', [])).resolves.toBeUndefined();
    expect(deps.orchestrator.syncAllFromDb).toHaveBeenCalledTimes(1);
    expect(deps.orchestrator.getAllTasks).toHaveBeenCalledTimes(1);
    expect(deps.persistence.listWorkflows).toHaveBeenCalledTimes(1);
    expect(mocks.bridgeBroadcast).toHaveBeenCalledWith(
      'invoker:task-graph-event',
      expect.objectContaining({
        type: 'snapshot',
        reason: 'refresh-task-graph',
        tasks,
        workflows,
        forced: true,
      }),
    );

    await result?.close();
  });

  it('passes the shared owner registry to authenticated web dispatch', async () => {
    const ownerCapabilities = new OwnerCapabilityRegistry();
    const start = vi.fn(async () => ['started']);
    ownerCapabilities.register('invoker:start', start);
    const deps = makeDeps({
      config: { webToken: 'secret' },
      ownerCapabilities,
    });

    const result = startHeadlessWebSurface(deps);
    const dispatch = mocks.startWebBridge.mock.calls[0]?.[0].dispatch as (
      channel: string,
      args: unknown[],
    ) => Promise<unknown>;

    await expect(dispatch('invoker:start', [])).resolves.toEqual(['started']);
    expect(start).toHaveBeenCalledOnce();

    await result?.close();
  });

  it('keeps browser task terminals disabled when terminal deps are absent', async () => {
    const deps = makeDeps({ config: { webToken: 'secret' } });

    const result = startHeadlessWebSurface(deps);

    expect(result).not.toBeNull();
    expect(mocks.createTaskTerminalAdapter).not.toHaveBeenCalled();
    expect(mocks.registerTerminalSessionPersistence).not.toHaveBeenCalled();
    expect(mocks.startWebBridge).toHaveBeenCalledWith(
      expect.objectContaining({ terminalEvents: undefined }),
    );

    const dispatch = mocks.startWebBridge.mock.calls[0]?.[0].dispatch as (
      channel: string,
      args: unknown[],
    ) => Promise<unknown>;
    await expect(dispatch('invoker:open-terminal', ['task-1'])).resolves.toEqual({
      opened: false,
      reason: 'Terminals are not available in the web UI',
    });
    await expect(dispatch('invoker:terminal-list', [])).resolves.toEqual([]);

    await result?.close();
  });

  it('wires task terminal support and disposes persistence on close when terminal deps are supplied', async () => {
    const taskHandles = new Map();
    const deps = makeDeps({
      config: { webToken: 'secret' },
      repoRoot: '/repo',
      executorRegistry: {} as ExecutorRegistry,
      taskHandles,
    });

    const result = startHeadlessWebSurface(deps);

    expect(result).not.toBeNull();
    expect(mocks.createEmbeddedTerminalBackend).toHaveBeenCalledWith(deps.config);
    expect(mocks.registerTerminalSessionPersistence).toHaveBeenCalledTimes(1);
    expect(mocks.createTaskTerminalAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        persistence: deps.persistence,
        executorRegistry: deps.executorRegistry,
        repoRoot: '/repo',
        taskHandles,
      }),
    );
    expect(mocks.startWebBridge).toHaveBeenCalledWith(
      expect.objectContaining({ terminalEvents: expect.any(Object) }),
    );

    await result?.close();

    expect(mocks.terminalSessionDispose).toHaveBeenCalledTimes(1);
    expect(mocks.bridgeClose).toHaveBeenCalledTimes(1);
  });
});
