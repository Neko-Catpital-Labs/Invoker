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

import type { Logger } from '@invoker/contracts';

import { hourlySnapshotRetention, pruneHourlySnapshots } from '../../../app/src/delete-all-snapshot.js';
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
export const ADMIN_WORK_MIN_AGE_MS = 48 * 60 * 60 * 1000;
export const LOG_TRIM_MAX_BYTES = 100 * 1024 * 1024;
export const LOG_TRIM_KEEP_BYTES = 20 * 1024 * 1024;

export const ADMIN_WORK_DIRS = [
  'mergify-admin-requeue-work',
  'land-admin-bypass-work',
] as const;

export const REAPER_LOG_FILE_NAMES = ['invoker.log', 'gui.log'] as const;
export const REAPER_LOG_FILE_GLOBS = ['ui-*-events.jsonl'] as const;

export interface ReaperReclaimResult {
  targetKey: string;
  ok: boolean;
  reason: string;
  removed?: number;
  trimmed?: number;
  detail?: string;
}

export interface ReclaimDeletingOrphansOptions {
  invokerHome: string;
  remoteTargets?: RemoteDiskTarget[];
  logger?: Logger;
  nowMs?: number;
  userHome?: string;
  runRemoteScript?: (target: RemoteDiskTarget, script: string) => Promise<string>;
}

export interface LocalReaperOptions {
  invokerHome: string;
  logger?: Logger;
  nowMs?: number;
  userHome?: string;
}

export interface TrimKnownInvokerLogsOptions {
  invokerHome: string;
  logger?: Logger;
  maxBytes?: number;
  keepBytes?: number;
  userHome?: string;
}

function isOlderThan(mtimeMs: number, nowMs: number, minAgeMs: number): boolean {
  return nowMs - mtimeMs > minAgeMs;
}

function safeLocalHomeResult(
  invokerHome: string,
  userHome: string,
  targetKey: string,
): { ok: true; home: string } | ReaperReclaimResult {
  const home = expandTildeHome(invokerHome, userHome);
  if (!isSafeInvokerHome(home, userHome)) {
    return { targetKey, ok: false, reason: 'path-guard', detail: home };
  }
  return { ok: true, home };
}

function removeLocalEntry(path: string, errors: string[]): boolean {
  try {
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch (err) {
    errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function readdirLocal(path: string, errors: string[]): string[] {
  try {
    return readdirSync(path);
  } catch (err) {
    if (existsSync(path)) {
      errors.push(`readdir ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return [];
  }
}

function localReclaimResult(
  targetKey: string,
  reason: string,
  removed: number,
  errors: string[],
): ReaperReclaimResult {
  if (errors.length > 0) {
    return {
      targetKey,
      ok: false,
      reason: 'cleanup-error',
      removed,
      detail: errors.slice(0, 5).join('; '),
    };
  }
  return { targetKey, ok: true, reason, removed };
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

const REAPER_LOG_GLOB_REGEXPS = REAPER_LOG_FILE_GLOBS.map(globToRegExp);

function isKnownInvokerLogName(name: string): boolean {
  return (
    (REAPER_LOG_FILE_NAMES as readonly string[]).includes(name)
    || REAPER_LOG_GLOB_REGEXPS.some((pattern) => pattern.test(name))
  );
}

function defaultRunRemoteScript(target: RemoteDiskTarget, script: string): Promise<string> {
  const sshArgs = buildSshConnectionArgs(target.connection, { batchMode: true });
  return execRemoteCapture({
    sshArgs,
    script,
    phase: `reaper-reclaim:${target.name}`,
  });
}

export function buildDeletingOrphanReclaimScript(
  invokerHome: string,
  minAgeMinutes = Math.floor(DELETING_ORPHAN_MIN_AGE_MS / 60_000),
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
echo "[reaper-reclaim] deleting-orphans begin home=$INVOKER_HOME"
find "$INVOKER_HOME" -mindepth 1 -maxdepth 1 -name '*.deleting.*' -mmin +${minAgeMinutes} -print0 2>/dev/null | while IFS= read -r -d '' entry; do
  rm -rf -- "$entry" 2>/dev/null || true
done
echo "[reaper-reclaim] deleting-orphans done"
exit 0
`;
}

function reclaimLocalDeletingOrphans(opts: LocalReaperOptions): ReaperReclaimResult {
  const targetKey = `local ${opts.invokerHome}`;
  const userHome = opts.userHome ?? homedir();
  const safe = safeLocalHomeResult(opts.invokerHome, userHome, targetKey);
  if (!safe.ok) return safe;

  const nowMs = opts.nowMs ?? Date.now();
  const errors: string[] = [];
  let removed = 0;
  for (const name of readdirLocal(safe.home, errors)) {
    if (!isDeletingOrphanName(name)) continue;
    const entryPath = join(safe.home, name);
    try {
      const stat = lstatSync(entryPath);
      if (!isOlderThan(stat.mtimeMs, nowMs, DELETING_ORPHAN_MIN_AGE_MS)) continue;
    } catch (err) {
      errors.push(`stat ${entryPath}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (removeLocalEntry(entryPath, errors)) removed += 1;
  }
  return localReclaimResult(targetKey, 'deleting-orphans', removed, errors);
}

async function reclaimRemoteDeletingOrphans(opts: {
  target: RemoteDiskTarget;
  logger?: Logger;
  runRemoteScript?: (target: RemoteDiskTarget, script: string) => Promise<string>;
}): Promise<ReaperReclaimResult> {
  const targetKey = `ssh:${opts.target.name} ${opts.target.remotePath}`;
  if (!isSafeRemoteInvokerHomePath(opts.target.remotePath)) {
    return { targetKey, ok: false, reason: 'path-guard', detail: opts.target.remotePath };
  }
  const script = buildDeletingOrphanReclaimScript(opts.target.remotePath);
  const run = opts.runRemoteScript ?? defaultRunRemoteScript;
  try {
    const output = await run(opts.target, script);
    return { targetKey, ok: true, reason: 'deleting-orphans', detail: output.slice(-400) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    opts.logger?.error?.(`[reaper-reclaim] remote deleting-orphans failed ${targetKey}: ${detail}`, {
      module: 'reaper-reclaim',
      targetKey,
    });
    return { targetKey, ok: false, reason: 'cleanup-error', detail };
  }
}

export async function reclaimDeletingOrphans(
  opts: ReclaimDeletingOrphansOptions,
): Promise<ReaperReclaimResult[]> {
  const local = reclaimLocalDeletingOrphans(opts);
  const remoteTargets = opts.remoteTargets ?? [];
  const remotes = await Promise.all(
    remoteTargets.map((target) =>
      reclaimRemoteDeletingOrphans({
        target,
        logger: opts.logger,
        runRemoteScript: opts.runRemoteScript,
      })
    ),
  );
  return [local, ...remotes];
}

export function reclaimAdminWorkDirs(opts: LocalReaperOptions): ReaperReclaimResult {
  const targetKey = `local ${opts.invokerHome}`;
  const userHome = opts.userHome ?? homedir();
  const safe = safeLocalHomeResult(opts.invokerHome, userHome, targetKey);
  if (!safe.ok) return safe;

  const nowMs = opts.nowMs ?? Date.now();
  const errors: string[] = [];
  let removed = 0;
  for (const dirName of ADMIN_WORK_DIRS) {
    const workRoot = join(safe.home, dirName);
    for (const name of readdirLocal(workRoot, errors)) {
      const entryPath = join(workRoot, name);
      try {
        const stat = lstatSync(entryPath);
        if (!isOlderThan(stat.mtimeMs, nowMs, ADMIN_WORK_MIN_AGE_MS)) continue;
      } catch (err) {
        errors.push(`stat ${entryPath}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (removeLocalEntry(entryPath, errors)) removed += 1;
    }
  }
  return localReclaimResult(targetKey, 'admin-work-dirs', removed, errors);
}

export function reclaimHourlySnapshots(opts: LocalReaperOptions): ReaperReclaimResult {
  const targetKey = `local ${opts.invokerHome}`;
  const userHome = opts.userHome ?? homedir();
  const safe = safeLocalHomeResult(opts.invokerHome, userHome, targetKey);
  if (!safe.ok) return safe;

  const removed = pruneHourlySnapshots(join(safe.home, 'db-backups'), hourlySnapshotRetention());
  return { targetKey, ok: true, reason: 'hourly-snapshots', removed };
}

function trimLogFileInPlace(path: string, maxBytes: number, keepBytes: number): boolean {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size <= maxBytes) return false;

  const bytesToKeep = Math.min(keepBytes, stat.size);
  const buffer = Buffer.allocUnsafe(bytesToKeep);
  const fd = openSync(path, 'r+');
  try {
    const bytesRead = readSync(fd, buffer, 0, bytesToKeep, stat.size - bytesToKeep);
    writeSync(fd, buffer, 0, bytesRead, 0);
    ftruncateSync(fd, bytesRead);
    return true;
  } finally {
    closeSync(fd);
  }
}

export function trimKnownInvokerLogs(opts: TrimKnownInvokerLogsOptions): ReaperReclaimResult {
  const targetKey = `local ${opts.invokerHome}`;
  const userHome = opts.userHome ?? homedir();
  const safe = safeLocalHomeResult(opts.invokerHome, userHome, targetKey);
  if (!safe.ok) return safe;

  const maxBytes = opts.maxBytes ?? LOG_TRIM_MAX_BYTES;
  const keepBytes = opts.keepBytes ?? LOG_TRIM_KEEP_BYTES;
  const errors: string[] = [];
  let trimmed = 0;

  for (const name of readdirLocal(safe.home, errors)) {
    if (!isKnownInvokerLogName(name)) continue;
    const logPath = join(safe.home, name);
    try {
      if (trimLogFileInPlace(logPath, maxBytes, keepBytes)) trimmed += 1;
    } catch (err) {
      errors.push(`${logPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (errors.length > 0) {
    return {
      targetKey,
      ok: false,
      reason: 'cleanup-error',
      trimmed,
      detail: errors.slice(0, 5).join('; '),
    };
  }
  return { targetKey, ok: true, reason: 'known-logs', trimmed };
}
