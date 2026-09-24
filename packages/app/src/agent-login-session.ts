import { randomUUID } from 'node:crypto';
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
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';

import {
  buildDistributeCredentialsScript,
  buildSshConnectionArgs,
  execRemoteCapture,
  type SshTargetConnection,
} from '@invoker/execution-engine';

import type { PtyForkOptionsLike, PtyLike, PtySpawnFn } from './embedded-terminal-manager.js';

const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;
const AGENT_LOGIN_SESSION_PROBE_PROMPT = 'Reply with just the word ok';
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]/g;

export type AgentLoginProvider = 'codex' | 'claude';

export type AgentLoginStatus =
  | 'starting'
  | 'awaiting_user'
  | 'awaiting_code'
  | 'verifying'
  | 'installed'
  | 'failed';

export interface AgentLoginRemoteTarget {
  readonly name: string;
  readonly connection: SshTargetConnection;
  readonly remotePath?: string;
}

export interface AgentLoginSessionView {
  readonly sessionId: string;
  readonly provider: AgentLoginProvider;
  readonly status: AgentLoginStatus;
  readonly url?: string;
  readonly code?: string;
  readonly error?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface AgentLoginSessionLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export type SpawnCommandFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface AgentLoginSessionOptions {
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  secretsFilePath?: string;
  codexInstallDir?: string;
  cwd?: string;
  sessionTtlMs?: number;
  makeTempDir?: (prefix: string) => string;
  spawnCommand?: SpawnCommandFn;
  ptySpawn?: PtySpawnFn;
  remoteTargets?: ReadonlyArray<AgentLoginRemoteTarget>;
  distributeToRemote?: (target: AgentLoginRemoteTarget, contents: string) => Promise<void>;
  probeRemote?: (target: AgentLoginRemoteTarget) => Promise<boolean>;
  deviceAuthParseTimeoutMs?: number;
  claudeUrlTimeoutMs?: number;
  claudeTokenTimeoutMs?: number;
  probeTimeoutMs?: number;
  logger?: AgentLoginSessionLogger;
}

export function stripAnsiColorCodes(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, '');
}

export function parseCodexDeviceAuthOutput(rawOutput: string): { url: string; code: string } | null {
  const clean = stripAnsiColorCodes(rawOutput);
  const urlMatch = clean.match(/Open this URL to continue:\s*(\S+)/);
  const codeMatch = clean.match(/One-time code:\s*(\S+)/);
  if (!urlMatch || !codeMatch) return null;
  return { url: urlMatch[1], code: codeMatch[1] };
}

export function parseClaudeSetupTokenUrl(rawOutput: string): string | null {
  const clean = stripAnsiColorCodes(rawOutput);
  const match = clean.match(/Visit this URL to authorize:\s*(\S+)/);
  return match ? match[1] : null;
}

export function parseClaudeSetupTokenValue(rawOutput: string): string | null {
  const clean = stripAnsiColorCodes(rawOutput);
  const match = clean.match(/Your Claude Code OAuth token:\s*(\S+)/);
  return match ? match[1] : null;
}

interface ResolvedOptions {
  now: () => number;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  secretsFilePath: string;
  codexInstallDir: string;
  cwd: string;
  makeTempDir: (prefix: string) => string;
  spawnCommand: SpawnCommandFn;
  ptySpawnOverride?: PtySpawnFn;
  remoteTargets: ReadonlyArray<AgentLoginRemoteTarget>;
  distributeToRemote: (target: AgentLoginRemoteTarget, contents: string) => Promise<void>;
  probeRemote: (target: AgentLoginRemoteTarget) => Promise<boolean>;
  deviceAuthParseTimeoutMs: number;
  claudeUrlTimeoutMs: number;
  claudeTokenTimeoutMs: number;
  probeTimeoutMs: number;
  logger: AgentLoginSessionLogger;
}

interface CodexRuntime {
  buffer: string;
  exitCode?: number;
}

interface ClaudeWaiter {
  matcher: (buffer: string) => string | null;
  resolve: (value: string | null) => void;
}

interface ClaudeRuntime {
  pty: PtyLike;
  buffer: string;
  exitCode?: number;
  waiters: ClaudeWaiter[];
}

interface SessionRecord {
  id: string;
  provider: AgentLoginProvider;
  status: AgentLoginStatus;
  url?: string;
  deviceCode?: string;
  error?: string;
  createdAt: number;
  expiresAt: number;
  opts: ResolvedOptions;
  codexHome?: string;
  codexRuntime?: CodexRuntime;
  claudeConfigDir?: string;
  claudeRuntime?: ClaudeRuntime;
}

const sessions = new Map<string, SessionRecord>();

const consoleLogger: AgentLoginSessionLogger = {
  info: (message) => { console.info(message); },
  warn: (message) => { console.warn(message); },
  error: (message) => { console.error(message); },
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultDistributeCodexToRemote(target: AgentLoginRemoteTarget, authJson: string): Promise<void> {
  const sshArgs = buildSshConnectionArgs(target.connection, { batchMode: true });
  const remotePath = target.remotePath ?? '~/.codex/auth.json';
  return execRemoteCapture({
    sshArgs,
    script: buildDistributeCredentialsScript(remotePath, authJson),
    phase: `agent-login-session:codex:${target.name}`,
  }).then(() => undefined);
}

function defaultProbeCodexRemote(target: AgentLoginRemoteTarget): Promise<boolean> {
  const sshArgs = buildSshConnectionArgs(target.connection, { batchMode: true });
  const script = `codex exec --skip-git-repo-check '${AGENT_LOGIN_SESSION_PROBE_PROMPT}' </dev/null\n`;
  return execRemoteCapture({ sshArgs, script, phase: `agent-login-session:codex-probe:${target.name}` })
    .then(() => true)
    .catch(() => false);
}

function loadNodePtySpawn(): PtySpawnFn {
  const nodeRequire = createRequire(__filename);
  const mod = nodeRequire('node-pty') as { spawn?: PtySpawnFn };
  if (typeof mod.spawn !== 'function') {
    throw new Error('node-pty does not export spawn()');
  }
  return mod.spawn;
}

function resolvePtySpawn(opts: ResolvedOptions): PtySpawnFn {
  return opts.ptySpawnOverride ?? loadNodePtySpawn();
}

function normalizeOptions(options: AgentLoginSessionOptions): ResolvedOptions {
  const homeDir = options.homeDir ?? homedir();
  return {
    now: options.now ?? Date.now,
    env: options.env ?? process.env,
    homeDir,
    secretsFilePath: options.secretsFilePath ?? join(homeDir, '.config', 'invoker', 'secrets.env'),
    codexInstallDir: options.codexInstallDir ?? join(homeDir, '.codex'),
    cwd: options.cwd ?? process.cwd(),
    makeTempDir: options.makeTempDir ?? ((prefix: string) => mkdtempSync(join(tmpdir(), prefix))),
    spawnCommand: options.spawnCommand ?? (nodeSpawn as unknown as SpawnCommandFn),
    ptySpawnOverride: options.ptySpawn,
    remoteTargets: options.remoteTargets ?? [],
    distributeToRemote: options.distributeToRemote ?? defaultDistributeCodexToRemote,
    probeRemote: options.probeRemote ?? defaultProbeCodexRemote,
    deviceAuthParseTimeoutMs: options.deviceAuthParseTimeoutMs ?? 15_000,
    claudeUrlTimeoutMs: options.claudeUrlTimeoutMs ?? 15_000,
    claudeTokenTimeoutMs: options.claudeTokenTimeoutMs ?? 20_000,
    probeTimeoutMs: options.probeTimeoutMs ?? 30_000,
    logger: options.logger ?? consoleLogger,
  };
}

function buildProbeEnv(base: NodeJS.ProcessEnv, overrides: Record<string, string>): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...base };
  delete merged.CLAUDE_CONFIG_DIR;
  delete merged.CODEX_HOME;
  delete merged.CLAUDE_CODE_OAUTH_TOKEN;
  return { ...merged, ...overrides };
}

function killChild(child: ChildProcess, logger: AgentLoginSessionLogger): void {
  try {
    child.kill('SIGKILL');
  } catch (error) {
    logger.warn(`[agent-login-session] failed to kill a login/probe child process: ${errorMessage(error)}`);
  }
}

function toView(session: SessionRecord): AgentLoginSessionView {
  return {
    sessionId: session.id,
    provider: session.provider,
    status: session.status,
    ...(session.url !== undefined ? { url: session.url } : {}),
    ...(session.deviceCode !== undefined ? { code: session.deviceCode } : {}),
    ...(session.error !== undefined ? { error: session.error } : {}),
    createdAt: new Date(session.createdAt).toISOString(),
    expiresAt: new Date(session.expiresAt).toISOString(),
  };
}

function requireSession(sessionId: string): SessionRecord {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Unknown agent login session "${sessionId}".`);
  return session;
}

function cleanupCodexTemp(session: SessionRecord): void {
  const codexHome = session.codexHome!;
  try {
    rmSync(codexHome, { recursive: true, force: true });
  } catch (error) {
    session.opts.logger.warn(
      `[agent-login-session] failed to remove codex login temp dir ${codexHome}: ${errorMessage(error)}`,
    );
  }
}

function cleanupClaude(session: SessionRecord): void {
  const runtime = session.claudeRuntime;
  if (runtime) {
    try {
      runtime.pty.kill();
    } catch (error) {
      session.opts.logger.warn(
        `[agent-login-session] failed to kill the claude setup-token pty: ${errorMessage(error)}`,
      );
    }
  }
  const configDir = session.claudeConfigDir!;
  try {
    rmSync(configDir, { recursive: true, force: true });
  } catch (error) {
    session.opts.logger.warn(
      `[agent-login-session] failed to remove claude login temp dir ${configDir}: ${errorMessage(error)}`,
    );
  }
}

function checkExpiry(session: SessionRecord): void {
  if (session.status === 'installed' || session.status === 'failed') return;
  if (session.opts.now() < session.expiresAt) return;
  session.status = 'failed';
  session.error = 'This login session expired before it was completed.';
  if (session.provider === 'codex') {
    cleanupCodexTemp(session);
  } else {
    cleanupClaude(session);
  }
}

function backupIfExists(livePath: string, now: () => number): void {
  if (!existsSync(livePath)) return;
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  copyFileSync(livePath, `${livePath}.bak-${stamp}`);
}

function atomicWrite(path: string, contents: string): void {
  const tmpPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmpPath, contents, { mode: 0o600 });
  renameSync(tmpPath, path);
}

function installCodexAuth(authJson: string, opts: ResolvedOptions): void {
  mkdirSync(opts.codexInstallDir, { recursive: true });
  const livePath = join(opts.codexInstallDir, 'auth.json');
  backupIfExists(livePath, opts.now);
  atomicWrite(livePath, authJson);
}

function saveClaudeToken(token: string, opts: ResolvedOptions): void {
  mkdirSync(dirname(opts.secretsFilePath), { recursive: true });
  backupIfExists(opts.secretsFilePath, opts.now);
  const existingLines = existsSync(opts.secretsFilePath)
    ? readFileSync(opts.secretsFilePath, 'utf8').split('\n')
    : [];
  const kept = existingLines.filter(
    (line) => line.trim() !== '' && !line.startsWith('CLAUDE_CODE_OAUTH_TOKEN='),
  );
  kept.push(`CLAUDE_CODE_OAUTH_TOKEN=${token}`);
  atomicWrite(opts.secretsFilePath, `${kept.join('\n')}\n`);
}

async function distributeCodexToRemotes(authJson: string, opts: ResolvedOptions): Promise<void> {
  for (const target of opts.remoteTargets) {
    try {
      await opts.distributeToRemote(target, authJson);
      const ok = await opts.probeRemote(target);
      if (!ok) {
        opts.logger.warn(
          `[agent-login-session] codex login copied to ${target.name} but its test call did not pass.`,
          { target: target.name },
        );
      }
    } catch (error) {
      opts.logger.error(
        `[agent-login-session] failed to distribute the new codex login to ${target.name}: ${errorMessage(error)}`,
        { target: target.name },
      );
    }
  }
}

function probeCodex(codexHome: string, opts: ResolvedOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const env = buildProbeEnv(opts.env, { CODEX_HOME: codexHome });
    const child = opts.spawnCommand('codex', ['exec', '--skip-git-repo-check', AGENT_LOGIN_SESSION_PROBE_PROMPT], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killChild(child, opts.logger);
      resolve(false);
    }, opts.probeTimeoutMs);
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function probeClaude(token: string, opts: ResolvedOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const env = buildProbeEnv(opts.env, { CLAUDE_CODE_OAUTH_TOKEN: token });
    const child = opts.spawnCommand('claude', ['-p', AGENT_LOGIN_SESSION_PROBE_PROMPT], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killChild(child, opts.logger);
      resolve(false);
    }, opts.probeTimeoutMs);
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function startCodexLogin(session: SessionRecord): Promise<void> {
  const opts = session.opts;
  const codexHome = opts.makeTempDir('invoker-codex-login-');
  session.codexHome = codexHome;
  const env = buildProbeEnv(opts.env, { CODEX_HOME: codexHome });
  const child = opts.spawnCommand('codex', ['login', '--device-auth'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const runtime: CodexRuntime = { buffer: '' };
  session.codexRuntime = runtime;

  const onChunk = (chunk: Buffer | string): void => { runtime.buffer += chunk.toString(); };
  child.stdout?.on('data', onChunk);
  child.stderr?.on('data', onChunk);
  child.once('exit', (code) => { runtime.exitCode = code ?? -1; });
  child.once('error', (error) => {
    runtime.exitCode = runtime.exitCode ?? -1;
    opts.logger.error(`[agent-login-session] codex login --device-auth failed to spawn: ${errorMessage(error)}`);
  });

  const parsed = await new Promise<{ url: string; code: string } | null>((resolve) => {
    let settled = false;
    const finish = (value: { url: string; code: string } | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(parseCodexDeviceAuthOutput(runtime.buffer)), opts.deviceAuthParseTimeoutMs);
    const checkNow = (): void => {
      const found = parseCodexDeviceAuthOutput(runtime.buffer);
      if (found) finish(found);
    };
    child.stdout?.on('data', checkNow);
    child.stderr?.on('data', checkNow);
    child.once('exit', () => finish(parseCodexDeviceAuthOutput(runtime.buffer)));
  });

  if (!parsed) {
    session.status = 'failed';
    session.error = 'Could not find a device authorization URL and code in the codex output.';
    killChild(child, opts.logger);
    cleanupCodexTemp(session);
    return;
  }
  session.url = parsed.url;
  session.deviceCode = parsed.code;
  session.status = 'awaiting_user';
}

async function pollCodexCompletion(session: SessionRecord): Promise<void> {
  const runtime = session.codexRuntime;
  if (!runtime || runtime.exitCode === undefined) return;

  if (runtime.exitCode !== 0) {
    session.status = 'failed';
    session.error = `codex login --device-auth exited with code ${runtime.exitCode}.`;
    cleanupCodexTemp(session);
    return;
  }

  session.status = 'verifying';
  let authJson: string;
  try {
    authJson = readFileSync(join(session.codexHome!, 'auth.json'), 'utf8');
  } catch (error) {
    session.status = 'failed';
    session.error = 'codex login exited 0 but wrote no auth.json.';
    session.opts.logger.error(`[agent-login-session] ${session.error} (${errorMessage(error)})`);
    cleanupCodexTemp(session);
    return;
  }

  const ok = await probeCodex(session.codexHome!, session.opts);
  if (!ok) {
    session.status = 'failed';
    session.error = 'The new Codex login did not pass its test call.';
    cleanupCodexTemp(session);
    return;
  }

  installCodexAuth(authJson, session.opts);
  await distributeCodexToRemotes(authJson, session.opts);
  session.status = 'installed';
  cleanupCodexTemp(session);
}

function notifyClaudeWaiters(runtime: ClaudeRuntime): void {
  const remaining: ClaudeWaiter[] = [];
  for (const waiter of runtime.waiters) {
    const found = waiter.matcher(runtime.buffer);
    if (found !== null || runtime.exitCode !== undefined) {
      waiter.resolve(found);
    } else {
      remaining.push(waiter);
    }
  }
  runtime.waiters = remaining;
}

function waitForClaudeMatch(
  runtime: ClaudeRuntime,
  matcher: (buffer: string) => string | null,
  timeoutMs: number,
): Promise<string | null> {
  const immediate = matcher(runtime.buffer);
  if (immediate !== null) return Promise.resolve(immediate);
  if (runtime.exitCode !== undefined) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    const waiter: ClaudeWaiter = {
      matcher,
      resolve: (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      runtime.waiters = runtime.waiters.filter((entry) => entry !== waiter);
      resolve(null);
    }, timeoutMs);
    runtime.waiters.push(waiter);
  });
}

async function startClaudeLogin(session: SessionRecord): Promise<void> {
  const opts = session.opts;
  const configDir = opts.makeTempDir('invoker-claude-login-');
  session.claudeConfigDir = configDir;
  const env = buildProbeEnv(opts.env, { CLAUDE_CONFIG_DIR: configDir });
  const ptySpawn = resolvePtySpawn(opts);
  const forkOptions: PtyForkOptionsLike = {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: opts.cwd,
    env,
  };
  const pty = ptySpawn('claude', ['setup-token'], forkOptions);
  const runtime: ClaudeRuntime = { pty, buffer: '', waiters: [] };
  session.claudeRuntime = runtime;

  pty.onData((chunk) => {
    runtime.buffer += chunk;
    notifyClaudeWaiters(runtime);
  });
  pty.onExit(({ exitCode }) => {
    runtime.exitCode = exitCode;
    notifyClaudeWaiters(runtime);
  });

  const url = await waitForClaudeMatch(runtime, parseClaudeSetupTokenUrl, opts.claudeUrlTimeoutMs);
  if (url === null) {
    session.status = 'failed';
    session.error = 'Could not find an authorization URL in the claude setup-token output.';
    cleanupClaude(session);
    return;
  }
  session.url = url;
  session.status = 'awaiting_code';
}

async function continueClaudeLogin(session: SessionRecord, code: string): Promise<void> {
  const opts = session.opts;
  const runtime = session.claudeRuntime!;
  session.status = 'verifying';
  runtime.pty.write(`${code}\n`);

  const token = await waitForClaudeMatch(runtime, parseClaudeSetupTokenValue, opts.claudeTokenTimeoutMs);
  if (token === null) {
    session.status = 'failed';
    session.error = 'Did not receive a Claude OAuth token after submitting the code.';
    cleanupClaude(session);
    return;
  }

  const ok = await probeClaude(token, opts);
  if (!ok) {
    session.status = 'failed';
    session.error = 'The new Claude login did not pass its test call.';
    cleanupClaude(session);
    return;
  }

  saveClaudeToken(token, opts);
  session.status = 'installed';
  cleanupClaude(session);
}

export async function startAgentLogin(
  provider: AgentLoginProvider,
  options: AgentLoginSessionOptions = {},
): Promise<AgentLoginSessionView> {
  const opts = normalizeOptions(options);
  const createdAt = opts.now();
  const session: SessionRecord = {
    id: randomUUID(),
    provider,
    status: 'starting',
    createdAt,
    expiresAt: createdAt + (options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS),
    opts,
  };
  sessions.set(session.id, session);

  if (provider === 'codex') {
    await startCodexLogin(session);
  } else {
    await startClaudeLogin(session);
  }
  return toView(session);
}

export async function getAgentLoginStatus(sessionId: string): Promise<AgentLoginSessionView> {
  const session = requireSession(sessionId);
  checkExpiry(session);
  if (session.provider === 'codex' && session.status === 'awaiting_user') {
    await pollCodexCompletion(session);
  }
  return toView(session);
}

export async function submitAgentLoginCode(sessionId: string, code: string): Promise<AgentLoginSessionView> {
  const session = requireSession(sessionId);
  checkExpiry(session);
  if (session.status === 'installed' || session.status === 'failed') return toView(session);
  if (session.provider !== 'claude' || session.status !== 'awaiting_code') {
    throw new Error(
      `Session "${sessionId}" is not awaiting a pasted code (provider=${session.provider}, status=${session.status}).`,
    );
  }
  await continueClaudeLogin(session, code);
  return toView(session);
}
