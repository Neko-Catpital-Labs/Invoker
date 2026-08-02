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

import { resolveInvokerHomeRoot, type Logger } from '@invoker/contracts';

import { buildSshConnectionArgs } from '../ssh-transport-options.js';
import { bashNormalizeTildePath, execRemoteCapture, shellPosixSingleQuote } from '../ssh-git-exec.js';

import { hourlySnapshotRetention, pruneHourlySnapshots } from '../../../app/src/delete-all-snapshot.js';

import type { RemoteDiskTarget } from './disk-headroom-monitor.js';
import {
  expandTildeHome,
  isDeletingOrphanName,
  isSafeInvokerHome,
  isSafeRemoteInvokerHomePath,
} from './disk-headroom-reclaim.js';

const MODULE = 'reaper-reclaim';

export const DELETING_ORPHAN_MIN_AGE_MS = 30 * 60 * 1000;
export const DELETING_ORPHAN_MIN_AGE_MINUTES = 30;

export const AUTOMATION_WORK_DIRS = [
  'mergify-admin-requeue-work',
  'land-admin-bypass-work',
] as const;
export const AUTOMATION_WORK_ITEM_MAX_AGE_MS = 48 * 60 * 60 * 1000;

export const KNOWN_LOG_FILE_NAMES = ['invoker.log', 'gui.log'] as const;
export const KNOWN_LOG_GLOBS = ['ui-*-events.jsonl'] as const;
export const LOG_TRIM_THRESHOLD_BYTES = 100 * 1024 * 1024;
export const LOG_TRIM_RETAIN_BYTES = 20 * 1024 * 1024;

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
  logger?: Logger;
  userHome?: string;
  nowMs?: number;
  minAgeMs?: number;
  runRemoteScript?: (target: RemoteDiskTarget, script: string) => Promise<string>;
}

export interface ReclaimAutomationWorkOptions {
  invokerHome?: string;
  logger?: Logger;
  userHome?: string;
  nowMs?: number;
  maxAgeMs?: number;
}

export interface ReclaimHourlySnapshotsOptions {
  invokerHome?: string;
  backupDir?: string;
}

export interface TrimKnownLogsOptions {
  invokerHome?: string;
  logger?: Logger;
  userHome?: string;
  thresholdBytes?: number;
  retainBytes?: number;
}

function reaperLog(
  logger: Logger | undefined,
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  fields?: Record<string, unknown>,
): void {
  logger?.[level]?.(message, { module: MODULE, ...fields });
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

function isOlderThan(statsMtimeMs: number, nowMs: number, minAgeMs: number): boolean {
  return nowMs - statsMtimeMs > minAgeMs;
}

function reclaimLocalDeletingOrphans(opts: {
  invokerHome: string;
  logger?: Logger;
  userHome: string;
  nowMs: number;
  minAgeMs: number;
}): ReaperReclaimResult {
  const home = expandTildeHome(opts.invokerHome, opts.userHome);
  const targetKey = `local ${home}`;
  if (!isSafeInvokerHome(home, opts.userHome)) {
    return { targetKey, ok: false, reason: 'path-guard', detail: home };
  }
  if (!existsSync(home)) {
    return { targetKey, ok: true, reason: 'deleting-orphans', removed: 0 };
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
      reason: 'readdir-error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  for (const name of entries) {
    if (!isDeletingOrphanName(name)) continue;
    const entryPath = join(home, name);
    let stats;
    try {
      stats = lstatSync(entryPath);
    } catch (err) {
      errors.push(`${entryPath}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (!isOlderThan(stats.mtimeMs, opts.nowMs, opts.minAgeMs)) continue;
    if (removePath(entryPath, errors)) removed += 1;
  }

  const ok = errors.length === 0;
  if (!ok) {
    reaperLog(opts.logger, 'warn', '[reaper-reclaim] local deleting orphan partial failures', {
      targetKey,
      errors,
    });
  }
  return {
    targetKey,
    ok,
    reason: ok ? 'deleting-orphans' : 'cleanup-error',
    removed,
    detail: ok ? undefined : errors.slice(0, 5).join('; '),
  };
}

function buildDeletingOrphanReclaimScript(invokerHome: string, minAgeMinutes: number): string {
  const homeQ = shellPosixSingleQuote(invokerHome);
  const ageMinutes = Math.max(0, Math.floor(minAgeMinutes));
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
    base="\${entry##*/}"
    case "$base" in
      *'.deleting.'*)
        if rm -rf -- "$entry" >/dev/null 2>&1; then
          removed=$((removed + 1))
        fi
        ;;
    esac
  done < <(find "$INVOKER_HOME" -mindepth 1 -maxdepth 1 -mmin +${ageMinutes} -print0 2>/dev/null)
fi
echo "[reaper-reclaim] deleting-orphans removed=$removed"
exit 0
`;
}

function defaultRunRemoteReaperScript(target: RemoteDiskTarget, script: string): Promise<string> {
  const sshArgs = buildSshConnectionArgs(target.connection, { batchMode: true });
  return execRemoteCapture({
    sshArgs,
    script,
    phase: `reaper-reclaim:deleting-orphans:${target.name}`,
  });
}

async function reclaimRemoteDeletingOrphans(opts: {
  target: RemoteDiskTarget;
  logger?: Logger;
  minAgeMs: number;
  runRemoteScript?: (target: RemoteDiskTarget, script: string) => Promise<string>;
}): Promise<ReaperReclaimResult> {
  const targetKey = `ssh:${opts.target.name} ${opts.target.remotePath}`;
  if (!isSafeRemoteInvokerHomePath(opts.target.remotePath)) {
    return {
      targetKey,
      ok: false,
      reason: 'path-guard',
      detail: opts.target.remotePath,
    };
  }

  const minAgeMinutes = Math.ceil(opts.minAgeMs / 60_000);
  const script = buildDeletingOrphanReclaimScript(opts.target.remotePath, minAgeMinutes);
  const run = opts.runRemoteScript ?? defaultRunRemoteReaperScript;

  try {
    const output = await run(opts.target, script);
    return {
      targetKey,
      ok: true,
      reason: 'deleting-orphans',
      detail: output.slice(-400),
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    reaperLog(opts.logger, 'error', `[reaper-reclaim] remote deleting orphan cleanup failed ${targetKey}: ${detail}`, {
      targetKey,
    });
    return { targetKey, ok: false, reason: 'cleanup-error', detail };
  }
}

export async function reclaimDeletingOrphans(
  opts: ReclaimDeletingOrphansOptions = {},
): Promise<ReaperReclaimResult[]> {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const nowMs = opts.nowMs ?? Date.now();
  const minAgeMs = opts.minAgeMs ?? DELETING_ORPHAN_MIN_AGE_MS;

  const local = reclaimLocalDeletingOrphans({
    invokerHome,
    logger: opts.logger,
    userHome: opts.userHome ?? homedir(),
    nowMs,
    minAgeMs,
  });

  const remoteResults = await Promise.all(
    (opts.remoteTargets ?? []).map((target) =>
      reclaimRemoteDeletingOrphans({
        target,
        logger: opts.logger,
        minAgeMs,
        runRemoteScript: opts.runRemoteScript,
      }),
    ),
  );

  return [local, ...remoteResults];
}

export function reclaimAutomationWorkItems(
  opts: ReclaimAutomationWorkOptions = {},
): ReaperReclaimResult {
  const userHome = opts.userHome ?? homedir();
  const invokerHome = expandTildeHome(opts.invokerHome ?? resolveInvokerHomeRoot(), userHome);
  const targetKey = `local ${invokerHome}`;
  if (!isSafeInvokerHome(invokerHome, userHome)) {
    return { targetKey, ok: false, reason: 'path-guard', detail: invokerHome };
  }

  const nowMs = opts.nowMs ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? AUTOMATION_WORK_ITEM_MAX_AGE_MS;
  const errors: string[] = [];
  let removed = 0;

  for (const dirName of AUTOMATION_WORK_DIRS) {
    const parent = join(invokerHome, dirName);
    if (!existsSync(parent)) continue;
    let entries: string[];
    try {
      entries = readdirSync(parent);
    } catch (err) {
      errors.push(`readdir ${parent}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const name of entries) {
      const entryPath = join(parent, name);
      let stats;
      try {
        stats = lstatSync(entryPath);
      } catch (err) {
        errors.push(`${entryPath}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (!isOlderThan(stats.mtimeMs, nowMs, maxAgeMs)) continue;
      if (removePath(entryPath, errors)) removed += 1;
    }
  }

  const ok = errors.length === 0;
  if (!ok) {
    reaperLog(opts.logger, 'warn', '[reaper-reclaim] automation work cleanup partial failures', {
      targetKey,
      errors,
    });
  }
  return {
    targetKey,
    ok,
    reason: ok ? 'automation-work' : 'cleanup-error',
    removed,
    detail: ok ? undefined : errors.slice(0, 5).join('; '),
  };
}

export function reclaimHourlySnapshotOverflow(
  opts: ReclaimHourlySnapshotsOptions = {},
): ReaperReclaimResult {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const backupDir = opts.backupDir ?? join(invokerHome, 'db-backups');
  const removed = pruneHourlySnapshots(backupDir, hourlySnapshotRetention());
  return {
    targetKey: backupDir,
    ok: true,
    reason: 'hourly-snapshot-retention',
    removed,
  };
}

function matchesGlob(name: string, glob: string): boolean {
  const escaped = glob
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(name);
}

function isKnownLogName(name: string): boolean {
  return KNOWN_LOG_FILE_NAMES.includes(name as (typeof KNOWN_LOG_FILE_NAMES)[number])
    || KNOWN_LOG_GLOBS.some((glob) => matchesGlob(name, glob));
}

function trimFileToTail(path: string, retainBytes: number): number {
  const fd = openSync(path, 'r+');
  try {
    const stats = fstatSync(fd);
    const keep = Math.min(retainBytes, stats.size);
    const buffer = Buffer.alloc(keep);
    readSync(fd, buffer, 0, keep, stats.size - keep);
    ftruncateSync(fd, 0);
    writeSync(fd, buffer, 0, keep, 0);
    ftruncateSync(fd, keep);
    return stats.size - keep;
  } finally {
    closeSync(fd);
  }
}

export function trimKnownInvokerLogs(opts: TrimKnownLogsOptions = {}): ReaperReclaimResult {
  const userHome = opts.userHome ?? homedir();
  const invokerHome = expandTildeHome(opts.invokerHome ?? resolveInvokerHomeRoot(), userHome);
  const targetKey = `local ${invokerHome}`;
  if (!isSafeInvokerHome(invokerHome, userHome)) {
    return { targetKey, ok: false, reason: 'path-guard', detail: invokerHome };
  }
  if (!existsSync(invokerHome)) {
    return { targetKey, ok: true, reason: 'known-log-trim', trimmed: 0 };
  }

  const thresholdBytes = Math.max(0, Math.floor(opts.thresholdBytes ?? LOG_TRIM_THRESHOLD_BYTES));
  const retainBytes = Math.max(0, Math.floor(opts.retainBytes ?? LOG_TRIM_RETAIN_BYTES));
  const errors: string[] = [];
  let trimmed = 0;

  let entries: string[];
  try {
    entries = readdirSync(invokerHome);
  } catch (err) {
    return {
      targetKey,
      ok: false,
      reason: 'readdir-error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  for (const name of entries) {
    if (!isKnownLogName(name)) continue;
    const entryPath = join(invokerHome, name);
    let stats;
    try {
      stats = lstatSync(entryPath);
    } catch (err) {
      errors.push(`${entryPath}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (!stats.isFile() || stats.size <= thresholdBytes) continue;
    try {
      trimmed += trimFileToTail(entryPath, retainBytes);
    } catch (err) {
      errors.push(`${entryPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const ok = errors.length === 0;
  if (!ok) {
    reaperLog(opts.logger, 'warn', '[reaper-reclaim] log trim partial failures', {
      targetKey,
      errors,
    });
  }
  return {
    targetKey,
    ok,
    reason: ok ? 'known-log-trim' : 'cleanup-error',
    trimmed,
    detail: ok ? undefined : errors.slice(0, 5).join('; '),
  };
}
