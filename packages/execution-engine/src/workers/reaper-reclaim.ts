import {
  closeSync,
  existsSync,
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

import { resolveInvokerHomeRoot, type Logger } from '@invoker/contracts';

import { buildSshConnectionArgs } from '../ssh-transport-options.js';
import {
  bashNormalizeTildePath,
  execRemoteCapture,
  shellPosixSingleQuote,
} from '../ssh-git-exec.js';

import {
  hourlySnapshotRetention,
  pruneHourlySnapshots,
} from '../../../app/src/delete-all-snapshot.js';

import type { RemoteDiskTarget } from './disk-headroom-monitor.js';
import {
  expandTildeHome,
  isDeletingOrphanName,
  isSafeInvokerHome,
  isSafeRemoteInvokerHomePath,
} from './disk-headroom-reclaim.js';

export const REAPER_DELETING_ORPHAN_MIN_AGE_MINUTES = 30;
export const REAPER_AUTOMATION_WORK_MIN_AGE_HOURS = 48;
export const REAPER_LOG_TRIM_MAX_BYTES = 100 * 1024 * 1024;
export const REAPER_LOG_TRIM_KEEP_BYTES = 20 * 1024 * 1024;

export const REAPER_AUTOMATION_WORK_DIRS = [
  'mergify-admin-requeue-work',
  'land-admin-bypass-work',
] as const;

export const REAPER_LOG_FILE_NAMES = [
  'invoker.log',
  'gui.log',
  'merge-trace.log',
] as const;

export const REAPER_LOG_FILE_GLOBS = [
  'ui-*-events.jsonl',
] as const;

export interface ReaperCleanupResult {
  targetKey: string;
  ok: boolean;
  reason: 'reaper-cleanup' | 'path-guard' | 'cleanup-error';
  removed?: number;
  trimmed?: number;
  detail?: string;
}

export interface ReclaimDeletingOrphansOptions {
  invokerHome: string;
  remoteTargets?: RemoteDiskTarget[];
  logger?: Logger;
  userHome?: string;
  nowMs?: number;
  runRemoteScript?: (target: RemoteDiskTarget, script: string) => Promise<string>;
}

export interface ReclaimInvokerHomeOptions {
  invokerHome?: string;
  logger?: Logger;
  userHome?: string;
  nowMs?: number;
}

export interface TrimInvokerLogsOptions {
  invokerHome?: string;
  logger?: Logger;
  userHome?: string;
  maxBytes?: number;
  keepBytes?: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function olderThan(statsMtimeMs: number, nowMs: number, minAgeMs: number): boolean {
  return nowMs - statsMtimeMs > minAgeMs;
}

function removeLocalEntryIfOld(path: string, nowMs: number, minAgeMs: number): boolean {
  const stat = lstatSync(path);
  if (!olderThan(stat.mtimeMs, nowMs, minAgeMs)) return false;
  rmSync(path, { recursive: true, force: true });
  return true;
}

function reclaimLocalDeletingOrphans(opts: {
  invokerHome: string;
  userHome: string;
  nowMs: number;
  logger?: Logger;
}): ReaperCleanupResult {
  const home = expandTildeHome(opts.invokerHome, opts.userHome);
  const targetKey = `local ${home}`;
  if (!isSafeInvokerHome(home, opts.userHome)) {
    return { targetKey, ok: false, reason: 'path-guard', detail: home };
  }
  if (!existsSync(home)) return { targetKey, ok: true, reason: 'reaper-cleanup', removed: 0 };

  let removed = 0;
  const errors: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(home);
  } catch (err) {
    return { targetKey, ok: false, reason: 'cleanup-error', detail: errorMessage(err) };
  }

  const minAgeMs = REAPER_DELETING_ORPHAN_MIN_AGE_MINUTES * 60 * 1000;
  for (const name of entries) {
    if (!isDeletingOrphanName(name)) continue;
    try {
      if (removeLocalEntryIfOld(join(home, name), opts.nowMs, minAgeMs)) removed += 1;
    } catch (err) {
      errors.push(`${name}: ${errorMessage(err)}`);
    }
  }

  if (errors.length > 0) {
    opts.logger?.warn?.('[reaper-reclaim] local deleting orphan cleanup partial failures', {
      module: 'reaper-reclaim',
      targetKey,
      errors,
    });
    return {
      targetKey,
      ok: false,
      reason: 'cleanup-error',
      removed,
      detail: errors.slice(0, 5).join('; '),
    };
  }
  return { targetKey, ok: true, reason: 'reaper-cleanup', removed };
}

function buildDeletingOrphanReclaimScript(invokerHome: string): string {
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
if [ -d "$INVOKER_HOME" ]; then
  while IFS= read -r -d '' entry; do
    name="\${entry##*/}"
    case "$name" in
      *'.deleting.'*)
        if rm -rf "$entry" >/dev/null 2>&1; then
          removed=$((removed + 1))
        fi
        ;;
    esac
  done < <(find "$INVOKER_HOME" -mindepth 1 -maxdepth 1 -mmin +${REAPER_DELETING_ORPHAN_MIN_AGE_MINUTES} -print0 2>/dev/null)
fi
echo "[reaper-reclaim] deleting-orphans removed=$removed"
exit 0
`;
}

async function defaultRunRemoteReaperScript(
  target: RemoteDiskTarget,
  script: string,
): Promise<string> {
  const sshArgs = buildSshConnectionArgs(target.connection, { batchMode: true });
  return execRemoteCapture({
    sshArgs,
    script,
    phase: `reaper-reclaim:${target.name}`,
  });
}

async function reclaimRemoteDeletingOrphans(opts: {
  target: RemoteDiskTarget;
  logger?: Logger;
  runRemoteScript?: (target: RemoteDiskTarget, script: string) => Promise<string>;
}): Promise<ReaperCleanupResult> {
  const targetKey = `ssh:${opts.target.name} ${opts.target.remotePath}`;
  if (!isSafeRemoteInvokerHomePath(opts.target.remotePath)) {
    return { targetKey, ok: false, reason: 'path-guard', detail: opts.target.remotePath };
  }

  const run = opts.runRemoteScript ?? defaultRunRemoteReaperScript;
  try {
    const output = await run(opts.target, buildDeletingOrphanReclaimScript(opts.target.remotePath));
    return {
      targetKey,
      ok: true,
      reason: 'reaper-cleanup',
      detail: output.slice(-400),
    };
  } catch (err) {
    const detail = errorMessage(err);
    opts.logger?.error?.(`[reaper-reclaim] remote deleting orphan cleanup failed ${targetKey}: ${detail}`, {
      module: 'reaper-reclaim',
      targetKey,
    });
    return { targetKey, ok: false, reason: 'cleanup-error', detail };
  }
}

export async function reclaimDeletingOrphans(
  opts: ReclaimDeletingOrphansOptions,
): Promise<ReaperCleanupResult[]> {
  const userHome = opts.userHome ?? homedir();
  const nowMs = opts.nowMs ?? Date.now();
  const local = reclaimLocalDeletingOrphans({
    invokerHome: opts.invokerHome,
    userHome,
    nowMs,
    logger: opts.logger,
  });

  const remote = await Promise.all(
    (opts.remoteTargets ?? []).map((target) =>
      reclaimRemoteDeletingOrphans({
        target,
        logger: opts.logger,
        runRemoteScript: opts.runRemoteScript,
      })),
  );

  return [local, ...remote];
}

export function reclaimAutomationCheckoutWorkDirs(
  opts: ReclaimInvokerHomeOptions = {},
): ReaperCleanupResult {
  const userHome = opts.userHome ?? homedir();
  const home = expandTildeHome(opts.invokerHome ?? resolveInvokerHomeRoot(), userHome);
  const targetKey = `local ${home}`;
  if (!isSafeInvokerHome(home, userHome)) {
    return { targetKey, ok: false, reason: 'path-guard', detail: home };
  }

  const nowMs = opts.nowMs ?? Date.now();
  const minAgeMs = REAPER_AUTOMATION_WORK_MIN_AGE_HOURS * 60 * 60 * 1000;
  let removed = 0;
  const errors: string[] = [];

  for (const rootName of REAPER_AUTOMATION_WORK_DIRS) {
    const root = join(home, rootName);
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        errors.push(`${rootName}: ${errorMessage(err)}`);
      }
      continue;
    }

    for (const name of entries) {
      try {
        if (removeLocalEntryIfOld(join(root, name), nowMs, minAgeMs)) removed += 1;
      } catch (err) {
        errors.push(`${rootName}/${name}: ${errorMessage(err)}`);
      }
    }
  }

  if (errors.length > 0) {
    opts.logger?.warn?.('[reaper-reclaim] automation checkout cleanup partial failures', {
      module: 'reaper-reclaim',
      targetKey,
      errors,
    });
    return {
      targetKey,
      ok: false,
      reason: 'cleanup-error',
      removed,
      detail: errors.slice(0, 5).join('; '),
    };
  }
  return { targetKey, ok: true, reason: 'reaper-cleanup', removed };
}

export function pruneHourlySnapshotsOnReaperSchedule(
  invokerHomeRoot: string = resolveInvokerHomeRoot(),
): number {
  const backupDir = join(invokerHomeRoot, 'db-backups');
  return pruneHourlySnapshots(backupDir, hourlySnapshotRetention());
}

function matchesKnownLargeLogGlob(name: string): boolean {
  return name.startsWith('ui-') && name.endsWith('-events.jsonl');
}

function knownInvokerLogPaths(home: string): string[] {
  const paths = new Set<string>();
  for (const name of REAPER_LOG_FILE_NAMES) {
    paths.add(join(home, name));
  }

  let entries: string[];
  try {
    entries = readdirSync(home);
  } catch {
    return [...paths];
  }
  for (const name of entries) {
    if (matchesKnownLargeLogGlob(name)) paths.add(join(home, name));
  }
  return [...paths];
}

function trimFileTailInPlace(filePath: string, maxBytes: number, keepBytes: number): boolean {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size <= maxBytes) return false;

  const bytesToKeep = Math.min(Math.max(0, Math.floor(keepBytes)), stat.size);
  const buffer = Buffer.alloc(bytesToKeep);
  const fd = openSync(filePath, 'r+');
  try {
    const bytesRead = readSync(fd, buffer, 0, bytesToKeep, stat.size - bytesToKeep);
    writeSync(fd, buffer, 0, bytesRead, 0);
    ftruncateSync(fd, bytesRead);
  } finally {
    closeSync(fd);
  }
  return true;
}

export function trimInvokerLogs(
  opts: TrimInvokerLogsOptions = {},
): ReaperCleanupResult {
  const userHome = opts.userHome ?? homedir();
  const home = expandTildeHome(opts.invokerHome ?? resolveInvokerHomeRoot(), userHome);
  const targetKey = `local ${home}`;
  if (!isSafeInvokerHome(home, userHome)) {
    return { targetKey, ok: false, reason: 'path-guard', detail: home };
  }

  const maxBytes = opts.maxBytes ?? REAPER_LOG_TRIM_MAX_BYTES;
  const keepBytes = opts.keepBytes ?? REAPER_LOG_TRIM_KEEP_BYTES;
  let trimmed = 0;
  const errors: string[] = [];

  for (const filePath of knownInvokerLogPaths(home)) {
    try {
      if (trimFileTailInPlace(filePath, maxBytes, keepBytes)) trimmed += 1;
    } catch (err) {
      errors.push(`${filePath}: ${errorMessage(err)}`);
    }
  }

  if (errors.length > 0) {
    opts.logger?.warn?.('[reaper-reclaim] log trim partial failures', {
      module: 'reaper-reclaim',
      targetKey,
      errors,
    });
    return {
      targetKey,
      ok: false,
      reason: 'cleanup-error',
      trimmed,
      detail: errors.slice(0, 5).join('; '),
    };
  }
  return { targetKey, ok: true, reason: 'reaper-cleanup', trimmed };
}
