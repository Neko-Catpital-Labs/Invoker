import { describe, expect, it, vi } from 'vitest';

import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import { Channels } from '@invoker/transport';

import { createWorkerRegistry } from '../worker-registry.js';
import { registerBuiltinWorkers } from '../builtin-workers.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import {
  AGENT_LOGIN_WATCH_WORKER_KIND,
  buildRemoteProbeScript,
  classifyLoginProbe,
  createAgentLoginWatchWorker,
  parseRemoteProbeOutput,
  registerAgentLoginWatchWorker,
  type AgentLoginProbeObservation,
  type AgentLoginProbeRequest,
  type WatchedAgentName,
} from '../workers/agent-login-watch-worker.js';

const CLAUDE_EXPIRED_TEXT = 'Failed to authenticate: OAuth session expired and could not be refreshed';
const CODEX_REVOKED_TEXT =
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
  const upsertWorkerAction = vi.fn((write: WorkerActionWrite): WorkerActionRecord => {
    const record = {
      ...write,
      attemptCount: write.attemptCount ?? 0,
      createdAt: '2026-09-23T00:00:00.000Z',
      updatedAt: write.updatedAt ?? '2026-09-23T00:00:00.000Z',
    } as WorkerActionRecord;
    rows.set(`${write.workerKind}:${write.externalKey}`, record);
    return record;
  });
  return {
    rows,
    upsertWorkerAction,
    store: {
      getWorkerAction: (workerKind: string, externalKey: string) => rows.get(`${workerKind}:${externalKey}`),
      upsertWorkerAction,
    },
  };
}

const REMOTE_TARGET = {
  name: 'pool-1',
  connection: { sshKeyPath: '/tmp/key', user: 'root', host: '10.0.0.5' },
};

function makeWorker(
  runProbe: (request: AgentLoginProbeRequest) => Promise<AgentLoginProbeObservation>,
  overrides: {
    publish?: ReturnType<typeof vi.fn>;
    logger?: ReturnType<typeof makeLogger>;
    store?: ReturnType<typeof makeStore>['store'];
    remoteTargets?: Array<typeof REMOTE_TARGET>;
  } = {},
) {
  const publish = overrides.publish ?? vi.fn();
  const logger = overrides.logger ?? makeLogger();
  const worker = createAgentLoginWatchWorker({
    logger,
    ...(overrides.store ? { store: overrides.store } : {}),
    messageBus: { publish } as any,
    ownerHostName: 'owner',
    remoteTargets: overrides.remoteTargets ?? [],
    runProbe,
    tickOnStart: false,
    intervalMs: 0,
  });
  return { worker, publish, logger };
}

function alertsFrom(publish: ReturnType<typeof vi.fn>) {
  return publish.mock.calls
    .filter(([channel]) => channel === Channels.SURFACE_EVENT)
    .map(([, event]) => (event as { alert: Record<string, unknown> }).alert);
}

describe('classifyLoginProbe', () => {
  it('returns ok for a clean exit', () => {
    expect(classifyLoginProbe({ exitCode: 0, output: 'ok\n' })).toBe('ok');
  });

  it('returns login_failed for the observed Claude OAuth-expired text', () => {
    expect(classifyLoginProbe({ exitCode: 1, output: CLAUDE_EXPIRED_TEXT })).toBe('login_failed');
  });

  it('returns login_failed for the observed Codex revoked-refresh-token text', () => {
    expect(classifyLoginProbe({ exitCode: 1, output: CODEX_REVOKED_TEXT })).toBe('login_failed');
  });

  it('returns login_failed for the `Please run /login` and `token_invalidated` signatures', () => {
    expect(classifyLoginProbe({ exitCode: 1, output: 'Invalid API key · Please run /login' })).toBe('login_failed');
    expect(classifyLoginProbe({ exitCode: 1, output: '{"error":"token_invalidated"}' })).toBe('login_failed');
  });

  it('never returns login_failed for a timeout', () => {
    expect(classifyLoginProbe({ timedOut: true, output: '' })).toBe('unchecked');
    expect(classifyLoginProbe({ timedOut: true, exitCode: 124, output: CODEX_REVOKED_TEXT })).toBe('unchecked');
  });

  it('never returns login_failed for an SSH transport failure', () => {
    const sshErrors = [
      'ssh: connect to host 10.0.0.5 port 22: Connection timed out',
      'ssh: connect to host 10.0.0.5 port 22: Connection refused',
      'Permission denied (publickey).',
      'Host key verification failed.',
      'kex_exchange_identification: Connection closed by remote host',
    ];
    for (const output of sshErrors) {
      expect(classifyLoginProbe({ exitCode: 255, output })).toBe('unchecked');
    }
  });

  it('returns unchecked for a spawn error even when the output looks like a login failure', () => {
    expect(classifyLoginProbe({ error: 'spawn claude ENOENT', output: CLAUDE_EXPIRED_TEXT })).toBe('unchecked');
  });

  it('returns unchecked for an unrecognized non-zero exit', () => {
    expect(classifyLoginProbe({ exitCode: 1, output: 'model overloaded, try again' })).toBe('unchecked');
  });
});

describe('parseRemoteProbeOutput', () => {
  it('splits the probe output from its exit marker', () => {
    expect(parseRemoteProbeOutput('ok\nINVOKER_AGENT_LOGIN_PROBE_EXIT=0\n')).toEqual({ exitCode: 0, output: 'ok' });
  });

  it('reports a remote timeout exit as timed out, not as a login failure', () => {
    const parsed = parseRemoteProbeOutput(`${CODEX_REVOKED_TEXT}\nINVOKER_AGENT_LOGIN_PROBE_EXIT=124\n`);
    expect(parsed.timedOut).toBe(true);
    expect(classifyLoginProbe(parsed)).toBe('unchecked');
  });

  it('reports a missing exit marker as an error so the probe stays unchecked', () => {
    const parsed = parseRemoteProbeOutput('ssh: connect to host 10.0.0.5 port 22: Connection refused\n');
    expect(parsed.error).toContain('INVOKER_AGENT_LOGIN_PROBE_EXIT');
    expect(classifyLoginProbe(parsed)).toBe('unchecked');
  });
});

describe('buildRemoteProbeScript', () => {
  it('runs the Claude probe under a bounded timeout with stdin closed', () => {
    const script = buildRemoteProbeScript('claude', 120_000, '');
    expect(script).toContain("timeout 120 claude -p 'Reply with just the word ok' </dev/null 2>&1");
    expect(script).toContain('INVOKER_AGENT_LOGIN_PROBE_EXIT=%s');
  });

  it('runs the Codex probe with --skip-git-repo-check and the remote agent env exports', () => {
    const script = buildRemoteProbeScript('codex', 60_000, "export CLAUDE_CODE_OAUTH_TOKEN='tok'\n");
    expect(script).toContain("export CLAUDE_CODE_OAUTH_TOKEN='tok'");
    expect(script).toContain("timeout 60 codex exec --skip-git-repo-check 'Reply with just the word ok' </dev/null 2>&1");
  });

  it('never invokes a login subcommand', () => {
    for (const agent of ['claude', 'codex'] as WatchedAgentName[]) {
      const script = buildRemoteProbeScript(agent, 120_000, '');
      expect(script).not.toContain('login');
      expect(script).not.toContain('setup-token');
    }
  });
});

describe('createAgentLoginWatchWorker', () => {
  it('probes every agent on the owner and each remote target once per tick', async () => {
    const seen: Array<string> = [];
    const runProbe = vi.fn(async (request: AgentLoginProbeRequest) => {
      seen.push(`${request.host}:${request.agent}`);
      return { exitCode: 0, output: 'ok' };
    });
    const { worker } = makeWorker(runProbe, { remoteTargets: [REMOTE_TARGET] });

    await worker.tick('manual');

    expect(seen).toEqual(['owner:claude', 'owner:codex', 'pool-1:claude', 'pool-1:codex']);
  });

  it('publishes no alert when every login is healthy', async () => {
    const { worker, publish } = makeWorker(async () => ({ exitCode: 0, output: 'ok' }), {
      remoteTargets: [REMOTE_TARGET],
    });

    await worker.tick('manual');

    expect(alertsFrom(publish)).toEqual([]);
  });

  it('publishes one alert with a typed payload when the Codex token is revoked', async () => {
    const { store, rows } = makeStore();
    const { worker, publish } = makeWorker(
      async (request) => (request.agent === 'codex'
        ? { exitCode: 1, output: CODEX_REVOKED_TEXT }
        : { exitCode: 0, output: 'ok' }),
      { store },
    );

    await worker.tick('manual');

    const alerts = alertsFrom(publish);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: 'error',
      source: AGENT_LOGIN_WATCH_WORKER_KIND,
      alertKey: 'agent-login:owner:codex',
      payload: { host: 'owner', agent: 'codex' },
    });
    expect(alerts[0]?.message).toContain('owner');
    expect(alerts[0]?.message).toContain('reauth');

    const row = rows.get(`${AGENT_LOGIN_WATCH_WORKER_KIND}:agent-login:owner:codex`);
    expect(row).toMatchObject({
      actionType: 'login-probe',
      subjectType: 'agent-login',
      subjectId: 'owner:codex',
      status: 'failed',
    });
    expect(rows.get(`${AGENT_LOGIN_WATCH_WORKER_KIND}:agent-login:owner:claude`)).toMatchObject({
      status: 'completed',
    });
  });

  it('does not publish a duplicate alert on a second failing tick', async () => {
    const { worker, publish } = makeWorker(async (request) => (request.agent === 'claude'
      ? { exitCode: 1, output: CLAUDE_EXPIRED_TEXT }
      : { exitCode: 0, output: 'ok' }));

    await worker.tick('manual');
    await worker.tick('manual');

    expect(alertsFrom(publish)).toHaveLength(1);
  });

  it('alerts again after the login recovers and then fails a second time', async () => {
    const outputs: AgentLoginProbeObservation[] = [
      { exitCode: 1, output: CLAUDE_EXPIRED_TEXT },
      { exitCode: 0, output: 'ok' },
      { exitCode: 1, output: CLAUDE_EXPIRED_TEXT },
    ];
    let tick = 0;
    const { store, rows } = makeStore();
    const { worker, publish } = makeWorker(
      async (request) => (request.agent === 'claude' ? outputs[tick]! : { exitCode: 0, output: 'ok' }),
      { store },
    );

    for (; tick < outputs.length; tick += 1) {
      await worker.tick('manual');
    }

    expect(alertsFrom(publish)).toHaveLength(2);
    expect(rows.get(`${AGENT_LOGIN_WATCH_WORKER_KIND}:agent-login:owner:claude`)).toMatchObject({
      status: 'failed',
    });
  });

  it('records an SSH failure as unchecked, logs it, and raises no alert', async () => {
    const { store, rows } = makeStore();
    const logger = makeLogger();
    const { worker, publish } = makeWorker(
      async (request) => (request.host === 'pool-1'
        ? { exitCode: 255, output: 'ssh: connect to host 10.0.0.5 port 22: Connection refused' }
        : { exitCode: 0, output: 'ok' }),
      { store, logger, remoteTargets: [REMOTE_TARGET] },
    );

    await worker.tick('manual');

    expect(alertsFrom(publish)).toEqual([]);
    expect(rows.get(`${AGENT_LOGIN_WATCH_WORKER_KIND}:agent-login:pool-1:claude`)).toMatchObject({
      status: 'skipped',
      subjectId: 'pool-1:claude',
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('could not be checked'),
      expect.objectContaining({ host: 'pool-1' }),
    );
  });

  it('records a probe timeout as unchecked and raises no alert', async () => {
    const { store, rows } = makeStore();
    const { worker, publish } = makeWorker(async () => ({ timedOut: true, output: '' }), { store });

    await worker.tick('manual');

    expect(alertsFrom(publish)).toEqual([]);
    expect(rows.get(`${AGENT_LOGIN_WATCH_WORKER_KIND}:agent-login:owner:claude`)).toMatchObject({
      status: 'skipped',
    });
  });

  it('records a thrown probe as unchecked instead of crashing the tick', async () => {
    const { store, rows } = makeStore();
    const logger = makeLogger();
    const { worker, publish } = makeWorker(
      async (request) => {
        if (request.agent === 'claude') throw new Error('ssh spawn failed');
        return { exitCode: 0, output: 'ok' };
      },
      { store, logger },
    );

    await worker.tick('manual');

    expect(alertsFrom(publish)).toEqual([]);
    expect(rows.get(`${AGENT_LOGIN_WATCH_WORKER_KIND}:agent-login:owner:claude`)).toMatchObject({
      status: 'skipped',
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('ssh spawn failed'),
      expect.objectContaining({ agent: 'claude' }),
    );
  });

  it('keeps an open alert episode open while the probe is unchecked', async () => {
    const outputs: AgentLoginProbeObservation[] = [
      { exitCode: 1, output: CLAUDE_EXPIRED_TEXT },
      { timedOut: true, output: '' },
      { exitCode: 1, output: CLAUDE_EXPIRED_TEXT },
    ];
    let tick = 0;
    const { worker, publish } = makeWorker(
      async (request) => (request.agent === 'claude' ? outputs[tick]! : { exitCode: 0, output: 'ok' }),
    );

    for (; tick < outputs.length; tick += 1) {
      await worker.tick('manual');
    }

    expect(alertsFrom(publish)).toHaveLength(1);
  });
});

describe('registerAgentLoginWatchWorker', () => {
  it('registers the worker kind and builds a stopped runtime', () => {
    const registry = registerAgentLoginWatchWorker(createWorkerRegistry<WorkerRuntimeDependencies>());
    const definition = registry.get(AGENT_LOGIN_WATCH_WORKER_KIND);
    expect(definition?.note.length).toBeGreaterThan(0);

    const runtime = definition!.factory({
      store: {} as never,
      submitter: {} as never,
      logger: makeLogger(),
      agentLoginWatch: { tickOnStart: false, intervalMs: 0 },
    } as WorkerRuntimeDependencies);

    expect(runtime.identity.kind).toBe(AGENT_LOGIN_WATCH_WORKER_KIND);
    expect(runtime.isRunning()).toBe(false);
  });

  it('is part of the built-in worker registry', () => {
    const registry = registerBuiltinWorkers(createWorkerRegistry<WorkerRuntimeDependencies>());
    expect(registry.get(AGENT_LOGIN_WATCH_WORKER_KIND)).toBeDefined();
  });
});
