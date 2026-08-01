import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
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

export const DOT_DELETING_ORPHAN_MIN_AGE_MS = 30 * 60 * 1000;
export const AUTOMATION_CHECKOUT_MIN_AGE_MS = 48 * 60 * 60 * 1000;
export const INVOKER_LOG_SIZE_LIMIT_BYTES = 100 * 1024 * 1024;
export const INVOKER_LOG_KEEP_BYTES = 20 * 1024 * 1024;

export const AUTOMATION_CHECKOUT_DIR_NAMES = [
  'mergify-admin-requeue-work',
  'land-admin-bypass-work',
] as const;

export const INVOKER_LOG_RELATIVE_PATHS = [
  'invoker.log',
  'gui.log',
  'merge-trace.log',
  'ui-task-graph-events.jsonl',
  'auto-approve-self-prs.log',
  'auto-fix-ci-self-prs.log',
] as const;

export const INVOKER_LOG_GLOB_RELATIVE_PATHS = [
  'task-output/full/*.log',
] as const;

export interface ReaperCleanupResult {
  targetKey: string;
  ok: boolean;
  reason: string;
  removed?: number;
  trimmed?: number;
  detail?: string;
}

export interface HourlySnapshotRetentionFns {
  hourlySnapshotRetention: () => number;
  pruneHourlySnapshots: (backupDir: string, retain: number) => number;
}

function entryOlderThan(path: string, minAgeMs: number, nowMs: number): boolean {
  try {
    return nowMs - lstatSync(path).mtimeMs > minAgeMs;
  } catch {
    return false;
  }
}

function isLocalDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isLocalFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function removeEntry(path: string, errors: string[]): boolean {
  try {
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch (err) {
    errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function resultFromErrors(
  targetKey: string,
  reason: string,
  removed: number,
  errors: string[],
): ReaperCleanupResult {
  if (errors.length === 0) {
    return { targetKey, ok: true, reason, removed };
  }
  return {
    targetKey,
    ok: false,
    reason: 'cleanup-error',
    removed,
    detail: errors.slice(0, 5).join('; '),
  };
}

export function reclaimLocalDeletingOrphans(opts: {
  invokerHome: string;
  targetKey?: string;
  logger?: Logger;
  userHome?: string;
  nowMs?: number;
  minAgeMs?: number;
}): ReaperCleanupResult {
  const targetKey = opts.targetKey ?? `local ${opts.invokerHome}`;
  const userHome = opts.userHome ?? homedir();
  const home = expandTildeHome(opts.invokerHome, userHome);
  if (!isSafeInvokerHome(home, userHome)) {
    return { targetKey, ok: false, reason: 'path-guard', detail: home };
  }
  if (!existsSync(home)) {
    return { targetKey, ok: true, reason: 'dot-deleting-orphans', removed: 0 };
  }

  const errors: string[] = [];
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(home);
  } catch (err) {
    return {
      targetKey,
      ok: false,
      reason: 'cleanup-error',
      detail: `readdir ${home}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const nowMs = opts.nowMs ?? Date.now();
  const minAgeMs = opts.minAgeMs ?? DOT_DELETING_ORPHAN_MIN_AGE_MS;
  for (const name of entries) {
    if (!isDeletingOrphanName(name)) continue;
    const path = join(home, name);
    if (!entryOlderThan(path, minAgeMs, nowMs)) continue;
    if (removeEntry(path, errors)) removed += 1;
  }

  if (removed > 0) {
    opts.logger?.info?.(`[reaper-reclaim] removed stale dot-deleting entries`, {
      module: 'reaper-reclaim',
      targetKey,
      removed,
    });
  }
  return resultFromErrors(targetKey, 'dot-deleting-orphans', removed, errors);
}

export function buildRemoteDeletingOrphansScript(
  invokerHome: string,
  minAgeMinutes: number = Math.floor(DOT_DELETING_ORPHAN_MIN_AGE_MS / 60_000),
): string {
  const homeQ = shellPosixSingleQuote(invokerHome);
  return `set +e
INVOKER_HOME=${homeQ}
${bashNormalizeTildePath('INVOKER_HOME')}
case "$INVOKER_HOME" in
  ""|"/"|"$HOME"|"~")
    echo "Refusing unsafe INVOKER_HOME: $INVOKER_HOME" >&2
    exit 64
    ;;
esac
removed=0
while IFS= read -r -d '' entry; do
  name="\${entry##*/}"
  case "$name" in
    *".deleting."*)
      rm -rf -- "$entry" >/dev/null 2>&1 && removed=$((removed + 1))
      ;;
  esac
done < <(find "$INVOKER_HOME" -mindepth 1 -maxdepth 1 -mmin +${minAgeMinutes} -print0 2>/dev/null)
echo "[reaper-reclaim] dot-deleting-orphans removed=$removed"
exit 0
`;
}

function defaultRunRemoteReaperScript(target: RemoteDiskTarget, script: string): Promise<string> {
  const sshArgs = buildSshConnectionArgs(target.connection, { batchMode: true });
  return execRemoteCapture({
    sshArgs,
    script,
    phase: `reaper-reclaim:${target.name}`,
  });
}

export async function reclaimRemoteDeletingOrphans(opts: {
  target: RemoteDiskTarget;
  logger?: Logger;
  minAgeMinutes?: number;
  runRemoteScript?: (target: RemoteDiskTarget, script: string) => Promise<string>;
}): Promise<ReaperCleanupResult> {
  const targetKey = `ssh:${opts.target.name} ${opts.target.remotePath}`;
  if (!isSafeRemoteInvokerHomePath(opts.target.remotePath)) {
    return {
      targetKey,
      ok: false,
      reason: 'path-guard',
      detail: opts.target.remotePath,
    };
  }

  const script = buildRemoteDeletingOrphansScript(opts.target.remotePath, opts.minAgeMinutes);
  const run = opts.runRemoteScript ?? defaultRunRemoteReaperScript;
  try {
    const output = await run(opts.target, script);
    opts.logger?.info?.(`[reaper-reclaim] remote dot-deleting sweep done ${targetKey}`, {
      module: 'reaper-reclaim',
      targetKey,
      outputTail: output.slice(-400),
    });
    return { targetKey, ok: true, reason: 'dot-deleting-orphans', detail: output.slice(-400) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    opts.logger?.warn?.(`[reaper-reclaim] remote dot-deleting sweep failed ${targetKey}: ${detail}`, {
      module: 'reaper-reclaim',
      targetKey,
    });
    return { targetKey, ok: false, reason: 'cleanup-error', detail };
  }
}

export async function reclaimDeletingOrphans(opts: {
  invokerHome: string;
  remoteTargets?: RemoteDiskTarget[];
  logger?: Logger;
  userHome?: string;
  nowMs?: number;
  minAgeMs?: number;
  runRemoteScript?: (target: RemoteDiskTarget, script: string) => Promise<string>;
}): Promise<ReaperCleanupResult[]> {
  const local = reclaimLocalDeletingOrphans({
    invokerHome: opts.invokerHome,
    logger: opts.logger,
    userHome: opts.userHome,
    nowMs: opts.nowMs,
    minAgeMs: opts.minAgeMs,
  });
  const minAgeMinutes = Math.floor((opts.minAgeMs ?? DOT_DELETING_ORPHAN_MIN_AGE_MS) / 60_000);
  const remote = await Promise.all(
    (opts.remoteTargets ?? []).map((target) =>
      reclaimRemoteDeletingOrphans({
        target,
        logger: opts.logger,
        minAgeMinutes,
        runRemoteScript: opts.runRemoteScript,
      }),
    ),
  );
  return [local, ...remote];
}

export function reclaimStaleAutomationCheckouts(opts: {
  invokerHome: string;
  logger?: Logger;
  userHome?: string;
  nowMs?: number;
  minAgeMs?: number;
  dirNames?: readonly string[];
}): ReaperCleanupResult {
  const targetKey = `local ${opts.invokerHome}`;
  const userHome = opts.userHome ?? homedir();
  const home = expandTildeHome(opts.invokerHome, userHome);
  if (!isSafeInvokerHome(home, userHome)) {
    return { targetKey, ok: false, reason: 'path-guard', detail: home };
  }

  const errors: string[] = [];
  let removed = 0;
  const nowMs = opts.nowMs ?? Date.now();
  const minAgeMs = opts.minAgeMs ?? AUTOMATION_CHECKOUT_MIN_AGE_MS;
  for (const dirName of opts.dirNames ?? AUTOMATION_CHECKOUT_DIR_NAMES) {
    const parent = join(home, dirName);
    if (!isLocalDirectory(parent)) continue;
    let entries: string[];
    try {
      entries = readdirSync(parent);
    } catch (err) {
      errors.push(`readdir ${parent}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    for (const name of entries) {
      const path = join(parent, name);
      if (!entryOlderThan(path, minAgeMs, nowMs)) continue;
      if (removeEntry(path, errors)) removed += 1;
    }
  }

  if (removed > 0) {
    opts.logger?.info?.(`[reaper-reclaim] removed stale automation checkout children`, {
      module: 'reaper-reclaim',
      targetKey,
      removed,
    });
  }
  return resultFromErrors(targetKey, 'automation-checkouts', removed, errors);
}

export function reclaimExcessHourlySnapshots(opts: {
  invokerHome: string;
  userHome?: string;
  snapshotRetention: HourlySnapshotRetentionFns;
}): ReaperCleanupResult {
  const userHome = opts.userHome ?? homedir();
  const home = expandTildeHome(opts.invokerHome, userHome);
  if (!isSafeInvokerHome(home, userHome)) {
    return { targetKey: `local ${opts.invokerHome}`, ok: false, reason: 'path-guard', detail: home };
  }

  const backupDir = join(home, 'db-backups');
  const retain = opts.snapshotRetention.hourlySnapshotRetention();
  const removed = opts.snapshotRetention.pruneHourlySnapshots(backupDir, retain);
  return {
    targetKey: backupDir,
    ok: true,
    reason: 'hourly-snapshot-retention',
    removed,
    detail: `retain=${retain}`,
  };
}

function resolveKnownLogGlob(invokerHome: string, glob: string): string[] {
  if (glob !== 'task-output/full/*.log') return [];
  const dir = join(invokerHome, 'task-output', 'full');
  if (!isLocalDirectory(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith('.log'))
    .map((name) => join(dir, name));
}

export function resolveKnownInvokerLogFiles(invokerHome: string): string[] {
  return [
    ...INVOKER_LOG_RELATIVE_PATHS.map((relativePath) => join(invokerHome, relativePath)),
    ...INVOKER_LOG_GLOB_RELATIVE_PATHS.flatMap((glob) => resolveKnownLogGlob(invokerHome, glob)),
  ];
}

function trimLogFile(path: string, keepBytes: number): boolean {
  const fd = openSync(path, 'r+');
  try {
    const stat = statSync(path);
    const bytesToKeep = Math.min(keepBytes, stat.size);
    const buffer = Buffer.allocUnsafe(bytesToKeep);
    const start = stat.size - bytesToKeep;
    let offset = 0;
    while (offset < bytesToKeep) {
      const read = readSync(fd, buffer, offset, bytesToKeep - offset, start + offset);
      if (read === 0) break;
      offset += read;
    }
    truncateSync(path, 0);
    if (offset > 0) writeSync(fd, buffer, 0, offset, 0);
    truncateSync(path, offset);
    return true;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Best effort: cleanup should not throw after successfully rewriting.
    }
  }
}

export function trimKnownInvokerLogs(opts: {
  invokerHome: string;
  logger?: Logger;
  userHome?: string;
  sizeLimitBytes?: number;
  keepBytes?: number;
  logFiles?: readonly string[];
}): ReaperCleanupResult {
  const targetKey = `local ${opts.invokerHome}`;
  const userHome = opts.userHome ?? homedir();
  const home = expandTildeHome(opts.invokerHome, userHome);
  if (!isSafeInvokerHome(home, userHome)) {
    return { targetKey, ok: false, reason: 'path-guard', detail: home };
  }

  const sizeLimitBytes = opts.sizeLimitBytes ?? INVOKER_LOG_SIZE_LIMIT_BYTES;
  const keepBytes = opts.keepBytes ?? INVOKER_LOG_KEEP_BYTES;
  const errors: string[] = [];
  let trimmed = 0;

  for (const path of opts.logFiles ?? resolveKnownInvokerLogFiles(home)) {
    let size = 0;
    try {
      if (!isLocalFile(path)) continue;
      size = statSync(path).size;
    } catch {
      continue;
    }
    if (size <= sizeLimitBytes) continue;
    try {
      if (trimLogFile(path, keepBytes)) trimmed += 1;
    } catch (err) {
      errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (trimmed > 0) {
    opts.logger?.info?.(`[reaper-reclaim] trimmed oversized logs`, {
      module: 'reaper-reclaim',
      targetKey,
      trimmed,
    });
  }

  if (errors.length === 0) {
    return { targetKey, ok: true, reason: 'known-log-size', trimmed };
  }
  return {
    targetKey,
    ok: false,
    reason: 'cleanup-error',
    trimmed,
    detail: errors.slice(0, 5).join('; '),
  };
}
