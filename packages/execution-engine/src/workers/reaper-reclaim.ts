import {
  existsSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  writeSync,
  closeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveInvokerHomeRoot, type Logger } from '@invoker/contracts';

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

export const REAPER_DELETING_ORPHAN_MIN_AGE_MS = 30 * 60 * 1000;
export const REAPER_ADMIN_WORK_MIN_AGE_MS = 48 * 60 * 60 * 1000;
export const REAPER_LOG_TRIM_THRESHOLD_BYTES = 100 * 1024 * 1024;
export const REAPER_LOG_RETAIN_BYTES = 20 * 1024 * 1024;

export const REAPER_ADMIN_WORK_DIRS = [
  'mergify-admin-requeue-work',
  'land-admin-bypass-work',
] as const;

export const REAPER_EXACT_LOG_FILES = [
  'invoker.log',
  'gui.log',
  'merge-trace.log',
] as const;

export const REAPER_LOG_FILE_GLOBS = [
  'ui-*-events.jsonl',
] as const;

export interface ReaperReclaimResult {
  targetKey: string;
  ok: boolean;
  reason: string;
  removed?: number;
  trimmed?: number;
  detail?: string;
}

export interface ReclaimDeletingOrphansOptions {
  invokerHome?: string;
  userHome?: string;
  remoteTargets?: RemoteDiskTarget[];
  nowMs?: number;
  logger?: Logger;
  runRemoteScript?: (target: RemoteDiskTarget, script: string) => Promise<string>;
}

export interface ReaperInvokerHomeOptions {
  invokerHome?: string;
  userHome?: string;
  nowMs?: number;
}

export interface TrimInvokerLogsOptions {
  invokerHome?: string;
  userHome?: string;
  trimThresholdBytes?: number;
  retainBytes?: number;
}

function isOlderThan(mtimeMs: number, nowMs: number, minAgeMs: number): boolean {
  return nowMs - mtimeMs > minAgeMs;
}

function safeLocalInvokerHome(invokerHome: string, userHome: string): string | null {
  const home = expandTildeHome(invokerHome, userHome);
  if (!isSafeInvokerHome(home, userHome)) return null;
  return home;
}

function removePath(path: string): boolean {
  try {
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function reclaimLocalDeletingOrphans(home: string, nowMs: number): number {
  if (!existsSync(home)) return 0;
  let entries: string[];
  try {
    entries = readdirSync(home);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const name of entries) {
    if (!isDeletingOrphanName(name)) continue;
    const entryPath = join(home, name);
    let mtimeMs: number;
    try {
      mtimeMs = lstatSync(entryPath).mtimeMs;
    } catch {
      continue;
    }
    if (!isOlderThan(mtimeMs, nowMs, REAPER_DELETING_ORPHAN_MIN_AGE_MS)) continue;
    if (removePath(entryPath)) removed += 1;
  }
  return removed;
}

function buildDeletingOrphanReclaimScript(invokerHome: string): string {
  const homeQ = shellPosixSingleQuote(invokerHome);
  const minAgeMinutes = Math.floor(REAPER_DELETING_ORPHAN_MIN_AGE_MS / 60_000);
  return `set -euo pipefail
INVOKER_HOME=${homeQ}
${bashNormalizeTildePath('INVOKER_HOME')}
case "$INVOKER_HOME" in
  ""|"/"|"$HOME"|"~")
    echo "Refusing unsafe INVOKER_HOME: $INVOKER_HOME" >&2
    exit 64
    ;;
esac
[ -d "$INVOKER_HOME" ] || exit 0
removed=0
while IFS= read -r -d '' entry; do
  rm -rf -- "$entry" >/dev/null 2>&1 && removed=$((removed + 1))
done < <(find "$INVOKER_HOME" -mindepth 1 -maxdepth 1 -name '*.deleting.*' -mmin +${minAgeMinutes} -print0 2>/dev/null)
echo "__INVOKER_REAPER_REMOVED__=$removed"
`;
}

function defaultRunRemoteDeletingOrphanReclaim(
  target: RemoteDiskTarget,
  script: string,
): Promise<string> {
  const sshArgs = buildSshConnectionArgs(target.connection, { batchMode: true });
  return execRemoteCapture({
    sshArgs,
    script,
    phase: `reaper-reclaim:deleting-orphans:${target.name}`,
  });
}

function parseRemoteRemovedCount(output: string): number | undefined {
  const match = output.match(/__INVOKER_REAPER_REMOVED__=(\d+)/);
  if (!match) return undefined;
  return Number.parseInt(match[1] as string, 10);
}

export async function reclaimDeletingOrphans(
  options: ReclaimDeletingOrphansOptions = {},
): Promise<ReaperReclaimResult[]> {
  const userHome = options.userHome ?? homedir();
  const invokerHome = options.invokerHome ?? resolveInvokerHomeRoot();
  const home = safeLocalInvokerHome(invokerHome, userHome);
  const results: ReaperReclaimResult[] = [];

  if (!home) {
    results.push({
      targetKey: `local ${invokerHome}`,
      ok: false,
      reason: 'path-guard',
      detail: invokerHome,
    });
  } else {
    const removed = reclaimLocalDeletingOrphans(home, options.nowMs ?? Date.now());
    results.push({
      targetKey: `local ${home}`,
      ok: true,
      reason: 'deleting-orphan-reclaim',
      removed,
    });
  }

  const runRemote = options.runRemoteScript ?? defaultRunRemoteDeletingOrphanReclaim;
  const remoteResults = await Promise.all(
    (options.remoteTargets ?? []).map(async (target): Promise<ReaperReclaimResult> => {
      const targetKey = `ssh:${target.name} ${target.remotePath}`;
      if (!isSafeRemoteInvokerHomePath(target.remotePath)) {
        return {
          targetKey,
          ok: false,
          reason: 'path-guard',
          detail: target.remotePath,
        };
      }

      const script = buildDeletingOrphanReclaimScript(target.remotePath);
      try {
        const output = await runRemote(target, script);
        return {
          targetKey,
          ok: true,
          reason: 'deleting-orphan-reclaim',
          removed: parseRemoteRemovedCount(output),
          detail: output.slice(-400),
        };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        options.logger?.warn?.(`[reaper-reclaim] deleting orphan sweep failed for ${targetKey}`, {
          module: 'reaper-reclaim',
          targetKey,
          detail,
        });
        return {
          targetKey,
          ok: false,
          reason: 'cleanup-error',
          detail,
        };
      }
    }),
  );

  results.push(...remoteResults);
  return results;
}

export function reclaimAdminWorkDirs(options: ReaperInvokerHomeOptions = {}): ReaperReclaimResult {
  const userHome = options.userHome ?? homedir();
  const invokerHome = options.invokerHome ?? resolveInvokerHomeRoot();
  const home = safeLocalInvokerHome(invokerHome, userHome);
  if (!home) {
    return {
      targetKey: `local ${invokerHome}`,
      ok: false,
      reason: 'path-guard',
      detail: invokerHome,
    };
  }

  const nowMs = options.nowMs ?? Date.now();
  let removed = 0;
  for (const dirName of REAPER_ADMIN_WORK_DIRS) {
    const dir = join(home, dirName);
    let children: string[];
    try {
      children = readdirSync(dir);
    } catch {
      continue;
    }
    for (const child of children) {
      const childPath = join(dir, child);
      let mtimeMs: number;
      try {
        mtimeMs = lstatSync(childPath).mtimeMs;
      } catch {
        continue;
      }
      if (!isOlderThan(mtimeMs, nowMs, REAPER_ADMIN_WORK_MIN_AGE_MS)) continue;
      if (removePath(childPath)) removed += 1;
    }
  }

  return {
    targetKey: `local ${home}`,
    ok: true,
    reason: 'admin-work-reclaim',
    removed,
  };
}

export function pruneHourlySnapshotsForReaper(
  invokerHome: string = resolveInvokerHomeRoot(),
): ReaperReclaimResult {
  const backupDir = join(invokerHome, 'db-backups');
  const removed = pruneHourlySnapshots(backupDir, hourlySnapshotRetention());
  return {
    targetKey: backupDir,
    ok: true,
    reason: 'hourly-snapshot-prune',
    removed,
  };
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

const LOG_GLOB_REGEXES = REAPER_LOG_FILE_GLOBS.map(globToRegExp);

function isKnownLogFileName(name: string): boolean {
  return (
    (REAPER_EXACT_LOG_FILES as readonly string[]).includes(name) ||
    LOG_GLOB_REGEXES.some((regex) => regex.test(name))
  );
}

function knownLogPaths(home: string): string[] {
  const paths = new Set<string>();
  for (const name of REAPER_EXACT_LOG_FILES) {
    paths.add(join(home, name));
  }
  let entries: string[];
  try {
    entries = readdirSync(home);
  } catch {
    return [...paths];
  }
  for (const name of entries) {
    if (isKnownLogFileName(name)) paths.add(join(home, name));
  }
  return [...paths];
}

function trimLogFile(path: string, thresholdBytes: number, retainBytes: number): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r+');
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= thresholdBytes || stat.size <= retainBytes) return false;

    const bytesToKeep = Math.min(retainBytes, stat.size);
    const buffer = Buffer.allocUnsafe(bytesToKeep);
    const bytesRead = readSync(fd, buffer, 0, bytesToKeep, stat.size - bytesToKeep);
    ftruncateSync(fd, 0);
    if (bytesRead > 0) writeSync(fd, buffer, 0, bytesRead, 0);
    ftruncateSync(fd, bytesRead);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function trimInvokerLogs(options: TrimInvokerLogsOptions = {}): ReaperReclaimResult {
  const userHome = options.userHome ?? homedir();
  const invokerHome = options.invokerHome ?? resolveInvokerHomeRoot();
  const home = safeLocalInvokerHome(invokerHome, userHome);
  if (!home) {
    return {
      targetKey: `local ${invokerHome}`,
      ok: false,
      reason: 'path-guard',
      detail: invokerHome,
    };
  }

  const thresholdBytes = options.trimThresholdBytes ?? REAPER_LOG_TRIM_THRESHOLD_BYTES;
  const retainBytes = options.retainBytes ?? REAPER_LOG_RETAIN_BYTES;
  if (thresholdBytes <= 0 || retainBytes <= 0) {
    return {
      targetKey: `local ${home}`,
      ok: false,
      reason: 'invalid-size-limit',
    };
  }

  mkdirSync(home, { recursive: true, mode: 0o700 });
  let trimmed = 0;
  for (const logPath of knownLogPaths(home)) {
    if (trimLogFile(logPath, thresholdBytes, retainBytes)) trimmed += 1;
  }

  return {
    targetKey: `local ${home}`,
    ok: true,
    reason: 'log-trim',
    trimmed,
  };
}
