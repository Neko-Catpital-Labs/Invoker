import { randomUUID } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { Logger } from '@invoker/contracts';
import type { ClaudeOauthRefreshTarget } from '@invoker/execution-engine';
import {
  buildDistributeCredentialsScript,
  buildReadCredentialsScript,
  buildSshConnectionArgs,
  execRemoteCapture,
} from '@invoker/execution-engine';

import type { PtyForkOptionsLike, PtyLike, PtySpawnFn } from './embedded-terminal-manager.js';

export type AgentLoginProvider = 'codex' | 'claude';

export type AgentLoginSessionStatus =
  | 'starting'
  | 'awaiting_user'
  | 'awaiting_code'
  | 'verifying'
  | 'installed'
  | 'failed';

export interface AgentLoginSessionStatusView {
  sessionId: string;
  provider: AgentLoginProvider;
  status: AgentLoginSessionStatus;
  loginUrl?: string;
  code?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export type AgentLoginRemoteTarget = ClaudeOauthRefreshTarget;

interface ChildProcessLike {
  stdout?: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null;
  stderr?: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null;
  once(event: 'exit', cb: (code: number | null) => void): void;
  once(event: 'error', cb: (err: Error) => void): void;
  kill(): void;
}

export type AgentLoginSpawnFn = (
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string; stdio?: 'ignore' | 'pipe' },
) => ChildProcessLike;

export interface AgentLoginSessionDependencies {
  logger?: Logger;
  now?: () => number;
  sessionTtlMs?: number;
  parseTimeoutMs?: number;
  remoteTargets?: AgentLoginRemoteTarget[];
  codexAuthInstallPath?: string;
  secretsFilePath?: string;
  spawnFn?: AgentLoginSpawnFn;
  ptySpawnFn?: PtySpawnFn;
  probeCodexFn?: (codexHome: string, deps: AgentLoginSessionDependencies) => Promise<boolean>;
  probeClaudeFn?: (token: string, deps: AgentLoginSessionDependencies) => Promise<boolean>;
  distributeCodexFn?: (target: AgentLoginRemoteTarget, authJson: string) => Promise<void>;
  mkTempDirFn?: (provider: AgentLoginProvider) => string;
  rmDirFn?: (path: string) => void;
}

export const DEFAULT_AGENT_LOGIN_SESSION_TTL_MS = 15 * 60 * 1000;
const DEFAULT_PARSE_TIMEOUT_MS = 30_000;
const DEFAULT_CODEX_REMOTE_AUTH_PATH = '~/.codex/auth.json';

const ANSI_PATTERN = /\x1b(?:\[[0-9;]*[a-zA-Z]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/;
const DEVICE_CODE_PATTERN = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;
const CLAUDE_OAUTH_TOKEN_PATTERN = /\b(sk-ant-oat\d{2}-[A-Za-z0-9_-]{10,})\b/;

export function stripAnsiColorCodes(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

export function parseLoginUrl(rawOutput: string): string | null {
  const match = stripAnsiColorCodes(rawOutput).match(URL_PATTERN);
  return match ? match[0] : null;
}

export function parseCodexDeviceAuthOutput(rawOutput: string): { url: string; code: string } | null {
  const text = stripAnsiColorCodes(rawOutput);
  const urlMatch = text.match(URL_PATTERN);
  const codeMatch = text.match(DEVICE_CODE_PATTERN);
  if (!urlMatch || !codeMatch) return null;
  return { url: urlMatch[0], code: codeMatch[1] };
}

export function parseClaudeOauthToken(rawOutput: string): string | null {
  const match = stripAnsiColorCodes(rawOutput).match(CLAUDE_OAUTH_TOKEN_PATTERN);
  return match ? match[1] : null;
}

interface ClaudeFlowHandle {
  pty: PtyLike;
  dataDisposable: { dispose: () => void };
  exitDisposable: { dispose: () => void };
  tokenDeferred: Deferred<string>;
}

interface AgentLoginInternalState {
  sessionId: string;
  provider: AgentLoginProvider;
  tempDir: string;
  status: AgentLoginSessionStatus;
  loginUrl?: string;
  code?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  claude?: ClaudeFlowHandle;
}

const sessions = new Map<string, AgentLoginInternalState>();

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let settled = false;
  let resolveFn!: (value: T) => void;
  let rejectFn!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    rejectFn = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function toView(state: AgentLoginInternalState): AgentLoginSessionStatusView {
  return {
    sessionId: state.sessionId,
    provider: state.provider,
    status: state.status,
    ...(state.loginUrl !== undefined ? { loginUrl: state.loginUrl } : {}),
    ...(state.code !== undefined ? { code: state.code } : {}),
    ...(state.error !== undefined ? { error: state.error } : {}),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    expiresAt: state.expiresAt,
  };
}

function transition(state: AgentLoginInternalState, status: AgentLoginSessionStatus, now: number): void {
  state.status = status;
  state.updatedAt = now;
}

function cleanupTempDir(state: AgentLoginInternalState, deps: AgentLoginSessionDependencies): void {
  try {
    (deps.rmDirFn ?? defaultRmDir)(state.tempDir);
  } catch (error) {
    deps.logger?.warn('agent-login-session: failed to remove temp login dir', {
      sessionId: state.sessionId,
      provider: state.provider,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function finalizeFailure(
  state: AgentLoginInternalState,
  error: string,
  deps: AgentLoginSessionDependencies,
  now: number,
): void {
  state.status = 'failed';
  state.error = error;
  state.updatedAt = now;
  deps.logger?.error(`agent-login-session: ${state.provider} login failed for session ${state.sessionId}`, {
    sessionId: state.sessionId,
    provider: state.provider,
    reason: error,
  });
  cleanupTempDir(state, deps);
}

function finalizeSuccess(state: AgentLoginInternalState, deps: AgentLoginSessionDependencies, now: number): void {
  transition(state, 'installed', now);
  deps.logger?.info(`agent-login-session: ${state.provider} login installed for session ${state.sessionId}`, {
    sessionId: state.sessionId,
    provider: state.provider,
  });
  cleanupTempDir(state, deps);
}

function defaultMkTempDir(provider: AgentLoginProvider): string {
  return mkdtempSync(join(tmpdir(), `invoker-agent-login-${provider}-`));
}

function defaultRmDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function utcStamp(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-');
}

function backupIfExists(path: string, now: number): void {
  if (!existsSync(path)) return;
  copyFileSync(path, `${path}.bak-${utcStamp(now)}`);
}

function atomicInstall(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmpPath, contents, { mode: 0o600 });
  renameSync(tmpPath, path);
}

function upsertEnvVar(contents: string, key: string, value: string): string {
  const lines = contents.length > 0 ? contents.split('\n') : [];
  const prefix = `${key}=`;
  let replaced = false;
  const next = lines.map((line) => {
    if (!line.startsWith(prefix)) return line;
    replaced = true;
    return `${prefix}${value}`;
  });
  if (!replaced) {
    if (next.length > 0 && next[next.length - 1] === '') next.pop();
    next.push(`${prefix}${value}`);
  }
  const joined = next.join('\n');
  return joined.endsWith('\n') ? joined : `${joined}\n`;
}

function resolveCodexAuthInstallPath(deps: AgentLoginSessionDependencies): string {
  return deps.codexAuthInstallPath ?? join(homedir(), '.codex', 'auth.json');
}

function resolveSecretsFilePath(deps: AgentLoginSessionDependencies): string {
  return deps.secretsFilePath ?? join(homedir(), '.config', 'invoker', 'secrets.env');
}

async function defaultDistributeCodexToTarget(target: AgentLoginRemoteTarget, authJson: string): Promise<void> {
  const sshArgs = buildSshConnectionArgs(target.connection, { batchMode: true });
  const remotePath = target.remotePath ?? DEFAULT_CODEX_REMOTE_AUTH_PATH;
  await execRemoteCapture({
    sshArgs,
    script: buildDistributeCredentialsScript(remotePath, authJson),
    phase: `agent-login-install:${target.name}`,
  });
  const readBack = await execRemoteCapture({
    sshArgs,
    script: buildReadCredentialsScript(remotePath),
    phase: `agent-login-reprobe:${target.name}`,
  });
  if (readBack !== authJson) {
    throw new Error(`Remote credentials at "${target.name}" did not match after distribution (re-probe failed).`);
  }
}

async function defaultProbeCodex(codexHome: string, deps: AgentLoginSessionDependencies): Promise<boolean> {
  const spawnFn = deps.spawnFn ?? (nodeSpawn as unknown as AgentLoginSpawnFn);
  return new Promise((resolve) => {
    const child = spawnFn('codex', ['login', 'status'], {
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: 'ignore',
    });
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
}

async function defaultProbeClaude(token: string, deps: AgentLoginSessionDependencies): Promise<boolean> {
  const spawnFn = deps.spawnFn ?? (nodeSpawn as unknown as AgentLoginSpawnFn);
  return new Promise((resolve) => {
    const child = spawnFn('claude', ['-p', 'ok', '--max-turns', '1'], {
      env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token },
      stdio: 'ignore',
    });
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
}

async function installCodexAuth(
  state: AgentLoginInternalState,
  deps: AgentLoginSessionDependencies,
  now: number,
): Promise<void> {
  const newContents = readFileSync(join(state.tempDir, 'auth.json'), 'utf8');
  const installPath = resolveCodexAuthInstallPath(deps);
  backupIfExists(installPath, now);
  atomicInstall(installPath, newContents);

  for (const target of deps.remoteTargets ?? []) {
    try {
      await (deps.distributeCodexFn ?? defaultDistributeCodexToTarget)(target, newContents);
    } catch (error) {
      deps.logger?.warn(`agent-login-session: failed to distribute codex login to ${target.name}`, {
        sessionId: state.sessionId,
        target: target.name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function installClaudeToken(token: string, deps: AgentLoginSessionDependencies, now: number): void {
  const path = resolveSecretsFilePath(deps);
  backupIfExists(path, now);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const updated = upsertEnvVar(existing, 'CLAUDE_CODE_OAUTH_TOKEN', token);
  atomicInstall(path, updated);
}

function createSession(
  provider: AgentLoginProvider,
  deps: AgentLoginSessionDependencies,
): AgentLoginInternalState {
  const now = deps.now?.() ?? Date.now();
  const ttl = deps.sessionTtlMs ?? DEFAULT_AGENT_LOGIN_SESSION_TTL_MS;
  const tempDir = (deps.mkTempDirFn ?? defaultMkTempDir)(provider);
  const state: AgentLoginInternalState = {
    sessionId: randomUUID(),
    provider,
    tempDir,
    status: 'starting',
    createdAt: now,
    updatedAt: now,
    expiresAt: now + ttl,
  };
  sessions.set(state.sessionId, state);
  return state;
}

async function beginCodexLogin(state: AgentLoginInternalState, deps: AgentLoginSessionDependencies): Promise<void> {
  const spawnFn = deps.spawnFn ?? (nodeSpawn as unknown as AgentLoginSpawnFn);
  const parseTimeoutMs = deps.parseTimeoutMs ?? DEFAULT_PARSE_TIMEOUT_MS;
  const child = spawnFn('codex', ['login', '--device-auth'], {
    env: { ...process.env, CODEX_HOME: state.tempDir },
  });

  const parsed = createDeferred<{ url: string; code: string }>();
  let buffer = '';
  const onData = (chunk: Buffer | string): void => {
    buffer += chunk.toString();
    const found = parseCodexDeviceAuthOutput(buffer);
    if (found) parsed.resolve(found);
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  const exitPromise = new Promise<number | null>((resolve, reject) => {
    child.once('exit', (code) => resolve(code));
    child.once('error', (err) => reject(err));
  });
  exitPromise.catch((error) => parsed.reject(error));

  let found: { url: string; code: string };
  try {
    found = await withTimeout(
      parsed.promise,
      parseTimeoutMs,
      'codex login did not print a device URL and code in time',
    );
  } catch (error) {
    try {
      child.kill();
    } catch (killError) {
      deps.logger?.debug('agent-login-session: codex login process kill failed (already exited)', {
        sessionId: state.sessionId,
        reason: killError instanceof Error ? killError.message : String(killError),
      });
    }
    finalizeFailure(state, error instanceof Error ? error.message : String(error), deps, deps.now?.() ?? Date.now());
    return;
  }

  state.loginUrl = found.url;
  state.code = found.code;
  transition(state, 'awaiting_user', deps.now?.() ?? Date.now());

  void (async () => {
    let exitCode: number | null;
    try {
      exitCode = await exitPromise;
    } catch (error) {
      finalizeFailure(
        state,
        `codex login process error: ${error instanceof Error ? error.message : String(error)}`,
        deps,
        deps.now?.() ?? Date.now(),
      );
      return;
    }
    if (exitCode !== 0) {
      finalizeFailure(state, `codex login exited with code ${exitCode ?? 'null'}`, deps, deps.now?.() ?? Date.now());
      return;
    }

    transition(state, 'verifying', deps.now?.() ?? Date.now());
    const probeOk = await (deps.probeCodexFn ?? defaultProbeCodex)(state.tempDir, deps);
    if (!probeOk) {
      finalizeFailure(
        state,
        'Codex login probe failed; the live Codex login was left untouched.',
        deps,
        deps.now?.() ?? Date.now(),
      );
      return;
    }

    try {
      await installCodexAuth(state, deps, deps.now?.() ?? Date.now());
      finalizeSuccess(state, deps, deps.now?.() ?? Date.now());
    } catch (error) {
      finalizeFailure(
        state,
        `failed to install codex login: ${error instanceof Error ? error.message : String(error)}`,
        deps,
        deps.now?.() ?? Date.now(),
      );
    }
  })();
}

function loadNodePtySpawn(): PtySpawnFn {
  try {
    const nodeRequire = createRequire(__filename);
    const mod = nodeRequire('node-pty') as { spawn?: PtySpawnFn };
    if (typeof mod.spawn !== 'function') {
      throw new Error('node-pty does not export spawn()');
    }
    return mod.spawn;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Agent login for Claude requires node-pty, which is unavailable or not built: ${detail}`);
  }
}

function cleanupClaudeHandle(claude: ClaudeFlowHandle, logger?: Logger): void {
  try {
    claude.dataDisposable.dispose();
  } catch (error) {
    logger?.debug('agent-login-session: claude pty data listener dispose failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    claude.exitDisposable.dispose();
  } catch (error) {
    logger?.debug('agent-login-session: claude pty exit listener dispose failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    claude.pty.kill();
  } catch (error) {
    logger?.debug('agent-login-session: claude pty kill failed (already exited)', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

async function beginClaudeLogin(state: AgentLoginInternalState, deps: AgentLoginSessionDependencies): Promise<void> {
  const ptySpawnFn = deps.ptySpawnFn ?? loadNodePtySpawn();
  const parseTimeoutMs = deps.parseTimeoutMs ?? DEFAULT_PARSE_TIMEOUT_MS;
  const ptyOptions: PtyForkOptionsLike = {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: homedir(),
    env: { ...process.env, CLAUDE_CONFIG_DIR: state.tempDir },
  };
  const pty = ptySpawnFn('claude', ['setup-token'], ptyOptions);

  const urlDeferred = createDeferred<string>();
  const tokenDeferred = createDeferred<string>();
  let buffer = '';
  const dataDisposable = pty.onData((chunk) => {
    buffer += stripAnsiColorCodes(chunk);
    const url = parseLoginUrl(buffer);
    if (url) urlDeferred.resolve(url);
    const token = parseClaudeOauthToken(buffer);
    if (token) tokenDeferred.resolve(token);
  });
  const exitDisposable = pty.onExit(() => {
    urlDeferred.reject(new Error('claude setup-token exited before printing a login URL'));
    tokenDeferred.reject(new Error('claude setup-token exited before printing a token'));
  });

  const claude: ClaudeFlowHandle = { pty, dataDisposable, exitDisposable, tokenDeferred };

  let url: string;
  try {
    url = await withTimeout(urlDeferred.promise, parseTimeoutMs, 'claude setup-token did not print a login URL in time');
  } catch (error) {
    cleanupClaudeHandle(claude, deps.logger);
    finalizeFailure(state, error instanceof Error ? error.message : String(error), deps, deps.now?.() ?? Date.now());
    return;
  }

  state.loginUrl = url;
  state.claude = claude;
  transition(state, 'awaiting_code', deps.now?.() ?? Date.now());
}

export async function startAgentLogin(
  provider: AgentLoginProvider,
  deps: AgentLoginSessionDependencies = {},
): Promise<AgentLoginSessionStatusView> {
  const state = createSession(provider, deps);
  if (provider === 'codex') {
    await beginCodexLogin(state, deps);
  } else {
    await beginClaudeLogin(state, deps);
  }
  return toView(state);
}

function requireSession(sessionId: string): AgentLoginInternalState {
  const state = sessions.get(sessionId);
  if (!state) throw new Error(`Unknown agent login session "${sessionId}".`);
  return state;
}

function maybeExpire(state: AgentLoginInternalState, deps: AgentLoginSessionDependencies, now: number): void {
  if (state.status === 'installed' || state.status === 'failed') return;
  if (now <= state.expiresAt) return;
  if (state.claude) cleanupClaudeHandle(state.claude, deps.logger);
  finalizeFailure(state, 'Agent login session expired after 15 minutes.', deps, now);
}

export async function submitAgentLoginCode(
  sessionId: string,
  code: string,
  deps: AgentLoginSessionDependencies = {},
): Promise<AgentLoginSessionStatusView> {
  const state = requireSession(sessionId);
  const now = deps.now?.() ?? Date.now();
  maybeExpire(state, deps, now);
  if (state.status === 'failed' || state.status === 'installed') return toView(state);

  if (state.provider !== 'claude' || state.status !== 'awaiting_code' || !state.claude) {
    throw new Error(`Agent login session "${sessionId}" is not awaiting a code.`);
  }

  const claude = state.claude;
  const parseTimeoutMs = deps.parseTimeoutMs ?? DEFAULT_PARSE_TIMEOUT_MS;
  claude.pty.write(`${code}\n`);
  transition(state, 'verifying', now);

  let token: string;
  try {
    token = await withTimeout(
      claude.tokenDeferred.promise,
      parseTimeoutMs,
      'claude setup-token did not print a token after the code was submitted',
    );
  } catch (error) {
    cleanupClaudeHandle(claude, deps.logger);
    finalizeFailure(state, error instanceof Error ? error.message : String(error), deps, deps.now?.() ?? Date.now());
    return toView(state);
  }

  cleanupClaudeHandle(claude, deps.logger);
  const probeOk = await (deps.probeClaudeFn ?? defaultProbeClaude)(token, deps);
  if (!probeOk) {
    finalizeFailure(
      state,
      'Claude login probe failed; the live Claude login was left untouched.',
      deps,
      deps.now?.() ?? Date.now(),
    );
    return toView(state);
  }

  try {
    installClaudeToken(token, deps, deps.now?.() ?? Date.now());
    finalizeSuccess(state, deps, deps.now?.() ?? Date.now());
  } catch (error) {
    finalizeFailure(
      state,
      `failed to install claude login: ${error instanceof Error ? error.message : String(error)}`,
      deps,
      deps.now?.() ?? Date.now(),
    );
  }
  return toView(state);
}

export function getAgentLoginStatus(
  sessionId: string,
  deps: AgentLoginSessionDependencies = {},
): AgentLoginSessionStatusView {
  const state = requireSession(sessionId);
  maybeExpire(state, deps, deps.now?.() ?? Date.now());
  return toView(state);
}
