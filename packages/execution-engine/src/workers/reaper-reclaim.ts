import {
  closeSync,
  existsSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Logger } from '@invoker/contracts';

import {
  hourlySnapshotRetention,
  pruneHourlySnapshots,
} from '../../../app/src/delete-all-snapshot.js';
import { buildSshConnectionArgs } from '../ssh-transport-options.js';
import { bashNormalizeTildePath, execRemoteCapture, shellPosixSingleQuote } from '../ssh-git-exec.js';
import { resolveInvokerHomeRoot } from '../worker-lock.js';

import {
  expandTildeHome,
  isDeletingOrphanName,
  isSafeInvokerHome,
  isSafeRemoteInvokerHomePath,
} from './disk-headroom-reclaim.js';
import type { RemoteDiskTarget } from './disk-headroom-monitor.js';

export const REAPER_DELETING_ORPHAN_MIN_AGE_MINUTES = 30;
export const REAPER_DELETING_ORPHAN_MIN_AGE_MS =
  REAPER_DELETING_ORPHAN_MIN_AGE_MINUTES * 60 * 1000;
export const REAPER_AUTOMATION_WORK_MIN_AGE_MS = 48 * 60 * 60 * 1000;
export const REAPER_LOG_TRIM_THRESHOLD_BYTES = 100 * 1024 * 1024;
export const REAPER_LOG_TRIM_KEEP_BYTES = 20 * 1024 * 1024;

export const REAPER_AUTOMATION_WORK_DIRS = [
  'mergify-admin-requeue-work',
  'land-admin-bypass-work',
] as const;

export const REAPER_FIXED_LOG_FILES = [
  'invoker.log',
  'gui.log',
] as const;

const UI_EVENT_LOG_NAME_RE = /^ui-[a-z0-9-]+-events\.jsonl$/;

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
  runRemoteScript?: (target: RemoteDiskTarget, script: string) => Promise<string>;
}

export interface ReaperLocalOptions {
  invokerHome?: string;
  logger?: Logger;
  userHome?: string;
  nowMs?: number;
}

export interface ReaperSnapshotOptions {
  invokerHome?: string;
  backupDir?: string;
}

export interface ReaperLogOptions {
  invokerHome?: string;
  logger?: Logger;
  userHome?: string;
  thresholdBytes?: number;
  keepBytes?: number;
}

function isOlderThan(mtimeMs: number, nowMs: number, minAgeMs: number): boolean {
  return nowMs - mtimeMs >= minAgeMs;
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

function removeOldImmediateChildren(opts: {
  parentDir: string;
  nowMs: number;
  minAgeMs: number;
  matchName: (name: string) => boolean;
  errors: string[];
}): number {
  if (!existsSync(opts.parentDir)) return 0;

  let names: string[];
  try {
    names = readdirSync(opts.parentDir);
  } catch (err) {
    opts.errors.push(`readdir ${opts.parentDir}: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }

  let removed = 0;
  for (const name of names) {
    if (!opts.matchName(name)) continue;
    const path = join(opts.parentDir, name);
    let mtimeMs: number;
    try {
      mtimeMs = lstatSync(path).mtimeMs;
    } catch (err) {
      opts.errors.push(`stat ${path}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (!isOlderThan(mtimeMs, opts.nowMs, opts.minAgeMs)) continue;
    if (removePath(path, opts.errors)) removed += 1;
  }
  return removed;
}

function buildLocalResult(
  targetKey: string,
  reason: string,
  removed: number,
  errors: string[],
): ReaperReclaimResult {
  if (errors.length > 0) {
    return {
      targetKey,
      ok: false,
      reason: 'reclaim-error',
      removed,
      detail: errors.slice(0, 5).join('; '),
    };
  }
  return { targetKey, ok: true, reason, removed };
}

function reclaimLocalDeletingOrphans(opts: Required<Pick<ReclaimDeletingOrphansOptions, 'invokerHome' | 'userHome' | 'nowMs'>>): ReaperReclaimResult {
  const home = expandTildeHome(opts.invokerHome, opts.userHome);
  const targetKey = `local ${home}`;
  if (!isSafeInvokerHome(home, opts.userHome)) {
    return { targetKey, ok: false, reason: 'path-guard', detail: home };
  }

  const errors: string[] = [];
  const removed = removeOldImmediateChildren({
    parentDir: home,
    nowMs: opts.nowMs,
    minAgeMs: REAPER_DELETING_ORPHAN_MIN_AGE_MS,
    matchName: isDeletingOrphanName,
    errors,
  });
  return buildLocalResult(targetKey, 'deleting-orphans', removed, errors);
}

export function buildDeletingOrphanReclaimScript(invokerHome: string): string {
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
  if rm -rf "$entry" >/dev/null 2>&1; then
    removed=$((removed + 1))
  fi
done < <(find "$INVOKER_HOME" -mindepth 1 -maxdepth 1 -name '*.deleting.*' -mmin +${REAPER_DELETING_ORPHAN_MIN_AGE_MINUTES} -print0 2>/dev/null)
echo "[reaper-reclaim] deleting-orphans removed=$removed"
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
    phase: `reaper-reclaim:deleting-orphans:${target.name}`,
  });
}

async function reclaimRemoteDeletingOrphans(opts: {
  target: RemoteDiskTarget;
  runRemoteScript: (target: RemoteDiskTarget, script: string) => Promise<string>;
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

  const script = buildDeletingOrphanReclaimScript(opts.target.remotePath);
  try {
    const output = await opts.runRemoteScript(opts.target, script);
    return {
      targetKey,
      ok: true,
      reason: 'deleting-orphans',
      detail: output.slice(-400),
    };
  } catch (err) {
    return {
      targetKey,
      ok: false,
      reason: 'reclaim-error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function reclaimStaleDeletingOrphans(
  opts: ReclaimDeletingOrphansOptions = {},
): Promise<ReaperReclaimResult[]> {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const userHome = opts.userHome ?? homedir();
  const nowMs = opts.nowMs ?? Date.now();
  const runRemoteScript = opts.runRemoteScript ?? defaultRunRemoteDeletingOrphanReclaim;

  opts.logger?.info?.('[reaper-reclaim] deleting-orphans begin', {
    module: 'reaper-reclaim',
    invokerHome,
    remoteTargetCount: opts.remoteTargets?.length ?? 0,
  });

  const local = reclaimLocalDeletingOrphans({ invokerHome, userHome, nowMs });
  const remotes = await Promise.all(
    (opts.remoteTargets ?? []).map((target) =>
      reclaimRemoteDeletingOrphans({ target, runRemoteScript }),
    ),
  );

  return [local, ...remotes];
}

export function reclaimStaleAutomationCheckoutWork(
  opts: ReaperLocalOptions = {},
): ReaperReclaimResult {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const userHome = opts.userHome ?? homedir();
  const home = expandTildeHome(invokerHome, userHome);
  const targetKey = `local ${home}`;
  if (!isSafeInvokerHome(home, userHome)) {
    return { targetKey, ok: false, reason: 'path-guard', detail: home };
  }

  const nowMs = opts.nowMs ?? Date.now();
  const errors: string[] = [];
  let removed = 0;
  for (const name of REAPER_AUTOMATION_WORK_DIRS) {
    removed += removeOldImmediateChildren({
      parentDir: join(home, name),
      nowMs,
      minAgeMs: REAPER_AUTOMATION_WORK_MIN_AGE_MS,
      matchName: () => true,
      errors,
    });
  }

  if (errors.length > 0) {
    opts.logger?.warn?.('[reaper-reclaim] automation checkout cleanup partial failure', {
      module: 'reaper-reclaim',
      errors,
    });
  }
  return buildLocalResult(targetKey, 'automation-checkout-work', removed, errors);
}

export function reclaimHourlySnapshotRetention(opts: ReaperSnapshotOptions = {}): number {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const backupDir = opts.backupDir ?? join(invokerHome, 'db-backups');
  return pruneHourlySnapshots(backupDir, hourlySnapshotRetention());
}

function collectKnownLogPaths(invokerHome: string): string[] {
  const paths = new Set<string>();
  for (const name of REAPER_FIXED_LOG_FILES) {
    paths.add(join(invokerHome, name));
  }

  let names: string[];
  try {
    names = readdirSync(invokerHome);
  } catch {
    return [...paths];
  }

  for (const name of names) {
    if (UI_EVENT_LOG_NAME_RE.test(name)) {
      paths.add(join(invokerHome, name));
    }
  }
  return [...paths];
}

function trimLogFileIfNeeded(opts: {
  path: string;
  thresholdBytes: number;
  keepBytes: number;
  errors: string[];
}): boolean {
  let size: number;
  try {
    const stat = statSync(opts.path);
    if (!stat.isFile()) return false;
    size = stat.size;
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return false;
    opts.errors.push(`stat ${opts.path}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }

  if (size <= opts.thresholdBytes) return false;

  const bytesToKeep = Math.min(opts.keepBytes, size);
  const buffer = Buffer.allocUnsafe(bytesToKeep);
  let fd: number | undefined;
  try {
    fd = openSync(opts.path, 'r+');
    const bytesRead = readSync(fd, buffer, 0, bytesToKeep, size - bytesToKeep);
    ftruncateSync(fd, 0);

    let written = 0;
    while (written < bytesRead) {
      written += writeSync(fd, buffer, written, bytesRead - written, written);
    }
    ftruncateSync(fd, bytesRead);
    return true;
  } catch (err) {
    opts.errors.push(`trim ${opts.path}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* Best-effort cleanup after a failed trim. */
      }
    }
  }
}

export function trimKnownInvokerHomeLogs(opts: ReaperLogOptions = {}): ReaperReclaimResult {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const userHome = opts.userHome ?? homedir();
  const home = expandTildeHome(invokerHome, userHome);
  const targetKey = `local ${home}`;
  if (!isSafeInvokerHome(home, userHome)) {
    return { targetKey, ok: false, reason: 'path-guard', detail: home };
  }

  const thresholdBytes = Math.max(0, Math.floor(opts.thresholdBytes ?? REAPER_LOG_TRIM_THRESHOLD_BYTES));
  const keepBytes = Math.max(1, Math.floor(opts.keepBytes ?? REAPER_LOG_TRIM_KEEP_BYTES));
  const errors: string[] = [];
  let trimmed = 0;
  for (const path of collectKnownLogPaths(home)) {
    if (trimLogFileIfNeeded({ path, thresholdBytes, keepBytes, errors })) {
      trimmed += 1;
    }
  }

  if (errors.length > 0) {
    opts.logger?.warn?.('[reaper-reclaim] log trim partial failure', {
      module: 'reaper-reclaim',
      errors,
    });
  }
  const result = buildLocalResult(targetKey, 'known-log-trim', 0, errors);
  return { ...result, trimmed };
}
