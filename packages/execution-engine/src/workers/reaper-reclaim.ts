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

import {
  expandTildeHome,
  isDeletingOrphanName,
  isSafeInvokerHome,
  isSafeRemoteInvokerHomePath,
} from './disk-headroom-reclaim.js';
import type { RemoteDiskTarget } from './disk-headroom-monitor.js';

export const DELETING_ORPHAN_MIN_AGE_MS = 30 * 60 * 1000;
export const AUTOMATION_WORK_MIN_AGE_MS = 48 * 60 * 60 * 1000;
export const LOG_TRIM_MAX_BYTES = 100 * 1024 * 1024;
export const LOG_TRIM_KEEP_BYTES = 20 * 1024 * 1024;

export const AUTOMATION_WORK_DIRS = [
  'mergify-admin-requeue-work',
  'land-admin-bypass-work',
] as const;

export const INVOKER_LOG_FILES = [
  'invoker.log',
  'gui.log',
] as const;

export const INVOKER_LOG_GLOBS = [
  'merge-trace*.log',
  'task-output/full/[0-9a-f]{64}.log',
  'slack-manager/*.log',
] as const;

export interface ReaperCleanupResult {
  targetKey: string;
  ok: boolean;
  reason: string;
  removed?: number;
  trimmed?: number;
  detail?: string;
}

export interface SnapshotRetentionHelpers {
  pruneHourlySnapshots: (backupDir: string, retain: number) => number;
  hourlySnapshotRetention: () => number;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function removePath(path: string, errors: string[]): boolean {
  try {
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch (err) {
    errors.push(`${path}: ${errMessage(err)}`);
    return false;
  }
}

function isOlderThan(path: string, cutoffMs: number, errors: string[]): boolean {
  try {
    return lstatSync(path).mtimeMs < cutoffMs;
  } catch (err) {
    errors.push(`stat ${path}: ${errMessage(err)}`);
    return false;
  }
}

function summarizeErrors(errors: readonly string[]): string | undefined {
  return errors.length === 0 ? undefined : errors.slice(0, 5).join('; ');
}

type SafeLocalHomeResult =
  | { ok: true; home: string }
  | { ok: false; result: ReaperCleanupResult };

function safeLocalHomeResult(
  invokerHome: string,
  userHome: string,
  targetKey: string,
): SafeLocalHomeResult {
  const home = expandTildeHome(invokerHome, userHome);
  if (!isSafeInvokerHome(home, userHome)) {
    return { ok: false, result: { targetKey, ok: false, reason: 'path-guard', detail: home } };
  }
  return { ok: true, home };
}

export function reclaimLocalDeletingOrphans(opts: {
  invokerHome?: string;
  userHome?: string;
  nowMs?: number;
  logger?: Logger;
} = {}): ReaperCleanupResult {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const targetKey = `local ${invokerHome}`;
  const safe = safeLocalHomeResult(invokerHome, opts.userHome ?? homedir(), targetKey);
  if (!safe.ok) return safe.result;

  const errors: string[] = [];
  let removed = 0;
  if (!existsSync(safe.home)) return { targetKey, ok: true, reason: 'deleting-orphans', removed };

  let names: string[];
  try {
    names = readdirSync(safe.home);
  } catch (err) {
    return { targetKey, ok: false, reason: 'cleanup-error', detail: errMessage(err), removed };
  }

  const cutoffMs = (opts.nowMs ?? Date.now()) - DELETING_ORPHAN_MIN_AGE_MS;
  for (const name of names) {
    if (!isDeletingOrphanName(name)) continue;
    const path = join(safe.home, name);
    if (!isOlderThan(path, cutoffMs, errors)) continue;
    if (removePath(path, errors)) removed += 1;
  }

  opts.logger?.debug?.('[reaper-reclaim] local deleting orphan sweep complete', {
    module: 'reaper-reclaim',
    targetKey,
    removed,
  });

  return {
    targetKey,
    ok: errors.length === 0,
    reason: errors.length === 0 ? 'deleting-orphans' : 'cleanup-error',
    removed,
    detail: summarizeErrors(errors),
  };
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
  rm -rf "$entry" >/dev/null 2>&1 && removed=$((removed + 1))
done < <(find "$INVOKER_HOME" -mindepth 1 -maxdepth 1 -name '*.deleting.*' -mmin +30 -print0 2>/dev/null)
echo "[reaper-reclaim] deleting-orphans removed=$removed"
exit 0
`;
}

function defaultRunRemoteDeletingOrphans(target: RemoteDiskTarget, script: string): Promise<string> {
  const sshArgs = buildSshConnectionArgs(target.connection, { batchMode: true });
  return execRemoteCapture({
    sshArgs,
    script,
    phase: `reaper-reclaim:deleting-orphans:${target.name}`,
  });
}

export async function reclaimRemoteDeletingOrphans(opts: {
  target: RemoteDiskTarget;
  logger?: Logger;
  runRemoteScript?: (target: RemoteDiskTarget, script: string) => Promise<string>;
}): Promise<ReaperCleanupResult> {
  const targetKey = `ssh:${opts.target.name} ${opts.target.remotePath}`;
  if (!isSafeRemoteInvokerHomePath(opts.target.remotePath)) {
    return { targetKey, ok: false, reason: 'path-guard', detail: opts.target.remotePath };
  }

  const script = buildDeletingOrphanReclaimScript(opts.target.remotePath);
  const run = opts.runRemoteScript ?? defaultRunRemoteDeletingOrphans;
  try {
    const output = await run(opts.target, script);
    opts.logger?.debug?.('[reaper-reclaim] remote deleting orphan sweep complete', {
      module: 'reaper-reclaim',
      targetKey,
      outputTail: output.slice(-400),
    });
    return { targetKey, ok: true, reason: 'deleting-orphans', detail: output.slice(-400) };
  } catch (err) {
    return { targetKey, ok: false, reason: 'cleanup-error', detail: errMessage(err) };
  }
}

export async function reclaimDeletingOrphans(opts: {
  invokerHome?: string;
  userHome?: string;
  remoteTargets?: RemoteDiskTarget[];
  nowMs?: number;
  logger?: Logger;
  runRemoteScript?: (target: RemoteDiskTarget, script: string) => Promise<string>;
} = {}): Promise<ReaperCleanupResult[]> {
  const local = reclaimLocalDeletingOrphans(opts);
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

export function reclaimAutomationCheckoutWork(opts: {
  invokerHome?: string;
  userHome?: string;
  nowMs?: number;
  logger?: Logger;
} = {}): ReaperCleanupResult {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const targetKey = `local ${invokerHome}`;
  const safe = safeLocalHomeResult(invokerHome, opts.userHome ?? homedir(), targetKey);
  if (!safe.ok) return safe.result;

  const errors: string[] = [];
  const cutoffMs = (opts.nowMs ?? Date.now()) - AUTOMATION_WORK_MIN_AGE_MS;
  let removed = 0;

  for (const dirName of AUTOMATION_WORK_DIRS) {
    const root = join(safe.home, dirName);
    if (!existsSync(root)) continue;
    let names: string[];
    try {
      names = readdirSync(root);
    } catch (err) {
      errors.push(`readdir ${root}: ${errMessage(err)}`);
      continue;
    }
    for (const name of names) {
      const child = join(root, name);
      if (!isOlderThan(child, cutoffMs, errors)) continue;
      if (removePath(child, errors)) removed += 1;
    }
  }

  opts.logger?.debug?.('[reaper-reclaim] automation checkout sweep complete', {
    module: 'reaper-reclaim',
    targetKey,
    removed,
  });

  return {
    targetKey,
    ok: errors.length === 0,
    reason: errors.length === 0 ? 'automation-checkout-work' : 'cleanup-error',
    removed,
    detail: summarizeErrors(errors),
  };
}

async function loadDefaultSnapshotRetentionHelpers(): Promise<SnapshotRetentionHelpers> {
  const jsUrl = new URL('../../../app/src/delete-all-snapshot.js', import.meta.url).href;
  try {
    return await import(jsUrl) as SnapshotRetentionHelpers;
  } catch {
    const tsUrl = new URL('../../../app/src/delete-all-snapshot.ts', import.meta.url).href;
    return await import(tsUrl) as SnapshotRetentionHelpers;
  }
}

export async function reclaimHourlySnapshots(opts: {
  invokerHome?: string;
  backupDir?: string;
  snapshotHelpers?: SnapshotRetentionHelpers;
  loadSnapshotHelpers?: () => Promise<SnapshotRetentionHelpers>;
  logger?: Logger;
} = {}): Promise<ReaperCleanupResult> {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const backupDir = opts.backupDir ?? join(invokerHome, 'db-backups');
  const targetKey = `local ${backupDir}`;
  const helpers = opts.snapshotHelpers ?? await (opts.loadSnapshotHelpers ?? loadDefaultSnapshotRetentionHelpers)();
  const retain = helpers.hourlySnapshotRetention();
  const removed = helpers.pruneHourlySnapshots(backupDir, retain);

  opts.logger?.debug?.('[reaper-reclaim] hourly snapshot prune complete', {
    module: 'reaper-reclaim',
    targetKey,
    retain,
    removed,
  });

  return { targetKey, ok: true, reason: 'hourly-snapshots', removed };
}

function collectInvokerLogPaths(invokerHome: string): string[] {
  const paths = new Set<string>();
  for (const name of INVOKER_LOG_FILES) {
    paths.add(join(invokerHome, name));
  }

  try {
    for (const name of readdirSync(invokerHome)) {
      if (name.startsWith('merge-trace') && name.endsWith('.log')) {
        paths.add(join(invokerHome, name));
      }
    }
  } catch {
    // Missing or unreadable homes simply have no globbed logs to trim.
  }

  try {
    const taskOutputFull = join(invokerHome, 'task-output', 'full');
    for (const name of readdirSync(taskOutputFull)) {
      if (/^[0-9a-f]{64}\.log$/.test(name)) {
        paths.add(join(taskOutputFull, name));
      }
    }
  } catch {
    // Optional log family.
  }

  try {
    const slackManager = join(invokerHome, 'slack-manager');
    for (const name of readdirSync(slackManager)) {
      if (name.endsWith('.log')) {
        paths.add(join(slackManager, name));
      }
    }
  } catch {
    // Optional log family.
  }

  return [...paths].sort();
}

function trimFileTail(path: string, maxBytes: number, keepBytes: number, errors: string[]): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r+');
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= maxBytes) return false;

    const bytesToKeep = Math.min(Math.max(keepBytes, 0), stat.size);
    const tail = Buffer.allocUnsafe(bytesToKeep);
    let readOffset = 0;
    while (readOffset < bytesToKeep) {
      const bytesRead = readSync(
        fd,
        tail,
        readOffset,
        bytesToKeep - readOffset,
        stat.size - bytesToKeep + readOffset,
      );
      if (bytesRead === 0) break;
      readOffset += bytesRead;
    }

    let writeOffset = 0;
    while (writeOffset < readOffset) {
      const bytesWritten = writeSync(fd, tail, writeOffset, readOffset - writeOffset, writeOffset);
      if (bytesWritten === 0) break;
      writeOffset += bytesWritten;
    }
    ftruncateSync(fd, writeOffset);
    return true;
  } catch (err) {
    if (existsSync(path)) errors.push(`${path}: ${errMessage(err)}`);
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Best effort cleanup of the file descriptor.
      }
    }
  }
}

export function trimInvokerLogs(opts: {
  invokerHome?: string;
  maxBytes?: number;
  keepBytes?: number;
  logger?: Logger;
} = {}): ReaperCleanupResult {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const targetKey = `local ${invokerHome}`;
  const maxBytes = opts.maxBytes ?? LOG_TRIM_MAX_BYTES;
  const keepBytes = opts.keepBytes ?? LOG_TRIM_KEEP_BYTES;
  const errors: string[] = [];
  let trimmed = 0;

  for (const path of collectInvokerLogPaths(invokerHome)) {
    if (trimFileTail(path, maxBytes, keepBytes, errors)) trimmed += 1;
  }

  opts.logger?.debug?.('[reaper-reclaim] log trim complete', {
    module: 'reaper-reclaim',
    targetKey,
    maxBytes,
    keepBytes,
    trimmed,
  });

  return {
    targetKey,
    ok: errors.length === 0,
    reason: errors.length === 0 ? 'log-trim' : 'cleanup-error',
    trimmed,
    detail: summarizeErrors(errors),
  };
}
