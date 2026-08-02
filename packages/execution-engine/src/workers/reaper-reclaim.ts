/**
 * Narrow reaper cleanup checks for accumulated Invoker-managed disk waste.
 *
 * These checks intentionally stay independent from the critical disk-pressure
 * cleaner: each one acts only on its own established name, age, retention, or
 * log-size convention.
 */

import {
  closeSync,
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

import { hourlySnapshotRetention, pruneHourlySnapshots } from '../../../app/src/delete-all-snapshot.js';
import { buildSshConnectionArgs } from '../ssh-transport-options.js';
import { bashNormalizeTildePath, execRemoteCapture, shellPosixSingleQuote } from '../ssh-git-exec.js';

import {
  expandTildeHome,
  isDeletingOrphanName,
  isSafeInvokerHome,
  isSafeRemoteInvokerHomePath,
} from './disk-headroom-reclaim.js';
import type { RemoteDiskTarget } from './disk-headroom-monitor.js';

const MODULE = 'reaper-reclaim';

export const DELETING_ORPHAN_MIN_AGE_MINUTES = 30;
export const DELETING_ORPHAN_MIN_AGE_MS = DELETING_ORPHAN_MIN_AGE_MINUTES * 60 * 1000;

export const AUTOMATION_CHECKOUT_WORK_DIRS = [
  'mergify-admin-requeue-work',
  'land-admin-bypass-work',
] as const;
export const AUTOMATION_CHECKOUT_WORK_MIN_AGE_MS = 48 * 60 * 60 * 1000;

export const INVOKER_LOG_TRIM_PATHS = ['invoker.log', 'gui.log'] as const;
export const INVOKER_LOG_TRIM_GLOBS = ['merge-trace*.log'] as const;
export const INVOKER_LOG_MAX_BYTES = 100 * 1024 * 1024;
export const INVOKER_LOG_KEEP_BYTES = 20 * 1024 * 1024;

export interface ReaperCleanupResult {
  targetKey: string;
  ok: boolean;
  reason: string;
  removed?: number;
  trimmed?: number;
  detail?: string;
}

export interface ReclaimDeletingOrphansOptions {
  localPath?: string;
  remoteTargets?: RemoteDiskTarget[];
  logger?: Logger;
  userHome?: string;
  nowMs?: number;
  runRemoteScript?: (target: RemoteDiskTarget, script: string) => Promise<string>;
}

export interface ReclaimAutomationCheckoutWorkOptions {
  invokerHome?: string;
  logger?: Logger;
  userHome?: string;
  nowMs?: number;
}

export interface ReclaimHourlySnapshotsOptions {
  invokerHome?: string;
  backupDir?: string;
  logger?: Logger;
  userHome?: string;
}

export interface TrimInvokerHomeLogsOptions {
  invokerHome?: string;
  logger?: Logger;
  userHome?: string;
  maxBytes?: number;
  keepBytes?: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errnoCode(err: unknown): string | undefined {
  return err instanceof Error && 'code' in err
    ? String((err as NodeJS.ErrnoException).code)
    : undefined;
}

function pathGuardResult(targetKey: string, detail: string): ReaperCleanupResult {
  return { targetKey, ok: false, reason: 'path-guard', detail };
}

function cleanupErrorResult(
  targetKey: string,
  errors: string[],
  fields: Partial<ReaperCleanupResult> = {},
): ReaperCleanupResult {
  return {
    targetKey,
    ok: false,
    reason: 'cleanup-error',
    detail: errors.slice(0, 5).join('; '),
    ...fields,
  };
}

function isOlderThan(statMtimeMs: number, minAgeMs: number, nowMs: number): boolean {
  return nowMs - statMtimeMs > minAgeMs;
}

function removeLocalEntry(path: string, errors: string[]): boolean {
  try {
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch (err) {
    errors.push(`${path}: ${errorMessage(err)}`);
    return false;
  }
}

function readdirIfPresent(path: string, errors: string[]): string[] {
  try {
    return readdirSync(path);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return [];
    errors.push(`readdir ${path}: ${errorMessage(err)}`);
    return [];
  }
}

function resolveSafeInvokerHome(
  invokerHome: string,
  userHome: string | undefined,
): { home: string; userHome: string; error?: ReaperCleanupResult } {
  const resolvedUserHome = userHome ?? homedir();
  const home = expandTildeHome(invokerHome, resolvedUserHome);
  if (!isSafeInvokerHome(home, resolvedUserHome)) {
    return {
      home,
      userHome: resolvedUserHome,
      error: pathGuardResult(`local ${invokerHome}`, home),
    };
  }
  return { home, userHome: resolvedUserHome };
}

function reclaimLocalDeletingOrphans(opts: {
  invokerHome: string;
  logger?: Logger;
  userHome?: string;
  nowMs: number;
}): ReaperCleanupResult {
  const targetKey = `local ${opts.invokerHome}`;
  const resolved = resolveSafeInvokerHome(opts.invokerHome, opts.userHome);
  if (resolved.error) return { ...resolved.error, targetKey };

  const errors: string[] = [];
  const entries = readdirIfPresent(resolved.home, errors);
  let removed = 0;
  for (const name of entries) {
    if (!isDeletingOrphanName(name)) continue;

    const entryPath = join(resolved.home, name);
    try {
      const stat = lstatSync(entryPath);
      if (!isOlderThan(stat.mtimeMs, DELETING_ORPHAN_MIN_AGE_MS, opts.nowMs)) continue;
      if (removeLocalEntry(entryPath, errors)) removed += 1;
    } catch (err) {
      if (errnoCode(err) !== 'ENOENT') {
        errors.push(`stat ${entryPath}: ${errorMessage(err)}`);
      }
    }
  }

  if (errors.length > 0) {
    opts.logger?.warn?.('[reaper-reclaim] local deleting orphan cleanup partial failures', {
      module: MODULE,
      targetKey,
      errors,
    });
    return cleanupErrorResult(targetKey, errors, { removed });
  }

  opts.logger?.info?.('[reaper-reclaim] local deleting orphan cleanup done', {
    module: MODULE,
    targetKey,
    removed,
  });
  return { targetKey, ok: true, reason: 'stale-deleting-orphans', removed };
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
  name="\${entry##*/}"
  case "$name" in
    *'.deleting.'*)
      if rm -rf "$entry" >/dev/null 2>&1; then
        removed=$((removed + 1))
      fi
      ;;
  esac
done < <(find "$INVOKER_HOME" -mindepth 1 -maxdepth 1 -mmin +${DELETING_ORPHAN_MIN_AGE_MINUTES} -print0 2>/dev/null)
echo "__INVOKER_REAPER_REMOVED__=$removed"
exit 0
`;
}

function parseRemovedCount(output: string): number | undefined {
  const match = output.match(/__INVOKER_REAPER_REMOVED__=(\d+)/);
  return match ? Number.parseInt(match[1] ?? '', 10) : undefined;
}

function defaultRunRemoteReaperScript(target: RemoteDiskTarget, script: string): Promise<string> {
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
    return pathGuardResult(targetKey, opts.target.remotePath);
  }

  const script = buildDeletingOrphanReclaimScript(opts.target.remotePath);
  const run = opts.runRemoteScript ?? defaultRunRemoteReaperScript;
  try {
    const output = await run(opts.target, script);
    const removed = parseRemovedCount(output);
    opts.logger?.info?.('[reaper-reclaim] remote deleting orphan cleanup done', {
      module: MODULE,
      targetKey,
      removed,
      outputTail: output.slice(-400),
    });
    return {
      targetKey,
      ok: true,
      reason: 'stale-deleting-orphans',
      removed,
      detail: output.slice(-400),
    };
  } catch (err) {
    const detail = errorMessage(err);
    opts.logger?.warn?.('[reaper-reclaim] remote deleting orphan cleanup failed', {
      module: MODULE,
      targetKey,
      detail,
    });
    return { targetKey, ok: false, reason: 'cleanup-error', detail };
  }
}

export async function reclaimDeletingOrphans(
  opts: ReclaimDeletingOrphansOptions = {},
): Promise<ReaperCleanupResult[]> {
  const localPath = opts.localPath ?? resolveInvokerHomeRoot();
  const nowMs = opts.nowMs ?? Date.now();
  const local = reclaimLocalDeletingOrphans({
    invokerHome: localPath,
    logger: opts.logger,
    userHome: opts.userHome,
    nowMs,
  });

  const remotes = await Promise.all(
    (opts.remoteTargets ?? []).map((target) =>
      reclaimRemoteDeletingOrphans({
        target,
        logger: opts.logger,
        runRemoteScript: opts.runRemoteScript,
      }),
    ),
  );

  return [local, ...remotes];
}

export function reclaimAutomationCheckoutWork(
  opts: ReclaimAutomationCheckoutWorkOptions = {},
): ReaperCleanupResult {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const targetKey = `local ${invokerHome}`;
  const resolved = resolveSafeInvokerHome(invokerHome, opts.userHome);
  if (resolved.error) return { ...resolved.error, targetKey };

  const nowMs = opts.nowMs ?? Date.now();
  const errors: string[] = [];
  let removed = 0;
  for (const dirname of AUTOMATION_CHECKOUT_WORK_DIRS) {
    const parent = join(resolved.home, dirname);
    const entries = readdirIfPresent(parent, errors);
    for (const name of entries) {
      const entryPath = join(parent, name);
      try {
        const stat = lstatSync(entryPath);
        if (!isOlderThan(stat.mtimeMs, AUTOMATION_CHECKOUT_WORK_MIN_AGE_MS, nowMs)) continue;
        if (removeLocalEntry(entryPath, errors)) removed += 1;
      } catch (err) {
        if (errnoCode(err) !== 'ENOENT') {
          errors.push(`stat ${entryPath}: ${errorMessage(err)}`);
        }
      }
    }
  }

  if (errors.length > 0) {
    opts.logger?.warn?.('[reaper-reclaim] automation checkout cleanup partial failures', {
      module: MODULE,
      targetKey,
      errors,
    });
    return cleanupErrorResult(targetKey, errors, { removed });
  }

  opts.logger?.info?.('[reaper-reclaim] automation checkout cleanup done', {
    module: MODULE,
    targetKey,
    removed,
  });
  return { targetKey, ok: true, reason: 'automation-checkout-work', removed };
}

export function reclaimHourlySnapshots(
  opts: ReclaimHourlySnapshotsOptions = {},
): ReaperCleanupResult {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const targetKey = opts.backupDir ?? join(invokerHome, 'db-backups');
  const resolved = resolveSafeInvokerHome(invokerHome, opts.userHome);
  if (resolved.error) return pathGuardResult(targetKey, resolved.home);

  const backupDir = opts.backupDir ?? join(resolved.home, 'db-backups');
  try {
    const removed = pruneHourlySnapshots(backupDir, hourlySnapshotRetention());
    opts.logger?.info?.('[reaper-reclaim] hourly snapshot prune done', {
      module: MODULE,
      targetKey: backupDir,
      removed,
    });
    return { targetKey: backupDir, ok: true, reason: 'hourly-snapshot-prune', removed };
  } catch (err) {
    const detail = errorMessage(err);
    opts.logger?.warn?.('[reaper-reclaim] hourly snapshot prune failed', {
      module: MODULE,
      targetKey: backupDir,
      detail,
    });
    return { targetKey: backupDir, ok: false, reason: 'cleanup-error', detail };
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesSimpleGlob(name: string, pattern: string): boolean {
  const re = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`);
  return re.test(name);
}

function discoverInvokerLogPaths(invokerHome: string, errors: string[]): string[] {
  const names = new Set<string>(INVOKER_LOG_TRIM_PATHS);
  for (const name of readdirIfPresent(invokerHome, errors)) {
    if (INVOKER_LOG_TRIM_GLOBS.some((glob) => matchesSimpleGlob(name, glob))) {
      names.add(name);
    }
  }
  return [...names].map((name) => join(invokerHome, name));
}

function rewriteFileToTail(path: string, keepBytes: number): void {
  const stat = lstatSync(path);
  if (!stat.isFile()) return;
  const bytesToKeep = Math.min(Math.max(0, keepBytes), stat.size);
  const start = stat.size - bytesToKeep;
  const fd = openSync(path, 'r+');
  try {
    const buffer = Buffer.alloc(bytesToKeep);
    let readOffset = 0;
    while (readOffset < bytesToKeep) {
      const bytesRead = readSync(
        fd,
        buffer,
        readOffset,
        bytesToKeep - readOffset,
        start + readOffset,
      );
      if (bytesRead === 0) break;
      readOffset += bytesRead;
    }

    ftruncateSync(fd, 0);
    let writeOffset = 0;
    while (writeOffset < readOffset) {
      const bytesWritten = writeSync(
        fd,
        buffer,
        writeOffset,
        readOffset - writeOffset,
        writeOffset,
      );
      if (bytesWritten === 0) break;
      writeOffset += bytesWritten;
    }
    ftruncateSync(fd, writeOffset);
  } finally {
    closeSync(fd);
  }
}

export function trimInvokerHomeLogs(
  opts: TrimInvokerHomeLogsOptions = {},
): ReaperCleanupResult {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const targetKey = `local ${invokerHome}`;
  const resolved = resolveSafeInvokerHome(invokerHome, opts.userHome);
  if (resolved.error) return { ...resolved.error, targetKey };

  const maxBytes = Math.max(0, opts.maxBytes ?? INVOKER_LOG_MAX_BYTES);
  const keepBytes = Math.max(0, opts.keepBytes ?? INVOKER_LOG_KEEP_BYTES);
  const errors: string[] = [];
  let trimmed = 0;
  for (const logPath of discoverInvokerLogPaths(resolved.home, errors)) {
    try {
      const stat = lstatSync(logPath);
      if (!stat.isFile() || stat.size <= maxBytes) continue;
      rewriteFileToTail(logPath, keepBytes);
      trimmed += 1;
    } catch (err) {
      if (errnoCode(err) !== 'ENOENT') {
        errors.push(`${logPath}: ${errorMessage(err)}`);
      }
    }
  }

  if (errors.length > 0) {
    opts.logger?.warn?.('[reaper-reclaim] log trim partial failures', {
      module: MODULE,
      targetKey,
      errors,
    });
    return cleanupErrorResult(targetKey, errors, { trimmed });
  }

  opts.logger?.info?.('[reaper-reclaim] log trim done', {
    module: MODULE,
    targetKey,
    trimmed,
  });
  return { targetKey, ok: true, reason: 'log-trim', trimmed };
}
