/**
 * Narrow recurring cleanup checks for Invoker-owned disk waste.
 *
 * Each function owns one cleanup category and only touches entries identified by
 * that category's established name, location, age, or size convention.
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Logger } from '@invoker/contracts';

import { buildSshConnectionArgs } from '../ssh-transport-options.js';
import { bashNormalizeTildePath, execRemoteCapture, shellPosixSingleQuote } from '../ssh-git-exec.js';

import {
  expandTildeHome,
  isDeletingOrphanName,
  isSafeInvokerHome,
  isSafeRemoteInvokerHomePath,
} from './disk-headroom-reclaim.js';
import type { RemoteDiskTarget } from './disk-headroom-monitor.js';

import {
  hourlySnapshotRetention,
  pruneHourlySnapshots,
  resolveInvokerHomeRoot,
} from '../../../app/src/delete-all-snapshot.js';

const MODULE = 'reaper-reclaim';

export const DELETING_ORPHAN_MIN_AGE_MS = 30 * 60 * 1000;
export const AUTOMATION_WORK_MIN_AGE_MS = 48 * 60 * 60 * 1000;
export const LOG_TRIM_THRESHOLD_BYTES = 100 * 1024 * 1024;
export const LOG_TRIM_KEEP_BYTES = 20 * 1024 * 1024;

export const AUTOMATION_CHECKOUT_WORK_DIRS = [
  'mergify-admin-requeue-work',
  'land-admin-bypass-work',
] as const;

export const KNOWN_REAPER_LOG_FILES = [
  'invoker.log',
  'gui.log',
] as const;

export const KNOWN_REAPER_LOG_GLOBS = [
  'merge-*.log',
] as const;

export interface ReaperReclaimResult {
  targetKey: string;
  ok: boolean;
  reason: string;
  removed?: number;
  trimmed?: number;
  detail?: string;
}

export interface ReapDeletingOrphansOptions {
  invokerHome?: string;
  userHome?: string;
  remoteTargets?: RemoteDiskTarget[];
  nowMs?: number;
  logger?: Logger;
  runRemoteScript?: (target: RemoteDiskTarget, script: string) => Promise<string>;
}

export interface ReapAutomationCheckoutWorkOptions {
  invokerHome?: string;
  userHome?: string;
  nowMs?: number;
  logger?: Logger;
}

export interface ReapHourlySnapshotOptions {
  backupDir?: string;
  invokerHome?: string;
}

export interface TrimKnownInvokerLogsOptions {
  invokerHome?: string;
  maxBytes?: number;
  keepBytes?: number;
  logger?: Logger;
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

function isOlderThan(path: string, cutoffMs: number, errors: string[]): boolean {
  try {
    return lstatSync(path).mtimeMs < cutoffMs;
  } catch (err) {
    errors.push(`stat ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function localDeletingOrphanResult(
  invokerHome: string,
  userHome: string,
  nowMs: number,
): ReaperReclaimResult {
  const targetKey = `local ${invokerHome}`;
  const home = expandTildeHome(invokerHome, userHome);
  if (!isSafeInvokerHome(home, userHome)) {
    return { targetKey, ok: false, reason: 'path-guard', detail: home };
  }
  if (!existsSync(home)) return { targetKey, ok: true, reason: 'deleting-orphans', removed: 0 };

  const cutoffMs = nowMs - DELETING_ORPHAN_MIN_AGE_MS;
  const errors: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(home);
  } catch (err) {
    return {
      targetKey,
      ok: false,
      reason: 'cleanup-error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  let removed = 0;
  for (const name of entries) {
    if (!isDeletingOrphanName(name)) continue;
    const path = join(home, name);
    if (!isOlderThan(path, cutoffMs, errors)) continue;
    if (removePath(path, errors)) removed += 1;
  }

  if (errors.length > 0) {
    return {
      targetKey,
      ok: false,
      reason: 'cleanup-error',
      removed,
      detail: errors.slice(0, 5).join('; '),
    };
  }
  return { targetKey, ok: true, reason: 'deleting-orphans', removed };
}

export function buildDeletingOrphanReclaimScript(invokerHome: string): string {
  const homeQ = shellPosixSingleQuote(invokerHome);
  const minAgeMinutes = Math.floor(DELETING_ORPHAN_MIN_AGE_MS / 60_000);
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
  rm -rf -- "$entry" >/dev/null 2>&1 && removed=$((removed + 1))
done < <(find "$INVOKER_HOME" -mindepth 1 -maxdepth 1 -name '*.deleting.*' -mmin +${minAgeMinutes} -print0 2>/dev/null)
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

async function remoteDeletingOrphanResult(
  target: RemoteDiskTarget,
  runRemoteScript: (target: RemoteDiskTarget, script: string) => Promise<string>,
): Promise<ReaperReclaimResult> {
  const targetKey = `ssh:${target.name} ${target.remotePath}`;
  if (!isSafeRemoteInvokerHomePath(target.remotePath)) {
    return { targetKey, ok: false, reason: 'path-guard', detail: target.remotePath };
  }

  const script = buildDeletingOrphanReclaimScript(target.remotePath);
  try {
    const output = await runRemoteScript(target, script);
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
      reason: 'cleanup-error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Reclaim stale `.deleting.` entries under the local Invoker home and every
 * configured remote target. This does not run the critical disk-pressure wipe.
 */
export async function reclaimDeletingOrphans(
  opts: ReapDeletingOrphansOptions = {},
): Promise<ReaperReclaimResult[]> {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const userHome = opts.userHome ?? homedir();
  const nowMs = opts.nowMs ?? Date.now();
  const results = [localDeletingOrphanResult(invokerHome, userHome, nowMs)];
  const runRemoteScript = opts.runRemoteScript ?? defaultRunRemoteDeletingOrphanReclaim;

  const remoteResults = await Promise.all(
    (opts.remoteTargets ?? []).map((target) => remoteDeletingOrphanResult(target, runRemoteScript)),
  );
  results.push(...remoteResults);

  for (const result of results) {
    if (result.ok) {
      opts.logger?.debug?.(`[reaper-reclaim] ${result.reason} ${result.targetKey}`, {
        module: MODULE,
        ...result,
      });
    } else {
      opts.logger?.warn?.(`[reaper-reclaim] ${result.reason} ${result.targetKey}`, {
        module: MODULE,
        ...result,
      });
    }
  }

  return results;
}

/**
 * Remove stale immediate children of known automation checkout work roots,
 * leaving the roots themselves and unrelated Invoker home entries untouched.
 */
export function reclaimAutomationCheckoutWork(
  opts: ReapAutomationCheckoutWorkOptions = {},
): ReaperReclaimResult {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const userHome = opts.userHome ?? homedir();
  const home = expandTildeHome(invokerHome, userHome);
  const targetKey = `local ${home}`;
  if (!isSafeInvokerHome(home, userHome)) {
    return { targetKey, ok: false, reason: 'path-guard', detail: home };
  }

  const cutoffMs = (opts.nowMs ?? Date.now()) - AUTOMATION_WORK_MIN_AGE_MS;
  const errors: string[] = [];
  let removed = 0;

  for (const dirName of AUTOMATION_CHECKOUT_WORK_DIRS) {
    const root = join(home, dirName);
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch (err) {
      errors.push(`readdir ${root}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const name of entries) {
      const path = join(root, name);
      if (!isOlderThan(path, cutoffMs, errors)) continue;
      if (removePath(path, errors)) removed += 1;
    }
  }

  if (errors.length > 0) {
    opts.logger?.warn?.('[reaper-reclaim] automation checkout cleanup partial failures', {
      module: MODULE,
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

  opts.logger?.debug?.('[reaper-reclaim] automation checkout cleanup done', {
    module: MODULE,
    targetKey,
    removed,
  });
  return { targetKey, ok: true, reason: 'automation-checkout-work', removed };
}

/**
 * Enforce the existing hourly snapshot retention limit on demand, independent
 * of successful snapshot creation.
 */
export function reclaimHourlySnapshotRetention(
  opts: ReapHourlySnapshotOptions = {},
): ReaperReclaimResult {
  const backupDir = opts.backupDir ?? join(opts.invokerHome ?? resolveInvokerHomeRoot(), 'db-backups');
  const removed = pruneHourlySnapshots(backupDir, hourlySnapshotRetention());
  return { targetKey: backupDir, ok: true, reason: 'hourly-snapshot-retention', removed };
}

function isKnownGlobLogName(name: string): boolean {
  return /^merge-.*\.log$/.test(name);
}

function knownInvokerLogPaths(invokerHome: string): string[] {
  const paths = new Set<string>();
  for (const name of KNOWN_REAPER_LOG_FILES) {
    paths.add(join(invokerHome, name));
  }
  let entries: string[] = [];
  try {
    entries = readdirSync(invokerHome);
  } catch {
    return [...paths];
  }
  for (const name of entries) {
    if (isKnownGlobLogName(name)) paths.add(join(invokerHome, name));
  }
  return [...paths];
}

function trimFileToTail(path: string, maxBytes: number, keepBytes: number, errors: string[]): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r+');
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= maxBytes) return false;

    const bytesToKeep = Math.min(keepBytes, stat.size);
    const buffer = Buffer.allocUnsafe(bytesToKeep);
    readSync(fd, buffer, 0, bytesToKeep, stat.size - bytesToKeep);
    ftruncateSync(fd, 0);
    writeSync(fd, buffer, 0, bytesToKeep, 0);
    return true;
  } catch (err) {
    if (existsSync(path)) {
      errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Bound known Invoker log files by rewriting oversized files in place to their
 * trailing window.
 */
export function trimKnownInvokerLogs(
  opts: TrimKnownInvokerLogsOptions = {},
): ReaperReclaimResult {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const maxBytes = opts.maxBytes ?? LOG_TRIM_THRESHOLD_BYTES;
  const keepBytes = opts.keepBytes ?? LOG_TRIM_KEEP_BYTES;
  const targetKey = `local ${invokerHome}`;
  const errors: string[] = [];
  let trimmed = 0;

  for (const path of knownInvokerLogPaths(invokerHome)) {
    if (trimFileToTail(path, maxBytes, keepBytes, errors)) trimmed += 1;
  }

  if (errors.length > 0) {
    opts.logger?.warn?.('[reaper-reclaim] log trim partial failures', { module: MODULE, errors });
    return {
      targetKey,
      ok: false,
      reason: 'cleanup-error',
      trimmed,
      detail: errors.slice(0, 5).join('; '),
    };
  }
  opts.logger?.debug?.('[reaper-reclaim] log trim done', { module: MODULE, targetKey, trimmed });
  return { targetKey, ok: true, reason: 'known-log-trim', trimmed };
}
