import { describe, expect, it, vi } from 'vitest';

import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import { Channels } from '@invoker/transport';

import {
  AGENT_LOGIN_WATCH_WORKER_KIND,
  agentLoginAlertKey,
  buildAgentLoginProbeCommand,
  classifyLoginProbe,
  createAgentLoginWatchWorker,
  planAgentLoginProbes,
  type AgentLoginProbeOutcome,
  type AgentLoginProbeRequest,
} from '../workers/agent-login-watch-worker.js';
import { registerBuiltinWorkers } from '../builtin-workers.js';
import { createWorkerRegistry } from '../worker-registry.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';

const CLAUDE_EXPIRED = 'Failed to authenticate: OAuth session expired and could not be refreshed';
const CODEX_REVOKED =
  'Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.';

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(function (this: unknown) { return this; }),
  } as any;
}

function makeStore() {
  const rows = new Map<string, WorkerActionRecord>();
  return {
    rows,
    getWorkerAction(workerKind: string, externalKey: string): WorkerActionRecord | undefined {
      return rows.get(`${workerKind}:${externalKey}`);
    },
    upsertWorkerAction(action: WorkerActionWrite): WorkerActionRecord {
      const record = { ...action } as WorkerActionRecord;
      rows.set(`${action.workerKind}:${action.externalKey}`, record);
      return record;
    },
  };
}

function makeMessageBus() {
  const published: Array<{ channel: string; message: any }> = [];
  return {
    published,
    publish: vi.fn((channel: string, message: unknown) => {
      published.push({ channel, message });
    }),
  } as any;
}

const REMOTE_TARGETS = [
  { name: 'do1', connection: { sshKeyPath: '/keys/do1', user: 'invoker', host: '10.0.0.1' } },
];

interface ProbeScript {
  [hostAgent: string]: AgentLoginProbeOutcome;
}

function makeWorker(opts: {
  scripts: ProbeScript[];
  store?: ReturnType<typeof makeStore>;
  messageBus?: ReturnType<typeof makeMessageBus>;
  logger?: ReturnType<typeof makeLogger>;
}) {
  const store = opts.store ?? makeStore();
  const messageBus = opts.messageBus ?? makeMessageBus();
  const logger = opts.logger ?? makeLogger();
  const seen: AgentLoginProbeRequest[] = [];
  let tickIndex = -1;

  const worker = createAgentLoginWatchWorker({
    logger,
    store,
    messageBus,
    enabled: true,
    tickOnStart: false,
    ownerHostName: 'owner',
    remoteTargets: REMOTE_TARGETS,
    now: () => new Date('2026-09-23T00:00:00.000Z').getTime(),
    onTick: () => { tickIndex += 1; },
    runProbe: async (request) => {
      seen.push(request);
      const script = opts.scripts[Math.min(tickIndex, opts.scripts.length - 1)] ?? {};
      return script[`${request.host}:${request.agent}`] ?? { exitCode: 0, output: 'ok' };
    },
  });

  return { worker, store, messageBus, logger, seen };
}

function alerts(messageBus: ReturnType<typeof makeMessageBus>) {
  return messageBus.published
    .filter((entry) => entry.channel === Channels.SURFACE_EVENT && entry.message?.type === 'alert')
    .map((entry) => entry.message.alert);
}

describe('classifyLoginProbe', () => {
  it('returns ok for a clean exit', () => {
    expect(classifyLoginProbe({ exitCode: 0, output: 'ok\n' })).toBe('ok');
  });

  it('returns login_failed for the observed Claude expiry text', () => {
    expect(classifyLoginProbe({ exitCode: 1, output: CLAUDE_EXPIRED })).toBe('login_failed');
  });

  it('returns login_failed for the observed Codex revoked text', () => {
    expect(classifyLoginProbe({ exitCode: 1, output: CODEX_REVOKED })).toBe('login_failed');
  });

  it('returns login_failed for the /login prompt and token_invalidated', () => {
    expect(classifyLoginProbe({ exitCode: 1, output: 'Invalid API key. Please run /login' })).toBe('login_failed');
    expect(classifyLoginProbe({ exitCode: 1, output: '{"error":"token_invalidated"}' })).toBe('login_failed');
  });

  it('never returns login_failed for a timeout, even when the output matches a signature', () => {
    expect(classifyLoginProbe({ exitCode: null, output: '', timedOut: true })).toBe('unchecked');
    expect(classifyLoginProbe({ exitCode: null, output: CODEX_REVOKED, timedOut: true })).toBe('unchecked');
  });

  it('never returns login_failed for an SSH transport error', () => {
    expect(classifyLoginProbe({ exitCode: 255, output: 'ssh: connect to host 10.0.0.1 port 22: Connection refused' }))
      .toBe('unchecked');
    expect(classifyLoginProbe({ output: CLAUDE_EXPIRED, transportError: 'spawn ssh ENOENT' })).toBe('unchecked');
  });

  it('returns unchecked for any other non-zero exit', () => {
    expect(classifyLoginProbe({ exitCode: 127, output: 'claude: command not found' })).toBe('unchecked');
    expect(classifyLoginProbe({})).toBe('unchecked');
  });
});

describe('planAgentLoginProbes', () => {
  it('plans one probe per agent per host', () => {
    const requests = planAgentLoginProbes({
      ownerHostName: 'owner',
      remoteTargets: REMOTE_TARGETS,
      agents: ['claude', 'codex'],
      timeoutMs: 120_000,
      claudeConfigDir: '/home/invoker/.invoker/claude-worker',
    });

    expect(requests.map((r) => `${r.host}:${r.agent}`)).toEqual([
      'owner:claude',
      'owner:codex',
      'do1:claude',
      'do1:codex',
    ]);
    expect(requests[0]?.env).toEqual({ CLAUDE_CONFIG_DIR: '/home/invoker/.invoker/claude-worker' });
    expect(requests[0]?.connection).toBeUndefined();
    expect(requests[2]?.connection).toEqual(REMOTE_TARGETS[0]?.connection);
  });

  it('uses the documented probe commands', () => {
    expect(buildAgentLoginProbeCommand('claude')).toBe("claude -p 'Reply with just the word ok'");
    expect(buildAgentLoginProbeCommand('codex'))
      .toBe("codex exec --skip-git-repo-check 'Reply with just the word ok' </dev/null");
  });
});

describe('createAgentLoginWatchWorker', () => {
  it('probes every agent on every host and publishes no alert when all logins work', async () => {
    const { worker, messageBus, seen, store } = makeWorker({ scripts: [{}] });

    await worker.tick('manual');

    expect(seen.map((r) => `${r.host}:${r.agent}`)).toEqual([
      'owner:claude',
      'owner:codex',
      'do1:claude',
      'do1:codex',
    ]);
    expect(alerts(messageBus)).toEqual([]);
    expect(store.rows.get(`${AGENT_LOGIN_WATCH_WORKER_KIND}:login-probe:do1:codex`)?.status).toBe('completed');
  });

  it('publishes one alert with a typed payload when Codex reports a revoked token', async () => {
    const { worker, messageBus, store } = makeWorker({
      scripts: [{ 'do1:codex': { exitCode: 1, output: CODEX_REVOKED } }],
    });

    await worker.tick('manual');

    const published = alerts(messageBus);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      severity: 'critical',
      source: AGENT_LOGIN_WATCH_WORKER_KIND,
      alertKey: 'agent-login:do1:codex',
      payload: { host: 'do1', agent: 'codex' },
    });
    expect(published[0].message).toContain('do1');
    expect(published[0].message).toContain('reauth');
    expect(store.rows.get(`${AGENT_LOGIN_WATCH_WORKER_KIND}:login-probe:do1:codex`)?.status).toBe('failed');
  });

  it('does not alert twice while the same login stays dead', async () => {
    const failing = { 'do1:codex': { exitCode: 1, output: CODEX_REVOKED } };
    const { worker, messageBus } = makeWorker({ scripts: [failing, failing] });

    await worker.tick('manual');
    await worker.tick('manual');

    expect(alerts(messageBus)).toHaveLength(1);
  });

  it('alerts again after the login recovers and then fails once more', async () => {
    const failing = { 'do1:codex': { exitCode: 1, output: CODEX_REVOKED } };
    const { worker, messageBus, store } = makeWorker({ scripts: [failing, {}, failing] });

    await worker.tick('manual');
    await worker.tick('manual');
    expect(store.rows.get(`${AGENT_LOGIN_WATCH_WORKER_KIND}:alert-send:agent-login:do1:codex`)?.status)
      .toBe('completed');

    await worker.tick('manual');

    const published = alerts(messageBus);
    expect(published).toHaveLength(2);
    expect(published.every((alert) => alert.alertKey === agentLoginAlertKey('do1', 'codex'))).toBe(true);
  });

  it('records an SSH failure or a timeout as unchecked, logs it, and never alerts', async () => {
    const { worker, messageBus, store, logger } = makeWorker({
      scripts: [
        {
          'do1:claude': { exitCode: 255, output: 'ssh: connect to host 10.0.0.1 port 22: Connection refused' },
          'do1:codex': { exitCode: null, output: '', timedOut: true },
        },
      ],
    });

    await worker.tick('manual');

    expect(alerts(messageBus)).toEqual([]);
    expect(store.rows.get(`${AGENT_LOGIN_WATCH_WORKER_KIND}:login-probe:do1:claude`)?.status).toBe('skipped');
    expect(store.rows.get(`${AGENT_LOGIN_WATCH_WORKER_KIND}:login-probe:do1:codex`)?.status).toBe('skipped');
    expect(store.rows.get(`${AGENT_LOGIN_WATCH_WORKER_KIND}:alert-send:agent-login:do1:claude`)).toBeUndefined();
    const errorLogs = logger.error.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(errorLogs.some((line) => line.includes('could not check the Claude login on do1'))).toBe(true);
    expect(errorLogs.some((line) => line.includes('could not check the Codex login on do1'))).toBe(true);
  });

  it('records a thrown probe as unchecked and never alerts', async () => {
    const store = makeStore();
    const messageBus = makeMessageBus();
    const logger = makeLogger();
    const worker = createAgentLoginWatchWorker({
      logger,
      store,
      messageBus,
      enabled: true,
      tickOnStart: false,
      ownerHostName: 'owner',
      remoteTargets: [],
      runProbe: async () => { throw new Error('ssh exited with code 255'); },
    });

    await worker.tick('manual');

    expect(alerts(messageBus)).toEqual([]);
    expect(store.rows.get(`${AGENT_LOGIN_WATCH_WORKER_KIND}:login-probe:owner:claude`)?.status).toBe('skipped');
  });

  it('runs no probes while disabled', async () => {
    const store = makeStore();
    const messageBus = makeMessageBus();
    const runProbe = vi.fn(async () => ({ exitCode: 0, output: 'ok' }));
    const worker = createAgentLoginWatchWorker({
      logger: makeLogger(),
      store,
      messageBus,
      tickOnStart: false,
      runProbe,
    });

    await worker.tick('manual');

    expect(runProbe).not.toHaveBeenCalled();
    expect(store.rows.size).toBe(0);
  });
});

describe('registerAgentLoginWatchWorker', () => {
  it('registers the worker with the built-in registry', () => {
    const registry = registerBuiltinWorkers(createWorkerRegistry<WorkerRuntimeDependencies>());
    const definition = registry.get(AGENT_LOGIN_WATCH_WORKER_KIND);

    expect(definition?.kind).toBe(AGENT_LOGIN_WATCH_WORKER_KIND);

    const runtime = definition?.factory({
      logger: makeLogger(),
      store: makeStore(),
      messageBus: makeMessageBus(),
    } as unknown as WorkerRuntimeDependencies);

    expect(runtime?.identity.kind).toBe(AGENT_LOGIN_WATCH_WORKER_KIND);
  });
});
