import { spawn } from 'node:child_process';

import type { Logger } from '@invoker/contracts';
import { Channels, type MessageBus } from '@invoker/transport';

import { resolveClaudeWorkerConfigDir } from '../agents/claude-execution-agent.js';
import { buildRemoteAgentEnvExports } from '../remote-agent-env.js';
import { buildSshConnectionArgs, type SshTargetConnection } from '../ssh-transport-options.js';
import { recordWorkerDecisionRow, type WorkerDecisionStore } from '../worker-decision-ledger.js';
import type { WorkerRegistry } from '../worker-registry.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const AGENT_LOGIN_WATCH_WORKER_KIND = 'agent-login-watch';
export const DEFAULT_AGENT_LOGIN_WATCH_INTERVAL_MS = 3_600_000;
export const DEFAULT_AGENT_LOGIN_PROBE_TIMEOUT_MS = 120_000;
export const AGENT_LOGIN_PROBE_PROMPT = 'Reply with just the word ok';

export type AgentLoginAgent = 'claude' | 'codex';

export const AGENT_LOGIN_WATCH_AGENTS: ReadonlyArray<AgentLoginAgent> = ['claude', 'codex'];

const AGENT_LABEL: Record<AgentLoginAgent, string> = {
  claude: 'Claude',
  codex: 'Codex',
};

const LOGIN_FAILURE_SIGNATURES: ReadonlyArray<string> = [
  'failed to authenticate: oauth session expired and could not be refreshed',
  'your access token could not be refreshed because your refresh token was revoked',
  'please run /login',
  'token_invalidated',
];

export type AgentLoginProbeVerdict = 'ok' | 'login_failed' | 'unchecked';

export interface AgentLoginProbeOutcome {
  exitCode?: number | null;
  output?: string;
  timedOut?: boolean;
  transportError?: string;
}

export function classifyLoginProbe(outcome: AgentLoginProbeOutcome): AgentLoginProbeVerdict {
  if (outcome.timedOut === true) return 'unchecked';
  if ((outcome.transportError ?? '').trim() !== '') return 'unchecked';
  const output = (outcome.output ?? '').toLowerCase();
  if (LOGIN_FAILURE_SIGNATURES.some((signature) => output.includes(signature))) return 'login_failed';
  return outcome.exitCode === 0 ? 'ok' : 'unchecked';
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function buildAgentLoginProbeCommand(agent: AgentLoginAgent): string {
  if (agent === 'claude') return `claude -p ${shellQuote(AGENT_LOGIN_PROBE_PROMPT)}`;
  return `codex exec --skip-git-repo-check ${shellQuote(AGENT_LOGIN_PROBE_PROMPT)} </dev/null`;
}

export interface AgentLoginWatchRemoteTarget {
  readonly name: string;
  readonly connection: SshTargetConnection;
}

export interface AgentLoginProbeRequest {
  readonly host: string;
  readonly agent: AgentLoginAgent;
  readonly command: string;
  readonly timeoutMs: number;
  readonly connection?: SshTargetConnection;
  readonly env?: Readonly<Record<string, string>>;
  readonly remoteEnvExports?: string;
}

export type AgentLoginProbeRunner = (request: AgentLoginProbeRequest) => Promise<AgentLoginProbeOutcome>;

export interface AgentLoginProbePlanOptions {
  readonly ownerHostName: string;
  readonly remoteTargets: ReadonlyArray<AgentLoginWatchRemoteTarget>;
  readonly agents: ReadonlyArray<AgentLoginAgent>;
  readonly timeoutMs: number;
  readonly claudeConfigDir: string;
  readonly secretsFile?: string;
}

export function planAgentLoginProbes(options: AgentLoginProbePlanOptions): AgentLoginProbeRequest[] {
  const requests: AgentLoginProbeRequest[] = [];
  for (const agent of options.agents) {
    requests.push({
      host: options.ownerHostName,
      agent,
      command: buildAgentLoginProbeCommand(agent),
      timeoutMs: options.timeoutMs,
      ...(agent === 'claude' ? { env: { CLAUDE_CONFIG_DIR: options.claudeConfigDir } } : {}),
    });
  }
  const remoteEnvExports = options.remoteTargets.length > 0
    ? buildRemoteAgentEnvExports(options.secretsFile, false)
    : '';
  for (const target of options.remoteTargets) {
    for (const agent of options.agents) {
      requests.push({
        host: target.name,
        agent,
        command: buildAgentLoginProbeCommand(agent),
        timeoutMs: options.timeoutMs,
        connection: target.connection,
        remoteEnvExports,
      });
    }
  }
  return requests;
}

function runCapture(
  file: string,
  args: ReadonlyArray<string>,
  opts: { timeoutMs: number; env?: NodeJS.ProcessEnv; stdin?: string },
): Promise<AgentLoginProbeOutcome> {
  return new Promise((resolve) => {
    const child = spawn(file, [...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(opts.env ? { env: opts.env } : {}),
    });
    let output = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);

    const finish = (outcome: AgentLoginProbeOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.on('error', (error: Error) => { finish({ output, transportError: error.message }); });
    child.on('close', (code) => {
      finish(timedOut ? { exitCode: code, output, timedOut: true } : { exitCode: code, output });
    });

    child.stdin?.on('error', () => undefined);
    child.stdin?.end(opts.stdin ?? '');
  });
}

export function defaultRunAgentLoginProbe(request: AgentLoginProbeRequest): Promise<AgentLoginProbeOutcome> {
  if (request.connection) {
    const sshArgs = buildSshConnectionArgs(request.connection, { batchMode: true });
    const script = `${request.remoteEnvExports ?? ''}${request.command}\n`;
    return runCapture('ssh', [...sshArgs, 'bash', '-s'], { timeoutMs: request.timeoutMs, stdin: script });
  }
  return runCapture('bash', ['-c', request.command], {
    timeoutMs: request.timeoutMs,
    env: { ...process.env, ...(request.env ?? {}) },
  });
}

export interface AgentLoginAlertPayload {
  readonly host: string;
  readonly agent: AgentLoginAgent;
}

export function agentLoginAlertKey(host: string, agent: AgentLoginAgent): string {
  return `agent-login:${host}:${agent}`;
}

export function agentLoginAlertMessage(host: string, agent: AgentLoginAgent): string {
  const label = AGENT_LABEL[agent];
  return `The ${label} login on ${host} stopped working, so every ${label} task on that host will fail until it is signed in again. Reply \`reauth\` in this thread and I will walk through signing it back in.`;
}

export type AgentLoginWatchWorkerStore = WorkerDecisionStore;

export interface AgentLoginWatchWorkerConfig {
  enabled?: boolean;
  intervalMs?: number;
  tickOnStart?: boolean;
  ownerHostName?: string;
  remoteTargets?: ReadonlyArray<AgentLoginWatchRemoteTarget>;
  agents?: ReadonlyArray<AgentLoginAgent>;
  probeTimeoutMs?: number;
  claudeConfigDir?: string;
  secretsFile?: string;
  runProbe?: AgentLoginProbeRunner;
  now?: () => number;
  onTick?: WorkerTick;
}

export interface AgentLoginWatchWorkerOptions extends AgentLoginWatchWorkerConfig {
  logger: Logger;
  store: AgentLoginWatchWorkerStore;
  messageBus?: MessageBus;
}

const RESULT_STATUS: Record<AgentLoginProbeVerdict, 'completed' | 'failed' | 'skipped'> = {
  ok: 'completed',
  login_failed: 'failed',
  unchecked: 'skipped',
};

function resultSummary(host: string, agent: AgentLoginAgent, verdict: AgentLoginProbeVerdict): string {
  const label = AGENT_LABEL[agent];
  if (verdict === 'ok') return `${label} login on ${host} works`;
  if (verdict === 'login_failed') return `${label} login on ${host} is dead`;
  return `${label} login on ${host} could not be checked`;
}

function outputTail(output: string | undefined, limit = 600): string {
  const text = (output ?? '').trim();
  return text.length <= limit ? text : text.slice(-limit);
}

export function createAgentLoginWatchWorker(options: AgentLoginWatchWorkerOptions): WorkerRuntime {
  const enabled = options.enabled ?? false;
  const runProbe = options.runProbe ?? defaultRunAgentLoginProbe;
  const now = options.now ?? (() => Date.now());

  const planOptions = (): AgentLoginProbePlanOptions => ({
    ownerHostName: options.ownerHostName ?? 'owner',
    remoteTargets: options.remoteTargets ?? [],
    agents: options.agents ?? AGENT_LOGIN_WATCH_AGENTS,
    timeoutMs: options.probeTimeoutMs ?? DEFAULT_AGENT_LOGIN_PROBE_TIMEOUT_MS,
    claudeConfigDir: options.claudeConfigDir ?? resolveClaudeWorkerConfigDir(),
    ...(options.secretsFile !== undefined ? { secretsFile: options.secretsFile } : {}),
  });

  const publishAlert = (host: string, agent: AgentLoginAgent): void => {
    options.messageBus?.publish(Channels.SURFACE_EVENT, {
      type: 'alert',
      alert: {
        severity: 'critical',
        source: AGENT_LOGIN_WATCH_WORKER_KIND,
        subject: `${AGENT_LABEL[agent]} login failed on ${host}`,
        message: agentLoginAlertMessage(host, agent),
        alertKey: agentLoginAlertKey(host, agent),
        payload: { host, agent } satisfies AgentLoginAlertPayload,
      },
    });
  };

  return createWorkerRuntime({
    kind: AGENT_LOGIN_WATCH_WORKER_KIND,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_AGENT_LOGIN_WATCH_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? true,
    onTick: async (ctx) => {
      ctx.signal?.throwIfAborted();
      await options.onTick?.(ctx);
      ctx.signal?.throwIfAborted();
      if (!enabled) {
        options.logger.debug('[agent-login-watch] disabled by config; no login probes run this tick', {
          module: AGENT_LOGIN_WATCH_WORKER_KIND,
          enabled,
        });
        return;
      }

      for (const request of planAgentLoginProbes(planOptions())) {
        if (ctx.signal?.aborted) return;

        let outcome: AgentLoginProbeOutcome;
        try {
          outcome = await runProbe(request);
        } catch (error) {
          outcome = { transportError: error instanceof Error ? error.message : String(error) };
        }

        const verdict = classifyLoginProbe(outcome);
        const { host, agent } = request;
        const subjectId = `${host}:${agent}`;
        const nowIso = new Date(now()).toISOString();

        recordWorkerDecisionRow(options.store, {
          workerKind: AGENT_LOGIN_WATCH_WORKER_KIND,
          actionType: 'login-probe',
          externalKey: `login-probe:${subjectId}`,
          subjectType: 'agent-login',
          subjectId,
          status: RESULT_STATUS[verdict],
          summary: resultSummary(host, agent, verdict),
          ...(verdict === 'unchecked' ? { reason: 'unchecked' } : {}),
          incrementAttempt: true,
          now: nowIso,
          payload: {
            host,
            agent,
            verdict,
            exitCode: outcome.exitCode ?? null,
            timedOut: outcome.timedOut === true,
            ...(outcome.transportError !== undefined ? { transportError: outcome.transportError } : {}),
            outputTail: outputTail(outcome.output),
          },
        });

        if (verdict === 'unchecked') {
          options.logger.error(
            `[agent-login-watch] could not check the ${AGENT_LABEL[agent]} login on ${host}: ${outcome.transportError ?? (outcome.timedOut === true ? 'probe timed out' : `probe exited ${outcome.exitCode ?? 'null'}`)}`,
            {
              module: AGENT_LOGIN_WATCH_WORKER_KIND,
              host,
              agent,
              exitCode: outcome.exitCode ?? null,
              timedOut: outcome.timedOut === true,
              ...(outcome.transportError !== undefined ? { transportError: outcome.transportError } : {}),
            },
          );
          continue;
        }

        const episodeKey = `alert-send:${agentLoginAlertKey(host, agent)}`;
        const episode = options.store.getWorkerAction?.(AGENT_LOGIN_WATCH_WORKER_KIND, episodeKey);
        const episodeOpen = episode !== undefined && episode.status !== 'completed';

        if (verdict === 'login_failed') {
          if (episodeOpen) {
            options.logger.info(
              `[agent-login-watch] ${AGENT_LABEL[agent]} login on ${host} is still dead; alert already open`,
              { module: AGENT_LOGIN_WATCH_WORKER_KIND, host, agent, alertKey: agentLoginAlertKey(host, agent) },
            );
            continue;
          }
          recordWorkerDecisionRow(options.store, {
            workerKind: AGENT_LOGIN_WATCH_WORKER_KIND,
            actionType: 'alert-send',
            externalKey: episodeKey,
            subjectType: 'agent-login',
            subjectId,
            status: 'failed',
            summary: agentLoginAlertMessage(host, agent),
            incrementAttempt: true,
            now: nowIso,
            payload: { host, agent, alertKey: agentLoginAlertKey(host, agent) },
          });
          publishAlert(host, agent);
          options.logger.error(
            `[agent-login-watch] ${AGENT_LABEL[agent]} login on ${host} is dead; alerted the lobby`,
            { module: AGENT_LOGIN_WATCH_WORKER_KIND, host, agent },
          );
          continue;
        }

        if (episodeOpen) {
          recordWorkerDecisionRow(options.store, {
            workerKind: AGENT_LOGIN_WATCH_WORKER_KIND,
            actionType: 'alert-send',
            externalKey: episodeKey,
            subjectType: 'agent-login',
            subjectId,
            status: 'completed',
            summary: `${AGENT_LABEL[agent]} login on ${host} works again`,
            now: nowIso,
            payload: { host, agent, alertKey: agentLoginAlertKey(host, agent), recovered: true },
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
    note: 'Makes one real Claude and Codex call per host (owner plus every SSH remote target) each tick and posts one lobby alert when a login stops working. A probe that times out or cannot reach its host is recorded as unchecked and never alerts. Off until its config sets enabled.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime => {
      const config = deps.agentLoginWatch ?? {};
      return createAgentLoginWatchWorker({
        ...config,
        logger: deps.logger,
        store: deps.store,
        ...(deps.messageBus !== undefined ? { messageBus: deps.messageBus } : {}),
      });
    },
  });
  return registry;
}
