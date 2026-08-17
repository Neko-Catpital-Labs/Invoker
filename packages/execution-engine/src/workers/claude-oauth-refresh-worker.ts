import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Logger } from '@invoker/contracts';

import {
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
import { base64Encode, execRemoteCapture } from '../ssh-git-exec.js';
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
  const tmpPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tmpPath, contents, { mode: 0o600 });
  renameSync(tmpPath, path);
}

function buildPortableBase64DecodeFunction(functionName = 'invoker_base64_decode'): string {
  return `${functionName}() {
  if base64 --decode </dev/null >/dev/null 2>&1; then
    base64 --decode
  elif base64 -d </dev/null >/dev/null 2>&1; then
    base64 -d
  else
    base64 -D
  fi
}`;
}

export function buildDistributeCredentialsScript(remotePath: string, credentialsJson: string): string {
  const contentB64 = base64Encode(credentialsJson);
  return `set -euo pipefail
${buildPortableBase64DecodeFunction()}
REMOTE_PATH="${remotePath}"
mkdir -p "$(dirname "$REMOTE_PATH")"
TMP_PATH="$REMOTE_PATH.tmp-$$"
printf '%s' '${contentB64}' | invoker_base64_decode > "$TMP_PATH"
chmod 600 "$TMP_PATH"
mv "$TMP_PATH" "$REMOTE_PATH"`;
}

function defaultDistributeToPath(
  target: ClaudeOauthRefreshTarget,
  credentialsJson: string,
  remotePath: string,
  phase: string,
): Promise<void> {
  const sshArgs = buildSshConnectionArgs(target.connection, { batchMode: true });
  return execRemoteCapture({
    sshArgs,
    script: buildDistributeCredentialsScript(remotePath, credentialsJson),
    phase,
  }).then(() => undefined);
}

function defaultDistribute(target: ClaudeOauthRefreshTarget, credentialsJson: string): Promise<void> {
  return defaultDistributeToPath(
    target,
    credentialsJson,
    target.remotePath ?? DEFAULT_CLAUDE_REMOTE_CREDENTIALS_PATH,
    `claude-oauth-refresh:${target.name}`,
  );
}

function defaultDistributeCodex(target: ClaudeOauthRefreshTarget, authJson: string): Promise<void> {
  return defaultDistributeToPath(
    target,
    authJson,
    DEFAULT_CODEX_REMOTE_AUTH_PATH,
    `codex-oauth-refresh:${target.name}`,
  );
}

async function defaultReadRemoteFile(target: ClaudeOauthRefreshTarget, remotePath: string, phase: string): Promise<string | null> {
  const sshArgs = buildSshConnectionArgs(target.connection, { batchMode: true });
  try {
    const output = await execRemoteCapture({
      sshArgs,
      script: `cat "${remotePath}" 2>/dev/null || true`,
      phase,
    });
    return output.trim() ? output : null;
  } catch {
    return null;
  }
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

async function distributeToTarget(
  options: { logger: Logger; store?: WorkerDecisionStore },
  distribute: (target: ClaudeOauthRefreshTarget, contents: string) => Promise<void>,
  target: ClaudeOauthRefreshTarget,
  credentialsJson: string,
  summary: string,
  subjectId: string = target.name,
): Promise<void> {
  try {
    await distribute(target, credentialsJson);
    recordDecision(options.store, subjectId, 'completed', summary);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    options.logger.error(`[${CLAUDE_OAUTH_REFRESH_WORKER_KIND}] failed to distribute to ${target.name}: ${detail}`, {
      module: CLAUDE_OAUTH_REFRESH_WORKER_KIND,
      target: target.name,
    });
    recordDecision(options.store, subjectId, 'failed', `Failed to distribute credentials to ${target.name}: ${detail}`);
  }
}

export async function runClaudeOauthRefreshCheck(options: ClaudeOauthRefreshWorkerOptions): Promise<void> {
  const readCredentials = options.readCredentials ?? defaultReadCredentials;
  const readRemoteCredentials = options.readRemoteCredentials ?? defaultReadRemoteCredentials;
  const writeCredentials = options.writeCredentials ?? defaultWriteCredentials;
  const distribute = options.distributeFn ?? defaultDistribute;
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

  if (!isOauthTokenExpiring(credentialsJson, now())) {
    // The owner's own token can stay healthy (refreshed by its own live CLI
    // usage) for a long time while a remote target's separate copy silently
    // expires on its own clock -- checked here, independently of the local
    // refresh cycle above, so redistribution isn't gated on the local token
    // ever needing a refresh of its own.
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
      const remoteNeedsDistribution = remoteJson === null || isOauthTokenExpiring(remoteJson, now());
      if (!remoteNeedsDistribution) continue;
      await distributeToTarget(options, distribute, target, credentialsJson, `Distributed current credentials to ${target.name} (its own copy was stale)`);
    }
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
  options.logger.info(`[${CLAUDE_OAUTH_REFRESH_WORKER_KIND}] refreshed local credentials`, {
    module: CLAUDE_OAUTH_REFRESH_WORKER_KIND,
  });

  for (const target of options.remoteTargets) {
    await distributeToTarget(options, distribute, target, refreshed, `Distributed refreshed credentials to ${target.name}`);
  }
}

export async function runCodexOauthRefreshCheck(options: CodexOauthRefreshWorkerOptions): Promise<void> {
  const readCredentials = options.readCredentials ?? defaultReadCredentials;
  const readRemoteCredentials = options.readRemoteCredentials ?? defaultReadRemoteCodexCredentials;
  const writeCredentials = options.writeCredentials ?? defaultWriteCredentials;
  const distribute = options.distributeFn ?? defaultDistributeCodex;
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
      const remoteNeedsDistribution = remoteJson === null || isCodexAuthExpiring(remoteJson, now());
      if (!remoteNeedsDistribution) continue;
      await distributeToTarget(
        options,
        distribute,
        target,
        authJson,
        `Distributed current Codex auth to ${target.name} (its own copy was stale)`,
        `codex:${target.name}`,
      );
    }
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

  for (const target of options.remoteTargets) {
    await distributeToTarget(
      options,
      distribute,
      target,
      refreshed,
      `Distributed refreshed Codex auth to ${target.name}`,
      `codex:${target.name}`,
    );
  }
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
    note: 'Refreshes this owner\'s Claude Code OAuth credentials before they expire and distributes them to every SSH pool member.',
    source: 'built-in',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createClaudeOauthRefreshWorker({
        logger: deps.logger,
        ...deps.claudeOauthRefresh,
      }),
  });
  return registry;
}
