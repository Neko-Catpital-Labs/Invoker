import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveInvokerHomeRoot, type Logger } from '@invoker/contracts';

import { buildSshConnectionArgs } from '../ssh-transport-options.js';
import { bashNormalizeTildePath, execRemoteCapture, shellPosixSingleQuote } from '../ssh-git-exec.js';

import {
  expandTildeHome,
  isDeletingOrphanName,
  isSafeInvokerHome,
  isSafeRemoteInvokerHomePath,
} from './disk-headroom-reclaim.js';
import type { RemoteDiskTarget } from './disk-headroom-monitor.js';
import { hourlySnapshotRetention, pruneHourlySnapshots } from '../../../app/src/delete-all-snapshot.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

export const DELETING_ORPHAN_MIN_AGE_MS = 30 * MINUTE_MS;
export const AUTOMATION_CHECKOUT_MIN_AGE_MS = 48 * HOUR_MS;
export const LOG_TRIM_THRESHOLD_BYTES = 100 * 1024 * 1024;
export const LOG_TRIM_KEEP_BYTES = 20 * 1024 * 1024;

export const AUTOMATION_CHECKOUT_WORK_DIRS = [
  'mergify-admin-requeue-work',
  'land-admin-bypass-work',
] as const;

export const KNOWN_INVOKER_LOG_FILES = [
  'invoker.log',
  'gui.log',
] as const;

export const KNOWN_INVOKER_LOG_GLOBS = [
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
  remoteTargets?: RemoteDiskTarget[];
  nowMs?: number;
  userHome?: string;
  logger?: Logger;
  runRemoteScript?: (target: RemoteDiskTarget, script: string) => Promise<string>;
}

export interface ReclaimLocalInvokerHomeOptions {
  invokerHome?: string;
  nowMs?: number;
  userHome?: string;
  logger?: Logger;
}

export interface PruneHourlySnapshotOptions {
  invokerHome?: string;
  backupDir?: string;
  logger?: Logger;
}

export interface TrimKnownInvokerLogsOptions {
  invokerHome?: string;
  maxBytes?: number;
  keepBytes?: number;
  userHome?: string;
  logger?: Logger;
}

function isOlderThan(statMtimeMs: number, minAgeMs: number, nowMs: number): boolean {
  return statMtimeMs < nowMs - minAgeMs;
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

function readDirectory(path: string, errors: string[]): string[] | null {
  try {
    return readdirSync(path);
  } catch (err) {
    errors.push(`readdir ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function localInvokerHome(invokerHome: string | undefined, userHome: string): string {
  return expandTildeHome(invokerHome ?? resolveInvokerHomeRoot(), userHome);
}

function countLocalDeletingOrphans(home: string, minAgeMs: number, nowMs: number, errors: string[]): number {
  if (!existsSync(home)) return 0;
  const entries = readDirectory(home, errors);
  if (!entries) return 0;

  let removed = 0;
  for (const name of entries) {
    if (!isDeletingOrphanName(name)) continue;
    const path = join(home, name);
    let entryStat;
    try {
      entryStat = lstatSync(path);
    } catch (err) {
      errors.push(`stat ${path}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (!isOlderThan(entryStat.mtimeMs, minAgeMs, nowMs)) continue;
    if (removeLocalEntry(path, errors)) removed += 1;
  }
  return removed;
}

function countStaleChildren(parent: string, minAgeMs: number, nowMs: number, errors: string[]): number {
  if (!existsSync(parent)) return 0;
  const entries = readDirectory(parent, errors);
  if (!entries) return 0;

  let removed = 0;
  for (const name of entries) {
    const path = join(parent, name);
    let entryStat;
    try {
      entryStat = lstatSync(path);
    } catch (err) {
      errors.push(`stat ${path}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (!isOlderThan(entryStat.mtimeMs, minAgeMs, nowMs)) continue;
    if (removeLocalEntry(path, errors)) removed += 1;
  }
  return removed;
}

export function buildDeletingOrphanReclaimScript(invokerHome: string): string {
  const homeQ = shellPosixSingleQuote(invokerHome);
  const minAgeMinutes = Math.floor(DELETING_ORPHAN_MIN_AGE_MS / MINUTE_MS);
  return `set +e
INVOKER_HOME=${homeQ}
${bashNormalizeTildePath('INVOKER_HOME')}
case "$INVOKER_HOME" in
  ""|"/"|"$HOME"|"~")
    echo "Refusing unsafe INVOKER_HOME: $INVOKER_HOME" >&2
    exit 64
    ;;
esac
COUNT=0
if [ -d "$INVOKER_HOME" ]; then
  while IFS= read -r -d '' entry; do
    name="\${entry##*/}"
    case "$name" in
      *".deleting."*)
        if rm -rf "$entry" >/dev/null 2>&1; then
          COUNT=$((COUNT + 1))
        fi
        ;;
    esac
  done < <(find "$INVOKER_HOME" -mindepth 1 -maxdepth 1 -mmin +${minAgeMinutes} -print0 2>/dev/null)
fi
printf 'removed=%s\\n' "$COUNT"
exit 0
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
    phase: `reaper-deleting-orphans:${target.name}`,
  });
}

function parseRemovedCount(output: string): number | undefined {
  const match = output.match(/(?:^|\n)removed=(\d+)(?:\n|$)/);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

async function reclaimRemoteDeletingOrphans(options: {
  target: RemoteDiskTarget;
  logger?: Logger;
  runRemoteScript?: (target: RemoteDiskTarget, script: string) => Promise<string>;
}): Promise<ReaperReclaimResult> {
  const targetKey = `ssh:${options.target.name} ${options.target.remotePath}`;
  if (!isSafeRemoteInvokerHomePath(options.target.remotePath)) {
    return { targetKey, ok: false, reason: 'path-guard', detail: options.target.remotePath };
  }

  const script = buildDeletingOrphanReclaimScript(options.target.remotePath);
  const run = options.runRemoteScript ?? defaultRunRemoteDeletingOrphanReclaim;
  try {
    const output = await run(options.target, script);
    return {
      targetKey,
      ok: true,
      reason: 'deleting-orphans',
      removed: parseRemovedCount(output),
      detail: output.slice(-400),
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    options.logger?.warn?.(`[reaper-reclaim] remote deleting-orphan cleanup failed ${targetKey}: ${detail}`, {
      module: 'reaper-reclaim',
      targetKey,
    });
    return { targetKey, ok: false, reason: 'cleanup-error', detail };
  }
}

export async function reclaimDeletingOrphans(
  options: ReclaimDeletingOrphansOptions = {},
): Promise<ReaperReclaimResult[]> {
  const userHome = options.userHome ?? homedir();
  const home = localInvokerHome(options.invokerHome, userHome);
  const targetKey = `local ${home}`;
  let localResult: ReaperReclaimResult;
  if (!isSafeInvokerHome(home, userHome)) {
    localResult = { targetKey, ok: false, reason: 'path-guard', detail: home };
  } else {
    const errors: string[] = [];
    const removed = countLocalDeletingOrphans(
      home,
      DELETING_ORPHAN_MIN_AGE_MS,
      options.nowMs ?? Date.now(),
      errors,
    );
    localResult = errors.length > 0
      ? { targetKey, ok: false, reason: 'cleanup-error', removed, detail: errors.slice(0, 5).join('; ') }
      : { targetKey, ok: true, reason: 'deleting-orphans', removed };
  }

  const remoteResults = await Promise.all(
    (options.remoteTargets ?? []).map((target) =>
      reclaimRemoteDeletingOrphans({
        target,
        logger: options.logger,
        runRemoteScript: options.runRemoteScript,
      }),
    ),
  );

  return [localResult, ...remoteResults];
}

export function reclaimStaleAutomationCheckoutWork(
  options: ReclaimLocalInvokerHomeOptions = {},
): ReaperReclaimResult {
  const userHome = options.userHome ?? homedir();
  const home = localInvokerHome(options.invokerHome, userHome);
  const targetKey = `local ${home}`;
  if (!isSafeInvokerHome(home, userHome)) {
    return { targetKey, ok: false, reason: 'path-guard', detail: home };
  }

  const errors: string[] = [];
  let removed = 0;
  const nowMs = options.nowMs ?? Date.now();
  for (const dirName of AUTOMATION_CHECKOUT_WORK_DIRS) {
    removed += countStaleChildren(join(home, dirName), AUTOMATION_CHECKOUT_MIN_AGE_MS, nowMs, errors);
  }
  return errors.length > 0
    ? { targetKey, ok: false, reason: 'cleanup-error', removed, detail: errors.slice(0, 5).join('; ') }
    : { targetKey, ok: true, reason: 'automation-checkout-work', removed };
}

export function pruneHourlySnapshotRetention(
  options: PruneHourlySnapshotOptions = {},
): ReaperReclaimResult {
  const home = options.invokerHome ?? resolveInvokerHomeRoot();
  const backupDir = options.backupDir ?? join(home, 'db-backups');
  try {
    const removed = pruneHourlySnapshots(backupDir, hourlySnapshotRetention());
    return { targetKey: backupDir, ok: true, reason: 'hourly-snapshot-retention', removed };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    options.logger?.warn?.(`[reaper-reclaim] hourly snapshot prune failed: ${detail}`, {
      module: 'reaper-reclaim',
      backupDir,
    });
    return { targetKey: backupDir, ok: false, reason: 'cleanup-error', detail };
  }
}

function matchesKnownInvokerLogName(name: string): boolean {
  if ((KNOWN_INVOKER_LOG_FILES as readonly string[]).includes(name)) return true;
  return /^ui-[A-Za-z0-9_-]+-events\.jsonl$/.test(name);
}

function knownInvokerLogPaths(home: string, errors: string[]): string[] {
  const paths = new Set<string>();
  for (const name of KNOWN_INVOKER_LOG_FILES) {
    paths.add(join(home, name));
  }

  if (!existsSync(home)) return [...paths];
  const entries = readDirectory(home, errors);
  if (!entries) return [...paths];
  for (const name of entries) {
    if (matchesKnownInvokerLogName(name)) {
      paths.add(join(home, name));
    }
  }
  return [...paths];
}

function trimFileTail(path: string, maxBytes: number, keepBytes: number, errors: string[]): boolean {
  let entryStat;
  try {
    entryStat = statSync(path);
  } catch {
    return false;
  }
  if (!entryStat.isFile() || entryStat.size <= maxBytes) return false;

  const bytesToKeep = Math.max(0, Math.min(keepBytes, entryStat.size));
  let fd: number | undefined;
  try {
    const buffer = Buffer.allocUnsafe(bytesToKeep);
    fd = openSync(path, 'r');
    let offset = 0;
    while (offset < bytesToKeep) {
      const bytesRead = readSync(
        fd,
        buffer,
        offset,
        bytesToKeep - offset,
        entryStat.size - bytesToKeep + offset,
      );
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    if (fd !== undefined) {
      closeSync(fd);
      fd = undefined;
    }
    writeFileSync(path, buffer.subarray(0, offset));
    return true;
  } catch (err) {
    errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* best effort close */
      }
    }
  }
}

export function trimKnownInvokerLogs(
  options: TrimKnownInvokerLogsOptions = {},
): ReaperReclaimResult {
  const userHome = options.userHome ?? homedir();
  const home = localInvokerHome(options.invokerHome, userHome);
  const targetKey = `local ${home}`;
  if (!isSafeInvokerHome(home, userHome)) {
    return { targetKey, ok: false, reason: 'path-guard', detail: home };
  }

  const errors: string[] = [];
  let trimmed = 0;
  const maxBytes = options.maxBytes ?? LOG_TRIM_THRESHOLD_BYTES;
  const keepBytes = options.keepBytes ?? LOG_TRIM_KEEP_BYTES;
  for (const path of knownInvokerLogPaths(home, errors)) {
    if (trimFileTail(path, maxBytes, keepBytes, errors)) {
      trimmed += 1;
    }
  }

  return errors.length > 0
    ? { targetKey, ok: false, reason: 'cleanup-error', trimmed, detail: errors.slice(0, 5).join('; ') }
    : { targetKey, ok: true, reason: 'known-log-trim', trimmed };
}
