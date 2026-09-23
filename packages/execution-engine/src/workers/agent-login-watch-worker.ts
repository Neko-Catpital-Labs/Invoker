import { spawn } from 'node:child_process';

import type { Logger } from '@invoker/contracts';
import { Channels, type MessageBus } from '@invoker/transport';

import { resolveClaudeWorkerConfigDir } from '../agents/claude-execution-agent.js';
import { buildRemoteAgentEnvExports } from '../remote-agent-env.js';
import { execRemoteCapture, shellPosixSingleQuote } from '../ssh-git-exec.js';
import { buildSshConnectionArgs, type SshTargetConnection } from '../ssh-transport-options.js';
import { recordWorkerDecisionRow, type WorkerDecisionStore } from '../worker-decision-ledger.js';
import type { WorkerRegistry } from '../worker-registry.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const AGENT_LOGIN_WATCH_WORKER_KIND = 'agent-login-watch';

export const DEFAULT_AGENT_LOGIN_WATCH_INTERVAL_MS = 60 * 60 * 1_000;
export const DEFAULT_AGENT_LOGIN_PROBE_TIMEOUT_MS = 120_000;
export const AGENT_LOGIN_PROBE_PROMPT = 'Reply with just the word ok';
export const DEFAULT_OWNER_HOST_NAME = 'owner';

export type WatchedAgentName = 'claude' | 'codex';

export const WATCHED_AGENT_NAMES: readonly WatchedAgentName[] = ['claude', 'codex'];

export type AgentLoginProbeStatus = 'ok' | 'login_failed' | 'unchecked';

export interface AgentLoginProbeObservation {
  exitCode?: number | null;
  output?: string;
  timedOut?: boolean;
  error?: string;
}

const LOGIN_FAILURE_SIGNATURES: readonly string[] = [
  'oauth session expired',
  'refresh token was revoked',
  'please run /login',
  'token_invalidated',
];

const TRANSPORT_FAILURE_SIGNATURES: readonly string[] = [
  'ssh: connect to host',
  'ssh_exchange_identification',
  'kex_exchange_identification',
  'permission denied (publickey',
  'host key verification failed',
  'connection timed out',
  'connection refused',
  'connection closed by remote host',
  'no route to host',
  'network is unreachable',
  'broken pipe',
  'operation timed out',
];

function containsSignature(haystack: string, signatures: readonly string[]): boolean {
  return signatures.some((signature) => haystack.includes(signature));
}

export function classifyLoginProbe(observation: AgentLoginProbeObservation): AgentLoginProbeStatus {
  if (observation.timedOut === true) return 'unchecked';
  if ((observation.error ?? '').trim().length > 0) return 'unchecked';

  const output = (observation.output ?? '').toLowerCase();
  if (containsSignature(output, TRANSPORT_FAILURE_SIGNATURES)) return 'unchecked';
  if (containsSignature(output, LOGIN_FAILURE_SIGNATURES)) return 'login_failed';
  if (observation.exitCode === 0) return 'ok';
  return 'unchecked';
}

export interface AgentLoginWatchRemoteTarget {
  readonly name: string;
  readonly connection: SshTargetConnection;
  readonly secretsFile?: string;
  readonly useApiKey?: boolean;
  readonly claudeConfigDir?: string;
}

export interface AgentLoginProbeRequest {
  readonly host: string;
  readonly agent: WatchedAgentName;
  readonly timeoutMs: number;
  readonly remote?: AgentLoginWatchRemoteTarget;
  readonly claudeConfigDir?: string;
  readonly signal?: AbortSignal;
}

export type AgentLoginProbeRunner = (
  request: AgentLoginProbeRequest,
) => Promise<AgentLoginProbeObservation>;

export interface AgentLoginAlertPayload {
  readonly host: string;
  readonly agent: WatchedAgentName;
}

export interface AgentLoginWatchWorkerConfig {
  intervalMs?: number;
  tickOnStart?: boolean;
  ownerHostName?: string;
  agents?: readonly WatchedAgentName[];
  remoteTargets?: readonly AgentLoginWatchRemoteTarget[];
  probeTimeoutMs?: number;
  claudeConfigDir?: string;
  runProbe?: AgentLoginProbeRunner;
  now?: () => number;
  onTick?: WorkerTick;
}

export interface AgentLoginWatchWorkerOptions extends AgentLoginWatchWorkerConfig {
  logger: Logger;
  store?: WorkerDecisionStore;
  messageBus?: MessageBus;
}

export function agentLoginAlertKey(host: string, agent: WatchedAgentName): string {
  return `agent-login:${host}:${agent}`;
}

export function agentLoginAlertMessage(host: string, agent: WatchedAgentName): string {
  const label = agent === 'claude' ? 'Claude' : 'Codex';
  return `${label} is not logged in on ${host}. Every ${label} task on that host will fail until someone signs it back in. Reply \`reauth\` in this thread to start the re-login.`;
}

function localProbeArgs(agent: WatchedAgentName): string[] {
  return agent === 'claude'
    ? ['-p', AGENT_LOGIN_PROBE_PROMPT]
    : ['exec', '--skip-git-repo-check', AGENT_LOGIN_PROBE_PROMPT];
}

function localProbeEnv(
  agent: WatchedAgentName,
  claudeConfigDir: string | undefined,
): NodeJS.ProcessEnv {
  if (agent !== 'claude') return { ...process.env };
  return { ...process.env, CLAUDE_CONFIG_DIR: claudeConfigDir ?? resolveClaudeWorkerConfigDir() };
}

function runLocalProbe(request: AgentLoginProbeRequest): Promise<AgentLoginProbeObservation> {
  return new Promise((resolve) => {
    let settled = false;
    let output = '';
    const finish = (observation: AgentLoginProbeObservation): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(observation);
    };

    const child = spawn(request.agent, localProbeArgs(request.agent), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: localProbeEnv(request.agent, request.claudeConfigDir),
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ output, timedOut: true });
    }, request.timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.on('error', (error: Error) => { finish({ output, error: error.message }); });
    child.on('close', (code) => { finish({ exitCode: code, output }); });
  });
}

const REMOTE_PROBE_EXIT_MARKER = 'INVOKER_AGENT_LOGIN_PROBE_EXIT';
const REMOTE_TIMEOUT_EXIT_CODE = 124;

export function buildRemoteProbeScript(
  agent: WatchedAgentName,
  timeoutMs: number,
  envExports: string,
  claudeConfigDir?: string,
): string {
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1_000));
  const command = agent === 'claude'
    ? `claude -p ${shellPosixSingleQuote(AGENT_LOGIN_PROBE_PROMPT)}`
    : `codex exec --skip-git-repo-check ${shellPosixSingleQuote(AGENT_LOGIN_PROBE_PROMPT)}`;
  const claudeConfigExport = agent === 'claude' && claudeConfigDir
    ? `export CLAUDE_CONFIG_DIR=${shellPosixSingleQuote(claudeConfigDir)}\n`
    : '';
  return `set -u
${envExports}${claudeConfigExport}probe_output=$(timeout ${timeoutSeconds} ${command} </dev/null 2>&1)
probe_status=$?
printf '%s\\n' "$probe_output"
printf '${REMOTE_PROBE_EXIT_MARKER}=%s\\n' "$probe_status"
exit 0
`;
}

export function parseRemoteProbeOutput(raw: string): AgentLoginProbeObservation {
  const lines = raw.split('\n');
  const markerIndex = lines.findLastIndex((line) => line.startsWith(`${REMOTE_PROBE_EXIT_MARKER}=`));
  if (markerIndex < 0) {
    return { output: raw, error: `probe output missing ${REMOTE_PROBE_EXIT_MARKER}` };
  }
  const exitCode = Number.parseInt(lines[markerIndex]!.slice(REMOTE_PROBE_EXIT_MARKER.length + 1), 10);
  const output = lines.slice(0, markerIndex).join('\n');
  if (!Number.isFinite(exitCode)) {
    return { output, error: `probe output has an unreadable ${REMOTE_PROBE_EXIT_MARKER}` };
  }
  if (exitCode === REMOTE_TIMEOUT_EXIT_CODE) return { output, timedOut: true };
  return { exitCode, output };
}

async function runRemoteProbe(
  request: AgentLoginProbeRequest,
  remote: AgentLoginWatchRemoteTarget,
): Promise<AgentLoginProbeObservation> {
  const script = buildRemoteProbeScript(
    request.agent,
    request.timeoutMs,
    buildRemoteAgentEnvExports(remote.secretsFile, remote.useApiKey ?? false),
    remote.claudeConfigDir,
  );
  try {
    const raw = await execRemoteCapture({
      sshArgs: buildSshConnectionArgs(remote.connection, { batchMode: true }),
      script,
      phase: `${AGENT_LOGIN_WATCH_WORKER_KIND}:${remote.name}:${request.agent}`,
    });
    return parseRemoteProbeOutput(raw);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function defaultRunProbe(request: AgentLoginProbeRequest): Promise<AgentLoginProbeObservation> {
  return request.remote ? runRemoteProbe(request, request.remote) : runLocalProbe(request);
}

function decisionStatus(status: AgentLoginProbeStatus): 'completed' | 'failed' | 'skipped' {
  if (status === 'ok') return 'completed';
  if (status === 'login_failed') return 'failed';
  return 'skipped';
}

function probeDetail(observation: AgentLoginProbeObservation): string {
  if (observation.error !== undefined) return observation.error;
  if (observation.timedOut === true) return 'probe timed out';
  return (observation.output ?? '').trim().slice(-500);
}

export function createAgentLoginWatchWorker(options: AgentLoginWatchWorkerOptions): WorkerRuntime {
  const ownerHostName = options.ownerHostName ?? DEFAULT_OWNER_HOST_NAME;
  const agents = options.agents ?? WATCHED_AGENT_NAMES;
  const remoteTargets = options.remoteTargets ?? [];
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_AGENT_LOGIN_PROBE_TIMEOUT_MS;
  const runProbe = options.runProbe ?? defaultRunProbe;
  const now = options.now ?? (() => Date.now());
  const openAlerts = new Set<string>();

  return createWorkerRuntime({
    kind: AGENT_LOGIN_WATCH_WORKER_KIND,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_AGENT_LOGIN_WATCH_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? true,
    onTick: async (ctx) => {
      ctx.signal?.throwIfAborted();
      await options.onTick?.(ctx);

      const hosts: Array<{ host: string; remote?: AgentLoginWatchRemoteTarget }> = [
        { host: ownerHostName },
        ...remoteTargets.map((remote) => ({ host: remote.name, remote })),
      ];

      for (const { host, remote } of hosts) {
        for (const agent of agents) {
          ctx.signal?.throwIfAborted();

          let observation: AgentLoginProbeObservation;
          try {
            observation = await runProbe({
              host,
              agent,
              timeoutMs: probeTimeoutMs,
              ...(remote ? { remote } : {}),
              ...(options.claudeConfigDir ? { claudeConfigDir: options.claudeConfigDir } : {}),
              ...(ctx.signal ? { signal: ctx.signal } : {}),
            });
          } catch (error) {
            observation = { error: error instanceof Error ? error.message : String(error) };
          }

          const status = classifyLoginProbe(observation);
          const alertKey = agentLoginAlertKey(host, agent);
          const detail = probeDetail(observation);
          const payload: AgentLoginAlertPayload = { host, agent };

          if (options.store) {
            recordWorkerDecisionRow(options.store, {
              workerKind: AGENT_LOGIN_WATCH_WORKER_KIND,
              actionType: 'login-probe',
              externalKey: alertKey,
              subjectType: 'agent-login',
              subjectId: `${host}:${agent}`,
              status: decisionStatus(status),
              summary: `${agent} login on ${host}: ${status}`,
              payload: { ...payload, probeStatus: status, detail, checkedAt: new Date(now()).toISOString() },
            });
          }

          if (status === 'unchecked') {
            options.logger.error(
              `[${AGENT_LOGIN_WATCH_WORKER_KIND}] ${agent} login on ${host} could not be checked: ${detail}`,
              { module: AGENT_LOGIN_WATCH_WORKER_KIND, host, agent, detail },
            );
            continue;
          }

          if (status === 'ok') {
            openAlerts.delete(alertKey);
            continue;
          }

          if (openAlerts.has(alertKey)) continue;
          openAlerts.add(alertKey);

          const message = agentLoginAlertMessage(host, agent);
          options.logger.error(`[${AGENT_LOGIN_WATCH_WORKER_KIND}] ${message}`, {
            module: AGENT_LOGIN_WATCH_WORKER_KIND,
            host,
            agent,
            detail,
          });
          options.messageBus?.publish(Channels.SURFACE_EVENT, {
            type: 'alert',
            alert: {
              severity: 'error',
              source: AGENT_LOGIN_WATCH_WORKER_KIND,
              subject: `${agent} login failed on ${host}`,
              message,
              alertKey,
              payload,
            },
          });
        }
      }
    },
  });
}

export function registerAgentLoginWatchWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: AGENT_LOGIN_WATCH_WORKER_KIND,
    note: 'Makes one real login probe per agent (claude, codex) on the owner host and every configured SSH remote target each tick, and publishes one lobby alert when a probe output matches a known login-failure message. Timeouts and SSH failures are recorded as unchecked and never alert.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime => {
      const config = deps.agentLoginWatch ?? {};
      return createAgentLoginWatchWorker({
        logger: deps.logger,
        store: deps.store,
        ...(deps.messageBus ? { messageBus: deps.messageBus } : {}),
        ...config,
      });
    },
  });
  return registry;
}
