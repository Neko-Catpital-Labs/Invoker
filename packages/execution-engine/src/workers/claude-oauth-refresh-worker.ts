import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { Logger } from '@invoker/contracts';

import { resolveClaudeWorkerConfigDir } from '../agents/claude-execution-agent.js';

import {
  parseClaudeOauthBlob,
  isOauthTokenExpiring,
  refreshClaudeOauthCredentials,
  type OauthFetchFn,
} from '../claude-oauth-refresh.js';
import {
  isCodexAuthExpiring,
  refreshCodexOauthCredentials,
  resolveCodexAuthPath,
} from '../codex-oauth-refresh.js';
import { recordWorkerDecisionRow, type WorkerDecisionStore } from '../worker-decision-ledger.js';
import { execRemoteCapture } from '../ssh-git-exec.js';
import { buildSshConnectionArgs } from '../ssh-transport-options.js';
import type { SshTargetConnection } from '../ssh-transport-options.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const CLAUDE_OAUTH_REFRESH_WORKER_KIND = 'claude-oauth-refresh';
export const DEFAULT_CLAUDE_OAUTH_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_CODEX_REMOTE_AUTH_PATH = '~/.codex/auth.json';
const DEFAULT_CLAUDE_REMOTE_CREDENTIALS_PATH = '~/.claude/.credentials.json';

export interface ClaudeOauthRefreshTarget {
  name: string;
  connection: SshTargetConnection;
  /** Absolute remote path to the credentials file. Defaults to ~/.claude/.credentials.json on that host. */
  remotePath?: string;
}

export interface ClaudeOauthRefreshWorkerConfig {
  /** Local credentials file path. Defaults to ~/.claude/.credentials.json. */
  credentialsPath?: string;
  workerCredentialsPath?: string;
  refreshLeadMs?: number;
  remoteTargets?: ClaudeOauthRefreshTarget[];
  intervalMs?: number;
  tickOnStart?: boolean;
  store?: WorkerDecisionStore;

  /** Test seams. */
  readCredentials?: (path: string) => string;
  /** Reads a remote target's own credentials file. Null means unreadable (missing, unparseable, or an SSH failure). */
  readRemoteCredentials?: (target: ClaudeOauthRefreshTarget) => Promise<string | null>;
  writeCredentials?: (path: string, contents: string) => void;
  refreshFn?: (credentialsJson: string) => Promise<string | null>;
  distributeFn?: (target: ClaudeOauthRefreshTarget, credentialsJson: string) => Promise<void>;
  /** Local Codex auth.json path. Defaults to $CODEX_HOME/auth.json or ~/.codex/auth.json. */
  codexAuthPath?: string;
  readCodexCredentials?: (path: string) => string;
  readRemoteCodexCredentials?: (target: ClaudeOauthRefreshTarget) => Promise<string | null>;
  writeCodexCredentials?: (path: string, contents: string) => void;
  refreshCodexFn?: (authJson: string) => Promise<string | null>;
  distributeCodexFn?: (target: ClaudeOauthRefreshTarget, authJson: string) => Promise<void>;
  fetchFn?: OauthFetchFn;
  now?: () => number;
  onTick?: WorkerTick;
}

export interface ClaudeOauthRefreshWorkerOptions {
  logger: Logger;
  credentialsPath: string;
  workerCredentialsPath?: string;
  refreshLeadMs?: number;
  remoteTargets: ClaudeOauthRefreshTarget[];
  intervalMs?: number;
  tickOnStart?: boolean;
  store?: WorkerDecisionStore;
  readCredentials?: (path: string) => string;
  readRemoteCredentials?: (target: ClaudeOauthRefreshTarget) => Promise<string | null>;
  writeCredentials?: (path: string, contents: string) => void;
  refreshFn?: (credentialsJson: string) => Promise<string | null>;
  distributeFn?: (target: ClaudeOauthRefreshTarget, credentialsJson: string) => Promise<void>;
  now?: () => number;
  onTick?: WorkerTick;
}

export interface CodexOauthRefreshWorkerOptions {
  logger: Logger;
  authPath: string;
  remoteTargets: ClaudeOauthRefreshTarget[];
  store?: WorkerDecisionStore;
  readCredentials?: (path: string) => string;
  readRemoteCredentials?: (target: ClaudeOauthRefreshTarget) => Promise<string | null>;
  writeCredentials?: (path: string, contents: string) => void;
  refreshFn?: (authJson: string) => Promise<string | null>;
  distributeFn?: (target: ClaudeOauthRefreshTarget, authJson: string) => Promise<void>;
  now?: () => number;
}

export function resolveClaudeCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.INVOKER_CLAUDE_CREDENTIALS_PATH?.trim() || join(homedir(), '.claude', '.credentials.json');
}

function defaultReadCredentials(path: string): string {
  return readFileSync(path, 'utf8');
}

function defaultWriteCredentials(path: string, contents: string): void {
  // Atomic write: a crash or concurrent read mid-write must never observe a
  // truncated credentials file -- write to a sibling temp path, then rename,
  // which is atomic on the same filesystem.
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tmpPath, contents, { mode: 0o600 });
  renameSync(tmpPath, path);
}

function remotePathAssignment(remotePath: string): string {
  if (remotePath === '~') return 'REMOTE_PATH="$HOME"';
  if (remotePath.startsWith('~/')) return `REMOTE_PATH="$HOME/${remotePath.slice(2)}"`;
  return `REMOTE_PATH="${remotePath}"`;
}

export function buildReadCredentialsScript(remotePath: string): string {
  return `${remotePathAssignment(remotePath)}
cat "$REMOTE_PATH" 2>/dev/null || true`;
}

async function defaultReadRemoteFile(target: ClaudeOauthRefreshTarget, remotePath: string, phase: string): Promise<string | null> {
  const sshArgs = buildSshConnectionArgs(target.connection, { batchMode: true });
  const output = await execRemoteCapture({
    sshArgs,
    script: buildReadCredentialsScript(remotePath),
    phase,
  });
  return output.trim() ? output : null;
}

async function defaultReadRemoteCredentials(target: ClaudeOauthRefreshTarget): Promise<string | null> {
  return defaultReadRemoteFile(
    target,
    target.remotePath ?? DEFAULT_CLAUDE_REMOTE_CREDENTIALS_PATH,
    `claude-oauth-refresh-check:${target.name}`,
  );
}

async function defaultReadRemoteCodexCredentials(target: ClaudeOauthRefreshTarget): Promise<string | null> {
  return defaultReadRemoteFile(
    target,
    DEFAULT_CODEX_REMOTE_AUTH_PATH,
    `codex-oauth-refresh-check:${target.name}`,
  );
}

function recordDecision(
  store: WorkerDecisionStore | undefined,
  externalKey: string,
  status: 'completed' | 'failed' | 'skipped',
  summary: string,
  payload: Record<string, unknown> = {},
): void {
  if (!store) return;
  recordWorkerDecisionRow(store, {
    workerKind: CLAUDE_OAUTH_REFRESH_WORKER_KIND,
    actionType: 'oauth-refresh',
    externalKey,
    subjectType: 'credentials',
    subjectId: externalKey,
    status,
    summary,
    payload,
  });
}

function hasClaudeAccessToken(credentialsJson: string): boolean {
  const accessToken = parseClaudeOauthBlob(credentialsJson)?.accessToken;
  return typeof accessToken === 'string' && accessToken.trim() !== '';
}

function describeRemoteClaudeCredentials(remoteJson: string | null, now: number): string | null {
  if (remoteJson === null) return 'unreadable or missing';
  if (!hasClaudeAccessToken(remoteJson)) return 'logged out (no access token)';
  if (isOauthTokenExpiring(remoteJson, now)) return 'expired or expiring';
  return null;
}

function describeRemoteCodexCredentials(remoteJson: string | null, now: number): string | null {
  if (remoteJson === null) return 'unreadable or missing';
  if (isCodexAuthExpiring(remoteJson, now)) return 'expired or expiring';
  return null;
}

function recordRemoteLoginNeedsAttention(
  options: { logger: Logger; store?: WorkerDecisionStore },
  target: ClaudeOauthRefreshTarget,
  agent: 'Claude' | 'Codex',
  reason: string,
  subjectId: string,
): void {
  const summary = `${agent} login on ${target.name} needs per-host login attention: ${reason}`;
  options.logger.info(`[${CLAUDE_OAUTH_REFRESH_WORKER_KIND}] ${summary}`, {
    module: CLAUDE_OAUTH_REFRESH_WORKER_KIND,
    target: target.name,
  });
  recordDecision(options.store, subjectId, 'skipped', summary, { target: target.name, agent, reason });
}

async function recordRemoteClaudeLoginStates(
  options: ClaudeOauthRefreshWorkerOptions,
  readRemoteCredentials: (target: ClaudeOauthRefreshTarget) => Promise<string | null>,
  now: () => number,
): Promise<void> {
  for (const target of options.remoteTargets) {
    let remoteJson: string | null;
    try {
      remoteJson = await readRemoteCredentials(target);
    } catch (error) {
      options.logger.error(`[${CLAUDE_OAUTH_REFRESH_WORKER_KIND}] failed to read remote credentials for ${target.name}: ${error instanceof Error ? error.message : String(error)}`, {
        module: CLAUDE_OAUTH_REFRESH_WORKER_KIND,
        target: target.name,
      });
      remoteJson = null;
    }
    const staleReason = describeRemoteClaudeCredentials(remoteJson, now());
    if (staleReason !== null) {
      recordRemoteLoginNeedsAttention(options, target, 'Claude', staleReason, target.name);
    }
  }
}

async function recordRemoteCodexLoginStates(
  options: CodexOauthRefreshWorkerOptions,
  readRemoteCredentials: (target: ClaudeOauthRefreshTarget) => Promise<string | null>,
  now: () => number,
): Promise<void> {
  for (const target of options.remoteTargets) {
    let remoteJson: string | null;
    try {
      remoteJson = await readRemoteCredentials(target);
    } catch (error) {
      options.logger.error(`[${CLAUDE_OAUTH_REFRESH_WORKER_KIND}] failed to read remote Codex auth for ${target.name}: ${error instanceof Error ? error.message : String(error)}`, {
        module: CLAUDE_OAUTH_REFRESH_WORKER_KIND,
        target: target.name,
      });
      remoteJson = null;
    }
    const staleReason = describeRemoteCodexCredentials(remoteJson, now());
    if (staleReason !== null) {
      recordRemoteLoginNeedsAttention(options, target, 'Codex', staleReason, `codex:${target.name}`);
    }
  }
}

export function resolveClaudeWorkerCredentialsPath(): string {
  return join(resolveClaudeWorkerConfigDir(), '.credentials.json');
}

function usableClaudeExpiry(credentialsJson: string | null): number {
  if (credentialsJson === null || !hasClaudeAccessToken(credentialsJson)) return Number.NEGATIVE_INFINITY;
  const expiresAt = parseClaudeOauthBlob(credentialsJson)?.expiresAt;
  return typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? expiresAt : Number.NEGATIVE_INFINITY;
}

function reconcileWorkerCredentialsCopy(
  options: ClaudeOauthRefreshWorkerOptions,
  readCredentials: (path: string) => string,
  writeCredentials: (path: string, contents: string) => void,
  ownerJson: string,
): string {
  const workerPath = options.workerCredentialsPath;
  if (!workerPath || workerPath === options.credentialsPath) return ownerJson;

  let workerJson: string | null;
  try {
    workerJson = readCredentials(workerPath);
  } catch (error) {
    options.logger.warn(`[${CLAUDE_OAUTH_REFRESH_WORKER_KIND}] could not read worker credentials ${workerPath}; treating it as missing: ${error instanceof Error ? error.message : String(error)}`, {
      module: CLAUDE_OAUTH_REFRESH_WORKER_KIND,
    });
    workerJson = null;
  }
  if (workerJson === ownerJson) return ownerJson;

  const ownerExpiry = usableClaudeExpiry(ownerJson);
  const workerExpiry = usableClaudeExpiry(workerJson);
  if (ownerExpiry === Number.NEGATIVE_INFINITY && workerExpiry === Number.NEGATIVE_INFINITY) return ownerJson;

  const [fromPath, toPath, winner] = workerExpiry > ownerExpiry
    ? [workerPath, options.credentialsPath, workerJson as string]
    : [options.credentialsPath, workerPath, ownerJson];
  try {
    writeCredentials(toPath, winner);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    options.logger.error(`[${CLAUDE_OAUTH_REFRESH_WORKER_KIND}] failed to copy credentials from ${fromPath} to ${toPath}: ${detail}`, {
      module: CLAUDE_OAUTH_REFRESH_WORKER_KIND,
    });
    recordDecision(options.store, 'local-worker-copy', 'failed', `Failed to copy credentials from ${fromPath} to ${toPath}: ${detail}`);
    return ownerJson;
  }
  options.logger.info(`[${CLAUDE_OAUTH_REFRESH_WORKER_KIND}] copied newer credentials from ${fromPath} to ${toPath}`, {
    module: CLAUDE_OAUTH_REFRESH_WORKER_KIND,
  });
  recordDecision(options.store, 'local-worker-copy', 'completed', `Copied newer credentials from ${fromPath} to ${toPath}`);
  return winner;
}

export async function runClaudeOauthRefreshCheck(options: ClaudeOauthRefreshWorkerOptions): Promise<void> {
  const readCredentials = options.readCredentials ?? defaultReadCredentials;
  const readRemoteCredentials = options.readRemoteCredentials ?? defaultReadRemoteCredentials;
  const writeCredentials = options.writeCredentials ?? defaultWriteCredentials;
  const now = options.now ?? Date.now;

  let credentialsJson: string;
  try {
    credentialsJson = readCredentials(options.credentialsPath);
  } catch (error) {
    options.logger.error(`[${CLAUDE_OAUTH_REFRESH_WORKER_KIND}] failed to read ${options.credentialsPath}: ${error instanceof Error ? error.message : String(error)}`, {
      module: CLAUDE_OAUTH_REFRESH_WORKER_KIND,
    });
    return;
  }

  credentialsJson = reconcileWorkerCredentialsCopy(options, readCredentials, writeCredentials, credentialsJson);

  if (!isOauthTokenExpiring(credentialsJson, now() + (options.refreshLeadMs ?? 0))) {
    if (!hasClaudeAccessToken(credentialsJson)) {
      options.logger.error(`[${CLAUDE_OAUTH_REFRESH_WORKER_KIND}] ${options.credentialsPath} holds no access token; remote login state checks skipped`, {
        module: CLAUDE_OAUTH_REFRESH_WORKER_KIND,
      });
      recordDecision(options.store, 'local', 'failed', 'Local Claude credentials hold no access token; remote login state checks skipped');
      return;
    }
    await recordRemoteClaudeLoginStates(options, readRemoteCredentials, now);
    return;
  }

  const refresh = options.refreshFn ?? ((json: string) => refreshClaudeOauthCredentials(json, { now: now() }));
  const refreshed = await refresh(credentialsJson);
  if (!refreshed) {
    options.logger.error(`[${CLAUDE_OAUTH_REFRESH_WORKER_KIND}] token refresh failed for ${options.credentialsPath}; leaving existing credentials in place`, {
      module: CLAUDE_OAUTH_REFRESH_WORKER_KIND,
    });
    recordDecision(options.store, 'local', 'failed', 'OAuth token refresh request failed');
    return;
  }

  writeCredentials(options.credentialsPath, refreshed);
  recordDecision(options.store, 'local', 'completed', 'Refreshed local Claude OAuth credentials');
  reconcileWorkerCredentialsCopy(options, readCredentials, writeCredentials, refreshed);
  options.logger.info(`[${CLAUDE_OAUTH_REFRESH_WORKER_KIND}] refreshed local credentials`, {
    module: CLAUDE_OAUTH_REFRESH_WORKER_KIND,
  });

  await recordRemoteClaudeLoginStates(options, readRemoteCredentials, now);
}

export async function runCodexOauthRefreshCheck(options: CodexOauthRefreshWorkerOptions): Promise<void> {
  const readCredentials = options.readCredentials ?? defaultReadCredentials;
  const readRemoteCredentials = options.readRemoteCredentials ?? defaultReadRemoteCodexCredentials;
  const writeCredentials = options.writeCredentials ?? defaultWriteCredentials;
  const now = options.now ?? Date.now;

  let authJson: string;
  try {
    authJson = readCredentials(options.authPath);
  } catch (error) {
    options.logger.error(`[${CLAUDE_OAUTH_REFRESH_WORKER_KIND}] failed to read ${options.authPath}: ${error instanceof Error ? error.message : String(error)}`, {
      module: CLAUDE_OAUTH_REFRESH_WORKER_KIND,
    });
    return;
  }

  if (!isCodexAuthExpiring(authJson, now())) {
    await recordRemoteCodexLoginStates(options, readRemoteCredentials, now);
    return;
  }

  const refresh = options.refreshFn ?? ((json: string) => refreshCodexOauthCredentials(json, { now: now() }));
  const refreshed = await refresh(authJson);
  if (!refreshed) {
    options.logger.error(`[${CLAUDE_OAUTH_REFRESH_WORKER_KIND}] Codex token refresh failed for ${options.authPath}; leaving existing auth in place`, {
      module: CLAUDE_OAUTH_REFRESH_WORKER_KIND,
    });
    recordDecision(options.store, 'codex:local', 'failed', 'Codex OAuth token refresh request failed');
    return;
  }

  writeCredentials(options.authPath, refreshed);
  recordDecision(options.store, 'codex:local', 'completed', 'Refreshed local Codex OAuth credentials');
  options.logger.info(`[${CLAUDE_OAUTH_REFRESH_WORKER_KIND}] refreshed local Codex auth`, {
    module: CLAUDE_OAUTH_REFRESH_WORKER_KIND,
  });

  await recordRemoteCodexLoginStates(options, readRemoteCredentials, now);
}

export async function runClaudeAndCodexOauthRefreshCheck(
  claude: ClaudeOauthRefreshWorkerOptions,
  codex: CodexOauthRefreshWorkerOptions,
): Promise<void> {
  try {
    await runClaudeOauthRefreshCheck(claude);
  } catch (error) {
    claude.logger.error(`[${CLAUDE_OAUTH_REFRESH_WORKER_KIND}] Claude pass threw: ${error instanceof Error ? error.message : String(error)}`, {
      module: CLAUDE_OAUTH_REFRESH_WORKER_KIND,
    });
  }
  try {
    await runCodexOauthRefreshCheck(codex);
  } catch (error) {
    codex.logger.error(`[${CLAUDE_OAUTH_REFRESH_WORKER_KIND}] Codex pass threw: ${error instanceof Error ? error.message : String(error)}`, {
      module: CLAUDE_OAUTH_REFRESH_WORKER_KIND,
    });
  }
}

export function createClaudeOauthRefreshWorker(config: ClaudeOauthRefreshWorkerConfig & { logger: Logger }): WorkerRuntime {
  const options: ClaudeOauthRefreshWorkerOptions = {
    logger: config.logger,
    credentialsPath: config.credentialsPath ?? resolveClaudeCredentialsPath(),
    workerCredentialsPath: config.workerCredentialsPath,
    refreshLeadMs: config.refreshLeadMs ?? config.intervalMs ?? DEFAULT_CLAUDE_OAUTH_REFRESH_INTERVAL_MS,
    remoteTargets: config.remoteTargets ?? [],
    store: config.store,
    readCredentials: config.readCredentials,
    readRemoteCredentials: config.readRemoteCredentials,
    writeCredentials: config.writeCredentials,
    refreshFn: config.refreshFn ?? (config.fetchFn
      ? (json: string) => refreshClaudeOauthCredentials(json, { fetchFn: config.fetchFn, now: config.now?.() })
      : undefined),
    distributeFn: config.distributeFn,
    now: config.now,
  };
  const codexOptions: CodexOauthRefreshWorkerOptions = {
    logger: config.logger,
    authPath: config.codexAuthPath ?? resolveCodexAuthPath(),
    remoteTargets: config.remoteTargets ?? [],
    store: config.store,
    readCredentials: config.readCodexCredentials,
    readRemoteCredentials: config.readRemoteCodexCredentials,
    writeCredentials: config.writeCodexCredentials,
    refreshFn: config.refreshCodexFn ?? (config.fetchFn
      ? (json: string) => refreshCodexOauthCredentials(json, { fetchFn: config.fetchFn, now: config.now?.() })
      : undefined),
    distributeFn: config.distributeCodexFn,
    now: config.now,
  };
  const onTick: WorkerTick = config.onTick ?? (async () => {
    await runClaudeAndCodexOauthRefreshCheck(options, codexOptions);
  });
  return createWorkerRuntime({
    kind: CLAUDE_OAUTH_REFRESH_WORKER_KIND,
    logger: config.logger,
    onTick,
    intervalMs: config.intervalMs ?? DEFAULT_CLAUDE_OAUTH_REFRESH_INTERVAL_MS,
    tickOnStart: config.tickOnStart ?? true,
  });
}

export function registerClaudeOauthRefreshWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: CLAUDE_OAUTH_REFRESH_WORKER_KIND,
    note: 'Refreshes this owner\'s Claude Code OAuth credentials before they expire and records remote login files that need per-host attention.',
    source: 'built-in',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createClaudeOauthRefreshWorker({
        logger: deps.logger,
        workerCredentialsPath: resolveClaudeWorkerCredentialsPath(),
        ...deps.claudeOauthRefresh,
      }),
  });
  return registry;
}
