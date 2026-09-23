import { randomUUID } from 'node:crypto';
import {
  spawn as nodeSpawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { createRequire } from 'node:module';
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { Logger } from '@invoker/contracts';
import {
  buildDistributeCredentialsScript,
  buildSshConnectionArgs,
  execRemoteCapture,
  recordWorkerDecisionRow,
  resolveCodexAuthPath,
  type SshTargetConnection,
  type WorkerDecisionStore,
} from '@invoker/execution-engine';

import type { PtyLike, PtySpawnFn } from './embedded-terminal-manager.js';

export const AGENT_LOGIN_SESSION_WORKER_KIND = 'agent-login-session';
export const DEFAULT_AGENT_LOGIN_SESSION_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_AGENT_LOGIN_PROBE_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 10_000;
const AGENT_LOGIN_PROBE_PROMPT = 'Reply with just the word ok';

export type AgentLoginAgent = 'claude' | 'codex';

export type AgentLoginSessionStatus =
  | 'starting'
  | 'awaiting_user'
  | 'awaiting_code'
  | 'verifying'
  | 'installed'
  | 'failed';

export interface AgentLoginSessionSnapshot {
  readonly sessionId: string;
  readonly agent: AgentLoginAgent;
  readonly status: AgentLoginSessionStatus;
  readonly url?: string;
  readonly code?: string;
  readonly error?: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface AgentLoginRemoteTarget {
  readonly name: string;
  readonly connection: SshTargetConnection;
}

export type SpawnCodexLoginFn = (opts: {
  codexHome: string;
  env: NodeJS.ProcessEnv;
}) => ChildProcessWithoutNullStreams;

export type SpawnClaudeSetupTokenFn = (opts: {
  claudeConfigDir: string;
  env: NodeJS.ProcessEnv;
}) => PtyLike;

export interface ShellCaptureRequest {
  readonly command: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
}

export interface ShellCaptureOutcome {
  readonly exitCode: number | null;
  readonly output: string;
}

export type RunShellCaptureFn = (request: ShellCaptureRequest) => Promise<ShellCaptureOutcome>;

export interface StartAgentLoginOptions {
  store?: WorkerDecisionStore;
  remoteTargets?: readonly AgentLoginRemoteTarget[];
  now?: () => number;
  sessionTimeoutMs?: number;
  probeTimeoutMs?: number;
  codexAuthPath?: string;
  secretsFilePath?: string;
  spawnCodexLogin?: SpawnCodexLoginFn;
  spawnClaudeSetupToken?: SpawnClaudeSetupTokenFn;
  runShellCapture?: RunShellCaptureFn;
  distributeCodexAuth?: (target: AgentLoginRemoteTarget, authJson: string) => Promise<void>;
  probeRemoteCodex?: (target: AgentLoginRemoteTarget) => Promise<boolean>;
  logger?: Logger;
}

interface ResolvedOptions {
  store?: WorkerDecisionStore;
  remoteTargets: readonly AgentLoginRemoteTarget[];
  now: () => number;
  sessionTimeoutMs: number;
  probeTimeoutMs: number;
  codexAuthPath: string;
  secretsFilePath: string;
  spawnCodexLogin?: SpawnCodexLoginFn;
  spawnClaudeSetupToken?: SpawnClaudeSetupTokenFn;
  runShellCapture: RunShellCaptureFn;
  distributeCodexAuth: (target: AgentLoginRemoteTarget, authJson: string) => Promise<void>;
  probeRemoteCodex: (target: AgentLoginRemoteTarget) => Promise<boolean>;
  logger: Logger;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

interface InternalSession {
  sessionId: string;
  agent: AgentLoginAgent;
  status: AgentLoginSessionStatus;
  url?: string;
  code?: string;
  error?: string;
  createdAt: number;
  expiresAt: number;
  options: ResolvedOptions;
  ready: Deferred<void>;
  homeDir?: string;
  child?: ChildProcess;
  pty?: PtyLike;
  buffer: string;
  dataListeners: Set<() => void>;
  expireTimer?: NodeJS.Timeout;
}

const sessions = new Map<string, InternalSession>();

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return NOOP_LOGGER;
  },
};

function isTerminal(status: AgentLoginSessionStatus): boolean {
  return status === 'installed' || status === 'failed';
}

const ROW_STATUS: Record<AgentLoginSessionStatus, 'pending' | 'needs_input' | 'running' | 'completed' | 'failed'> = {
  starting: 'pending',
  awaiting_user: 'needs_input',
  awaiting_code: 'needs_input',
  verifying: 'running',
  installed: 'completed',
  failed: 'failed',
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sessionSummary(session: InternalSession): string {
  return `${session.agent} agent login session ${session.sessionId} is ${session.status}`;
}

function recordSessionRow(session: InternalSession): void {
  if (!session.options.store) return;
  recordWorkerDecisionRow(session.options.store, {
    workerKind: AGENT_LOGIN_SESSION_WORKER_KIND,
    actionType: 'agent-login-session',
    externalKey: session.sessionId,
    subjectType: 'agent-login-session',
    subjectId: `${session.agent}:${session.sessionId}`,
    sessionId: session.sessionId,
    agentName: session.agent,
    status: ROW_STATUS[session.status],
    summary: sessionSummary(session),
    now: new Date(session.options.now()).toISOString(),
    payload: {
      agent: session.agent,
      status: session.status,
      ...(session.url !== undefined ? { url: session.url } : {}),
      ...(session.code !== undefined ? { code: session.code } : {}),
      ...(session.error !== undefined ? { error: session.error } : {}),
    },
  });
}

function toSnapshot(session: InternalSession): AgentLoginSessionSnapshot {
  return {
    sessionId: session.sessionId,
    agent: session.agent,
    status: session.status,
    ...(session.url !== undefined ? { url: session.url } : {}),
    ...(session.code !== undefined ? { code: session.code } : {}),
    ...(session.error !== undefined ? { error: session.error } : {}),
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  };
}

function closeSessionProcesses(session: InternalSession): void {
  if (session.expireTimer) {
    clearTimeout(session.expireTimer);
    session.expireTimer = undefined;
  }
  if (session.child && session.child.exitCode === null && !session.child.killed) {
    try {
      session.child.kill('SIGKILL');
    } catch (err) {
      session.options.logger.error(
        `[${AGENT_LOGIN_SESSION_WORKER_KIND}] failed to kill codex login process for session ${session.sessionId}: ${describeError(err)}`,
        { module: AGENT_LOGIN_SESSION_WORKER_KIND, sessionId: session.sessionId },
      );
    }
  }
  if (session.pty) {
    try {
      session.pty.kill();
    } catch (err) {
      session.options.logger.error(
        `[${AGENT_LOGIN_SESSION_WORKER_KIND}] failed to kill claude setup-token pty for session ${session.sessionId}: ${describeError(err)}`,
        { module: AGENT_LOGIN_SESSION_WORKER_KIND, sessionId: session.sessionId },
      );
    }
  }
}

function notify(session: InternalSession): void {
  session.ready.resolve();
}

function transition(
  session: InternalSession,
  status: AgentLoginSessionStatus,
  extra?: { url?: string; code?: string; error?: string },
): void {
  if (isTerminal(session.status)) return;
  if (extra?.url !== undefined) session.url = extra.url;
  if (extra?.code !== undefined) session.code = extra.code;
  if (extra?.error !== undefined) session.error = extra.error;
  session.status = status;
  recordSessionRow(session);
  if (isTerminal(status)) closeSessionProcesses(session);
  notify(session);
}

const ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

export function stripAnsiCodes(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

const URL_PATTERN = /https?:\/\/\S+/;
const DEVICE_CODE_PATTERN = /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/;
const CLAUDE_OAUTH_TOKEN_PATTERN = /sk-ant-oat\d{2}-[A-Za-z0-9_-]+/;

export function parseCodexDeviceAuthOutput(rawOutput: string): { url: string; code: string } | null {
  const clean = stripAnsiCodes(rawOutput);
  const urlMatch = clean.match(URL_PATTERN);
  const codeMatch = clean.match(DEVICE_CODE_PATTERN);
  if (!urlMatch || !codeMatch) return null;
  return { url: urlMatch[0].trim(), code: codeMatch[0].trim() };
}

export function parseClaudeSetupTokenUrl(rawOutput: string): string | null {
  const clean = stripAnsiCodes(rawOutput);
  const match = clean.match(URL_PATTERN);
  return match ? match[0].trim() : null;
}

export function parseClaudeSetupTokenValue(rawOutput: string): string | null {
  const clean = stripAnsiCodes(rawOutput);
  const match = clean.match(CLAUDE_OAUTH_TOKEN_PATTERN);
  return match ? match[0].trim() : null;
}

function waitForPtyPattern(
  session: InternalSession,
  fromIndex: number,
  extract: (text: string) => string | null,
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    const listener = (): void => {
      const match = extract(session.buffer.slice(fromIndex));
      if (match) finish(match);
    };
    function finish(value: string | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      session.dataListeners.delete(listener);
      resolve(value);
    }
    session.dataListeners.add(listener);
    listener();
  });
}

function loadNodePtySpawn(): PtySpawnFn {
  try {
    const nodeRequire = createRequire(__filename);
    const mod = nodeRequire('node-pty') as { spawn?: PtySpawnFn };
    if (typeof mod.spawn !== 'function') {
      throw new Error('node-pty does not export spawn()');
    }
    return mod.spawn;
  } catch (err) {
    const detail = describeError(err);
    throw new Error(`Agent login requires node-pty for the Claude setup-token flow, but it is unavailable: ${detail}`);
  }
}

function defaultSpawnCodexLogin(opts: { codexHome: string; env: NodeJS.ProcessEnv }): ChildProcessWithoutNullStreams {
  const child = nodeSpawn('codex', ['login', '--device-auth'], {
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end();
  return child;
}

function defaultSpawnClaudeSetupToken(opts: { claudeConfigDir: string; env: NodeJS.ProcessEnv }): PtyLike {
  const spawnFn = loadNodePtySpawn();
  return spawnFn('claude', ['setup-token'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: opts.env,
  });
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function defaultRunShellCapture(request: ShellCaptureRequest): Promise<ShellCaptureOutcome> {
  return new Promise((resolve) => {
    const child = nodeSpawn('bash', ['-c', request.command], {
      env: request.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (err) {
        output += `\n${describeError(err)}`;
      }
    }, request.timeoutMs);
    const finish = (outcome: ShellCaptureOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('close', (code) => finish({ exitCode: code, output }));
    child.on('error', (err) => finish({ exitCode: null, output: `${output}\n${describeError(err)}` }));
  });
}

const LOGIN_FAILURE_SIGNATURES: ReadonlyArray<string> = [
  'failed to authenticate: oauth session expired and could not be refreshed',
  'your access token could not be refreshed because your refresh token was revoked',
  'please run /login',
  'token_invalidated',
];

function probeSucceeded(outcome: ShellCaptureOutcome): boolean {
  const lower = outcome.output.toLowerCase();
  if (LOGIN_FAILURE_SIGNATURES.some((signature) => lower.includes(signature))) return false;
  return outcome.exitCode === 0;
}

async function probeCodexHome(codexHome: string, options: ResolvedOptions): Promise<boolean> {
  const command = `codex exec --skip-git-repo-check ${shellQuote(AGENT_LOGIN_PROBE_PROMPT)} </dev/null`;
  const outcome = await options.runShellCapture({
    command,
    env: { ...process.env, CODEX_HOME: codexHome },
    timeoutMs: options.probeTimeoutMs,
  });
  return probeSucceeded(outcome);
}

async function probeClaudeToken(token: string, options: ResolvedOptions): Promise<boolean> {
  const command = `claude -p ${shellQuote(AGENT_LOGIN_PROBE_PROMPT)}`;
  const outcome = await options.runShellCapture({
    command,
    env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token },
    timeoutMs: options.probeTimeoutMs,
  });
  return probeSucceeded(outcome);
}

function defaultDistributeCodexAuth(target: AgentLoginRemoteTarget, authJson: string): Promise<void> {
  const sshArgs = buildSshConnectionArgs(target.connection, { batchMode: true });
  return execRemoteCapture({
    sshArgs,
    script: buildDistributeCredentialsScript('~/.codex/auth.json', authJson),
    phase: `agent-login-session:codex:${target.name}`,
  }).then(() => undefined);
}

async function defaultProbeRemoteCodex(target: AgentLoginRemoteTarget): Promise<boolean> {
  const sshArgs = buildSshConnectionArgs(target.connection, { batchMode: true });
  const script = `codex exec --skip-git-repo-check ${shellQuote(AGENT_LOGIN_PROBE_PROMPT)} </dev/null\n`;
  try {
    const output = await execRemoteCapture({
      sshArgs,
      script,
      phase: `agent-login-session:codex-probe:${target.name}`,
    });
    return probeSucceeded({ exitCode: 0, output });
  } catch {
    return false;
  }
}

function utcStamp(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-');
}

function backupAndWriteAtomic(path: string, contents: string, nowStamp: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    copyFileSync(path, `${path}.bak-${nowStamp}`);
  }
  const tmpPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmpPath, contents, { mode: 0o600 });
  renameSync(tmpPath, path);
}

function installCodexAuth(authJson: string, options: ResolvedOptions): void {
  backupAndWriteAtomic(options.codexAuthPath, authJson, utcStamp(options.now()));
}

function upsertEnvFileLine(contents: string, key: string, value: string): string {
  const lines = contents.length > 0 ? contents.split('\n') : [];
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const prefix = `${key}=`;
  let replaced = false;
  const next = lines.map((line) => {
    if (line.startsWith(prefix)) {
      replaced = true;
      return `${prefix}${value}`;
    }
    return line;
  });
  if (!replaced) next.push(`${prefix}${value}`);
  return `${next.join('\n')}\n`;
}

function installClaudeToken(token: string, options: ResolvedOptions): void {
  const existing = existsSync(options.secretsFilePath) ? readFileSync(options.secretsFilePath, 'utf8') : '';
  const updated = upsertEnvFileLine(existing, 'CLAUDE_CODE_OAUTH_TOKEN', token);
  backupAndWriteAtomic(options.secretsFilePath, updated, utcStamp(options.now()));
}

function defaultSecretsFilePath(): string {
  return join(homedir(), '.config', 'invoker', 'secrets.env');
}

function resolveOptions(options: StartAgentLoginOptions): ResolvedOptions {
  return {
    store: options.store,
    remoteTargets: options.remoteTargets ?? [],
    now: options.now ?? (() => Date.now()),
    sessionTimeoutMs: options.sessionTimeoutMs ?? DEFAULT_AGENT_LOGIN_SESSION_TIMEOUT_MS,
    probeTimeoutMs: options.probeTimeoutMs ?? DEFAULT_AGENT_LOGIN_PROBE_TIMEOUT_MS,
    codexAuthPath: options.codexAuthPath ?? resolveCodexAuthPath(),
    secretsFilePath: options.secretsFilePath ?? defaultSecretsFilePath(),
    spawnCodexLogin: options.spawnCodexLogin,
    spawnClaudeSetupToken: options.spawnClaudeSetupToken,
    runShellCapture: options.runShellCapture ?? defaultRunShellCapture,
    distributeCodexAuth: options.distributeCodexAuth ?? defaultDistributeCodexAuth,
    probeRemoteCodex: options.probeRemoteCodex ?? defaultProbeRemoteCodex,
    logger: options.logger ?? NOOP_LOGGER,
  };
}

async function finishCodexLogin(session: InternalSession, options: ResolvedOptions): Promise<void> {
  transition(session, 'verifying');
  let authJson: string;
  try {
    authJson = readFileSync(join(session.homeDir as string, 'auth.json'), 'utf8');
  } catch {
    transition(session, 'failed', { error: 'codex login did not produce an auth.json' });
    return;
  }

  const probeOk = await probeCodexHome(session.homeDir as string, options);
  if (!probeOk) {
    transition(session, 'failed', { error: 'test call with the new Codex login failed' });
    return;
  }

  installCodexAuth(authJson, options);

  for (const target of options.remoteTargets) {
    try {
      await options.distributeCodexAuth(target, authJson);
      const remoteOk = await options.probeRemoteCodex(target);
      if (!remoteOk) {
        options.logger.error(
          `[${AGENT_LOGIN_SESSION_WORKER_KIND}] Codex login test call failed on ${target.name} after distributing credentials`,
          { module: AGENT_LOGIN_SESSION_WORKER_KIND, target: target.name },
        );
      }
    } catch (err) {
      options.logger.error(
        `[${AGENT_LOGIN_SESSION_WORKER_KIND}] failed to distribute Codex login to ${target.name}: ${describeError(err)}`,
        { module: AGENT_LOGIN_SESSION_WORKER_KIND, target: target.name },
      );
    }
  }

  transition(session, 'installed');
}

async function runCodexLogin(session: InternalSession, options: ResolvedOptions): Promise<void> {
  const codexHome = mkdtempSync(join(tmpdir(), 'invoker-codex-login-'));
  session.homeDir = codexHome;
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome };
  const spawnFn = options.spawnCodexLogin ?? defaultSpawnCodexLogin;

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnFn({ codexHome, env });
  } catch (err) {
    transition(session, 'failed', { error: describeError(err) });
    return;
  }
  session.child = child;

  let parsed = false;
  const tryParse = (): void => {
    if (parsed) return;
    const result = parseCodexDeviceAuthOutput(session.buffer);
    if (result) {
      parsed = true;
      transition(session, 'awaiting_user', { url: result.url, code: result.code });
    }
  };
  child.stdout.on('data', (chunk: Buffer) => {
    session.buffer += chunk.toString();
    tryParse();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    session.buffer += chunk.toString();
    tryParse();
  });
  child.on('error', (err) => {
    transition(session, 'failed', { error: describeError(err) });
  });
  child.on('close', (exitCode) => {
    if (isTerminal(session.status)) return;
    if (exitCode !== 0) {
      transition(session, 'failed', { error: `codex login exited with code ${exitCode}` });
      return;
    }
    void finishCodexLogin(session, options);
  });
}

async function finishClaudeVerification(session: InternalSession, code: string, options: ResolvedOptions): Promise<void> {
  const fromIndex = session.buffer.length;
  (session.pty as PtyLike).write(`${code}\r`);
  const token = await waitForPtyPattern(session, fromIndex, parseClaudeSetupTokenValue, options.probeTimeoutMs);
  if (!token) {
    transition(session, 'failed', { error: 'did not receive a token after submitting the code' });
    return;
  }

  const probeOk = await probeClaudeToken(token, options);
  if (!probeOk) {
    transition(session, 'failed', { error: 'test call with the new Claude login failed' });
    return;
  }

  installClaudeToken(token, options);
  transition(session, 'installed');
}

async function runClaudeLogin(session: InternalSession, options: ResolvedOptions): Promise<void> {
  const claudeConfigDir = mkdtempSync(join(tmpdir(), 'invoker-claude-login-'));
  session.homeDir = claudeConfigDir;
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: claudeConfigDir };
  const spawnFn = options.spawnClaudeSetupToken ?? defaultSpawnClaudeSetupToken;

  let pty: PtyLike;
  try {
    pty = spawnFn({ claudeConfigDir, env });
  } catch (err) {
    transition(session, 'failed', { error: describeError(err) });
    return;
  }
  session.pty = pty;

  pty.onData((data) => {
    session.buffer += data;
    for (const listener of Array.from(session.dataListeners)) listener();
  });
  pty.onExit(({ exitCode }) => {
    if (session.status === 'awaiting_code' || session.status === 'starting' || session.status === 'awaiting_user') {
      transition(session, 'failed', { error: `claude setup-token exited early with code ${exitCode}` });
    }
  });

  const url = await waitForPtyPattern(session, 0, parseClaudeSetupTokenUrl, READY_TIMEOUT_MS);
  if (!url) {
    if (!isTerminal(session.status)) {
      transition(session, 'failed', { error: 'claude setup-token did not print a login URL' });
    }
    return;
  }
  transition(session, 'awaiting_code', { url });
}

export async function startAgentLogin(
  agent: AgentLoginAgent,
  options: StartAgentLoginOptions = {},
): Promise<AgentLoginSessionSnapshot> {
  const resolved = resolveOptions(options);
  const sessionId = randomUUID();
  const createdAt = resolved.now();
  const session: InternalSession = {
    sessionId,
    agent,
    status: 'starting',
    createdAt,
    expiresAt: createdAt + resolved.sessionTimeoutMs,
    options: resolved,
    ready: createDeferred<void>(),
    buffer: '',
    dataListeners: new Set(),
  };
  sessions.set(sessionId, session);
  recordSessionRow(session);

  session.expireTimer = setTimeout(() => {
    if (isTerminal(session.status)) return;
    transition(session, 'failed', { error: `agent login session expired after ${resolved.sessionTimeoutMs}ms` });
  }, resolved.sessionTimeoutMs);
  session.expireTimer.unref?.();

  const run = agent === 'codex' ? runCodexLogin(session, resolved) : runClaudeLogin(session, resolved);
  run.catch((err) => {
    transition(session, 'failed', { error: describeError(err) });
  });

  await Promise.race([session.ready.promise, delay(READY_TIMEOUT_MS)]);
  return toSnapshot(session);
}

export async function submitAgentLoginCode(sessionId: string, code: string): Promise<AgentLoginSessionSnapshot> {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Unknown agent login session "${sessionId}".`);
  }
  if (session.agent !== 'claude') {
    throw new Error(`Session "${sessionId}" (${session.agent}) does not accept a submitted code.`);
  }
  if (session.status !== 'awaiting_code') {
    throw new Error(`Session "${sessionId}" is not awaiting a code (status: ${session.status}).`);
  }

  transition(session, 'verifying');
  await finishClaudeVerification(session, code, session.options);
  return toSnapshot(session);
}

export function getAgentLoginStatus(sessionId: string): AgentLoginSessionSnapshot | undefined {
  const session = sessions.get(sessionId);
  return session ? toSnapshot(session) : undefined;
}
