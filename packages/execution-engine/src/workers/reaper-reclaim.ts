import {
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Logger } from '@invoker/contracts';

import { buildSshConnectionArgs } from '../ssh-transport-options.js';
import { bashNormalizeTildePath, execRemoteCapture, shellPosixSingleQuote } from '../ssh-git-exec.js';

import type { RemoteDiskTarget } from './disk-headroom-monitor.js';
import {
  expandTildeHome,
  isDeletingOrphanName,
  isSafeInvokerHome,
  isSafeRemoteInvokerHomePath,
} from './disk-headroom-reclaim.js';

export const DELETING_ORPHAN_MIN_AGE_MS = 30 * 60 * 1000;
export const AUTOMATION_CHECKOUT_WORK_MIN_AGE_MS = 48 * 60 * 60 * 1000;
export const LOG_TRIM_THRESHOLD_BYTES = 100 * 1024 * 1024;
export const LOG_TRIM_KEEP_BYTES = 20 * 1024 * 1024;

export const AUTOMATION_CHECKOUT_WORK_DIRS = [
  'mergify-admin-requeue-work',
  'land-admin-bypass-work',
] as const;

export const INVOKER_LOG_FILE_NAMES = [
  'invoker.log',
  'gui.log',
] as const;

export const INVOKER_LARGE_LOG_GLOBS = [
  '*-trace.log',
  'ui-*-events.jsonl',
] as const;

const DEFAULT_INVOKER_HOME = '~/.invoker';
const SNAPSHOT_HELPERS_MODULE = '../../../app/src/delete-all-snapshot.ts';

export interface ReaperCleanupSummary {
  checked: number;
  removed: number;
  errors: string[];
}

export interface ReaperTargetCleanupResult extends ReaperCleanupSummary {
  targetKey: string;
  ok: boolean;
  reason: 'cleanup' | 'path-guard' | 'cleanup-error';
  detail?: string;
}

export interface CleanupDeletingOrphansOptions {
  invokerHome?: string;
  remoteTargets?: RemoteDiskTarget[];
  userHome?: string;
  nowMs?: number;
  minAgeMs?: number;
  logger?: Logger;
  runRemoteScript?: (target: RemoteDiskTarget, script: string) => Promise<string>;
}

export interface CleanupAutomationCheckoutWorkOptions {
  invokerHome?: string;
  userHome?: string;
  nowMs?: number;
  minAgeMs?: number;
  logger?: Logger;
}

export interface SnapshotPruneHelpers {
  pruneHourlySnapshots: (backupDir: string, retain: number) => number;
  hourlySnapshotRetention: () => number;
}

export interface PruneHourlySnapshotBackupsOptions {
  invokerHome?: string;
  userHome?: string;
  backupDir?: string;
  helpers?: SnapshotPruneHelpers;
  logger?: Logger;
}

export interface PruneHourlySnapshotBackupsResult extends ReaperCleanupSummary {
  backupDir: string;
  retain?: number;
}

export interface TrimInvokerLogFilesOptions {
  invokerHome?: string;
  userHome?: string;
  thresholdBytes?: number;
  keepBytes?: number;
  logFileNames?: readonly string[];
  logGlobs?: readonly string[];
  logger?: Logger;
}

export interface TrimInvokerLogFilesResult extends ReaperCleanupSummary {
  trimmed: number;
}

function resolvedInvokerHome(invokerHome: string | undefined, userHome: string): string {
  return expandTildeHome(invokerHome ?? DEFAULT_INVOKER_HOME, userHome);
}

function isOlderThan(mtimeMs: number, nowMs: number, minAgeMs: number): boolean {
  return nowMs - mtimeMs > minAgeMs;
}

function removePath(path: string, errors: string[]): boolean {
  try {
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch (err) {
    errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function cleanupImmediateChildren(opts: {
  parent: string;
  predicate: (name: string) => boolean;
  nowMs: number;
  minAgeMs: number;
  errors: string[];
}): { checked: number; removed: number } {
  if (!existsSync(opts.parent)) return { checked: 0, removed: 0 };

  let entries: string[];
  try {
    entries = readdirSync(opts.parent);
  } catch (err) {
    opts.errors.push(`readdir ${opts.parent}: ${err instanceof Error ? err.message : String(err)}`);
    return { checked: 0, removed: 0 };
  }

  let checked = 0;
  let removed = 0;
  for (const name of entries) {
    if (!opts.predicate(name)) continue;
    checked += 1;
    const path = join(opts.parent, name);
    try {
      const stats = lstatSync(path);
      if (!isOlderThan(stats.mtimeMs, opts.nowMs, opts.minAgeMs)) continue;
      if (removePath(path, opts.errors)) removed += 1;
    } catch (err) {
      opts.errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { checked, removed };
}

function cleanupLocalDeletingOrphans(opts: {
  invokerHome: string;
  userHome: string;
  nowMs: number;
  minAgeMs: number;
  logger?: Logger;
}): ReaperTargetCleanupResult {
  const home = resolvedInvokerHome(opts.invokerHome, opts.userHome);
  const targetKey = `local ${home}`;
  if (!isSafeInvokerHome(home, opts.userHome)) {
    return { targetKey, ok: false, reason: 'path-guard', checked: 0, removed: 0, errors: [], detail: home };
  }

  const errors: string[] = [];
  const { checked, removed } = cleanupImmediateChildren({
    parent: home,
    predicate: isDeletingOrphanName,
    nowMs: opts.nowMs,
    minAgeMs: opts.minAgeMs,
    errors,
  });

  if (errors.length > 0) {
    opts.logger?.warn?.('[reaper-reclaim] local deleting-orphan cleanup partial failure', {
      module: 'reaper-reclaim',
      targetKey,
      errors,
    });
    return {
      targetKey,
      ok: false,
      reason: 'cleanup-error',
      checked,
      removed,
      errors,
      detail: errors.slice(0, 5).join('; '),
    };
  }

  return { targetKey, ok: true, reason: 'cleanup', checked, removed, errors };
}

export function buildDeletingOrphanReaperScript(invokerHome: string, minAgeMinutes = 30): string {
  const homeQ = shellPosixSingleQuote(invokerHome);
  return `set -u
INVOKER_HOME=${homeQ}
${bashNormalizeTildePath('INVOKER_HOME')}
case "$INVOKER_HOME" in
  ""|"/"|"$HOME"|"~")
    echo "Refusing unsafe INVOKER_HOME: $INVOKER_HOME" >&2
    exit 64
    ;;
esac
removed=0
if [ -d "$INVOKER_HOME" ]; then
  while IFS= read -r -d '' entry; do
    base="\${entry##*/}"
    case "$base" in
      *.deleting.*)
        if rm -rf -- "$entry" >/dev/null 2>&1; then
          removed=$((removed + 1))
        fi
        ;;
    esac
  done < <(find "$INVOKER_HOME" -mindepth 1 -maxdepth 1 -mmin +${minAgeMinutes} -print0 2>/dev/null)
fi
printf '__INVOKER_REAPER_REMOVED__=%s\\n' "$removed"
`;
}

function parseRemoteRemovedCount(output: string): number {
  const match = output.match(/__INVOKER_REAPER_REMOVED__=(\d+)/);
  return match ? Number.parseInt(match[1] ?? '0', 10) : 0;
}

function defaultRunRemoteReaperScript(target: RemoteDiskTarget, script: string): Promise<string> {
  const sshArgs = buildSshConnectionArgs(target.connection, { batchMode: true });
  return execRemoteCapture({
    sshArgs,
    script,
    phase: `reaper-deleting-orphans:${target.name}`,
  });
}

async function cleanupRemoteDeletingOrphans(opts: {
  target: RemoteDiskTarget;
  minAgeMs: number;
  logger?: Logger;
  runRemoteScript?: (target: RemoteDiskTarget, script: string) => Promise<string>;
}): Promise<ReaperTargetCleanupResult> {
  const targetKey = `ssh:${opts.target.name} ${opts.target.remotePath}`;
  if (!isSafeRemoteInvokerHomePath(opts.target.remotePath)) {
    return {
      targetKey,
      ok: false,
      reason: 'path-guard',
      checked: 0,
      removed: 0,
      errors: [],
      detail: opts.target.remotePath,
    };
  }

  const minAgeMinutes = Math.ceil(opts.minAgeMs / 60_000);
  const script = buildDeletingOrphanReaperScript(opts.target.remotePath, minAgeMinutes);
  const run = opts.runRemoteScript ?? defaultRunRemoteReaperScript;

  try {
    const output = await run(opts.target, script);
    return {
      targetKey,
      ok: true,
      reason: 'cleanup',
      checked: 0,
      removed: parseRemoteRemovedCount(output),
      errors: [],
      detail: output.slice(-400),
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    opts.logger?.warn?.(`[reaper-reclaim] remote deleting-orphan cleanup failed ${targetKey}: ${detail}`, {
      module: 'reaper-reclaim',
      targetKey,
    });
    return { targetKey, ok: false, reason: 'cleanup-error', checked: 0, removed: 0, errors: [detail], detail };
  }
}

export async function cleanupDeletingOrphans(
  opts: CleanupDeletingOrphansOptions = {},
): Promise<ReaperTargetCleanupResult[]> {
  const userHome = opts.userHome ?? homedir();
  const nowMs = opts.nowMs ?? Date.now();
  const minAgeMs = opts.minAgeMs ?? DELETING_ORPHAN_MIN_AGE_MS;
  const local = cleanupLocalDeletingOrphans({
    invokerHome: opts.invokerHome ?? DEFAULT_INVOKER_HOME,
    userHome,
    nowMs,
    minAgeMs,
    logger: opts.logger,
  });
  const remotes = await Promise.all(
    (opts.remoteTargets ?? []).map((target) => cleanupRemoteDeletingOrphans({
      target,
      minAgeMs,
      logger: opts.logger,
      runRemoteScript: opts.runRemoteScript,
    })),
  );
  return [local, ...remotes];
}

export function cleanupAutomationCheckoutWork(
  opts: CleanupAutomationCheckoutWorkOptions = {},
): ReaperCleanupSummary {
  const userHome = opts.userHome ?? homedir();
  const home = resolvedInvokerHome(opts.invokerHome, userHome);
  if (!isSafeInvokerHome(home, userHome)) {
    return { checked: 0, removed: 0, errors: [`unsafe invoker home: ${home}`] };
  }

  const nowMs = opts.nowMs ?? Date.now();
  const minAgeMs = opts.minAgeMs ?? AUTOMATION_CHECKOUT_WORK_MIN_AGE_MS;
  const errors: string[] = [];
  let checked = 0;
  let removed = 0;

  for (const name of AUTOMATION_CHECKOUT_WORK_DIRS) {
    const result = cleanupImmediateChildren({
      parent: join(home, name),
      predicate: () => true,
      nowMs,
      minAgeMs,
      errors,
    });
    checked += result.checked;
    removed += result.removed;
  }

  if (errors.length > 0) {
    opts.logger?.warn?.('[reaper-reclaim] automation checkout cleanup partial failure', {
      module: 'reaper-reclaim',
      errors,
    });
  }

  return { checked, removed, errors };
}

async function loadDefaultSnapshotPruneHelpers(): Promise<SnapshotPruneHelpers> {
  const moduleUrl = new URL(SNAPSHOT_HELPERS_MODULE, import.meta.url);
  const mod = await import(moduleUrl.href) as Partial<SnapshotPruneHelpers>;
  if (typeof mod.pruneHourlySnapshots !== 'function' || typeof mod.hourlySnapshotRetention !== 'function') {
    throw new Error('delete-all-snapshot helpers are not available');
  }
  return {
    pruneHourlySnapshots: mod.pruneHourlySnapshots,
    hourlySnapshotRetention: mod.hourlySnapshotRetention,
  };
}

export async function pruneHourlySnapshotBackups(
  opts: PruneHourlySnapshotBackupsOptions = {},
): Promise<PruneHourlySnapshotBackupsResult> {
  const userHome = opts.userHome ?? homedir();
  const home = resolvedInvokerHome(opts.invokerHome, userHome);
  const backupDir = opts.backupDir ?? join(home, 'db-backups');

  try {
    const helpers = opts.helpers ?? await loadDefaultSnapshotPruneHelpers();
    const retain = helpers.hourlySnapshotRetention();
    const removed = helpers.pruneHourlySnapshots(backupDir, retain);
    return { backupDir, retain, checked: 1, removed, errors: [] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    opts.logger?.warn?.(`[reaper-reclaim] hourly snapshot prune failed: ${message}`, {
      module: 'reaper-reclaim',
      backupDir,
    });
    return { backupDir, checked: 1, removed: 0, errors: [message] };
  }
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${escaped}$`);
}

function collectLogCandidates(home: string, names: readonly string[], globs: readonly string[]): string[] {
  const candidates = new Set<string>();
  for (const name of names) {
    if (!name.includes('/')) candidates.add(join(home, name));
  }

  let entries: string[];
  try {
    entries = readdirSync(home);
  } catch {
    return [...candidates];
  }

  const patterns = globs
    .filter((glob) => !glob.includes('/'))
    .map(globToRegExp);
  for (const entry of entries) {
    if (patterns.some((pattern) => pattern.test(entry))) {
      candidates.add(join(home, entry));
    }
  }
  return [...candidates];
}

function trimLogFile(path: string, thresholdBytes: number, keepBytes: number, errors: string[]): boolean {
  if (thresholdBytes <= 0 || keepBytes <= 0 || !existsSync(path)) return false;

  let fd: number | undefined;
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.size <= thresholdBytes) return false;

    fd = openSync(path, 'r+');
    const currentSize = fstatSync(fd).size;
    if (currentSize <= thresholdBytes) return false;

    const bytesToKeep = Math.min(keepBytes, currentSize);
    const buffer = Buffer.alloc(bytesToKeep);
    const bytesRead = readSync(fd, buffer, 0, bytesToKeep, currentSize - bytesToKeep);
    writeSync(fd, buffer, 0, bytesRead, 0);
    ftruncateSync(fd, bytesRead);
    return true;
  } catch (err) {
    errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function trimInvokerLogFiles(
  opts: TrimInvokerLogFilesOptions = {},
): TrimInvokerLogFilesResult {
  const userHome = opts.userHome ?? homedir();
  const home = resolvedInvokerHome(opts.invokerHome, userHome);
  if (!isSafeInvokerHome(home, userHome)) {
    return { checked: 0, removed: 0, trimmed: 0, errors: [`unsafe invoker home: ${home}`] };
  }

  const thresholdBytes = opts.thresholdBytes ?? LOG_TRIM_THRESHOLD_BYTES;
  const keepBytes = opts.keepBytes ?? LOG_TRIM_KEEP_BYTES;
  const names = opts.logFileNames ?? INVOKER_LOG_FILE_NAMES;
  const globs = opts.logGlobs ?? INVOKER_LARGE_LOG_GLOBS;
  const errors: string[] = [];
  const candidates = collectLogCandidates(home, names, globs);
  let trimmed = 0;

  for (const path of candidates) {
    if (trimLogFile(path, thresholdBytes, keepBytes, errors)) trimmed += 1;
  }

  if (errors.length > 0) {
    opts.logger?.warn?.('[reaper-reclaim] log trim partial failure', {
      module: 'reaper-reclaim',
      errors,
    });
  }

  return { checked: candidates.length, removed: 0, trimmed, errors };
}
