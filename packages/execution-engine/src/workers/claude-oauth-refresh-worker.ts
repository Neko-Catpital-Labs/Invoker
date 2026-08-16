import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Logger } from '@invoker/contracts';

import {
  isOauthTokenExpiring,
  refreshClaudeOauthCredentials,
  type OauthFetchFn,
} from '../claude-oauth-refresh.js';
import { recordWorkerDecisionRow, type WorkerDecisionStore } from '../worker-decision-ledger.js';
import { base64Encode, execRemoteCapture } from '../ssh-git-exec.js';
import { buildSshConnectionArgs } from '../ssh-transport-options.js';
import type { SshTargetConnection } from '../ssh-transport-options.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const CLAUDE_OAUTH_REFRESH_WORKER_KIND = 'claude-oauth-refresh';
export const DEFAULT_CLAUDE_OAUTH_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

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
  writeCredentials?: (path: string, contents: string) => void;
  refreshFn?: (credentialsJson: string) => Promise<string | null>;
  distributeFn?: (target: ClaudeOauthRefreshTarget, credentialsJson: string) => Promise<void>;
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
  writeCredentials?: (path: string, contents: string) => void;
  refreshFn?: (credentialsJson: string) => Promise<string | null>;
  distributeFn?: (target: ClaudeOauthRefreshTarget, credentialsJson: string) => Promise<void>;
  now?: () => number;
  onTick?: WorkerTick;
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

function defaultDistribute(target: ClaudeOauthRefreshTarget, credentialsJson: string): Promise<void> {
  const remotePath = target.remotePath ?? '~/.claude/.credentials.json';
  const sshArgs = buildSshConnectionArgs(target.connection, { batchMode: true });
  return execRemoteCapture({
    sshArgs,
    script: buildDistributeCredentialsScript(remotePath, credentialsJson),
    phase: `claude-oauth-refresh:${target.name}`,
  }).then(() => undefined);
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

export async function runClaudeOauthRefreshCheck(options: ClaudeOauthRefreshWorkerOptions): Promise<void> {
  const readCredentials = options.readCredentials ?? defaultReadCredentials;
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

  if (!isOauthTokenExpiring(credentialsJson, now())) return;

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
    try {
      await distribute(target, refreshed);
      recordDecision(options.store, target.name, 'completed', `Distributed refreshed credentials to ${target.name}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      options.logger.error(`[${CLAUDE_OAUTH_REFRESH_WORKER_KIND}] failed to distribute to ${target.name}: ${detail}`, {
        module: CLAUDE_OAUTH_REFRESH_WORKER_KIND,
        target: target.name,
      });
      recordDecision(options.store, target.name, 'failed', `Failed to distribute refreshed credentials to ${target.name}: ${detail}`);
    }
  }
}

export function createClaudeOauthRefreshWorker(config: ClaudeOauthRefreshWorkerConfig & { logger: Logger }): WorkerRuntime {
  const options: ClaudeOauthRefreshWorkerOptions = {
    logger: config.logger,
    credentialsPath: config.credentialsPath ?? resolveClaudeCredentialsPath(),
    remoteTargets: config.remoteTargets ?? [],
    store: config.store,
    readCredentials: config.readCredentials,
    writeCredentials: config.writeCredentials,
    refreshFn: config.refreshFn ?? (config.fetchFn
      ? (json: string) => refreshClaudeOauthCredentials(json, { fetchFn: config.fetchFn, now: config.now?.() })
      : undefined),
    distributeFn: config.distributeFn,
    now: config.now,
  };
  const onTick: WorkerTick = config.onTick ?? (async () => {
    await runClaudeOauthRefreshCheck(options);
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
