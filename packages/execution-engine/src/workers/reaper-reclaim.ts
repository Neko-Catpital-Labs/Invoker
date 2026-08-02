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
import { resolveInvokerHomeRoot } from '../worker-lock.js';

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
} from '../../../app/src/delete-all-snapshot.js';

const MODULE = 'reaper-reclaim';

export const DELETING_ORPHAN_MIN_AGE_MS = 30 * 60 * 1000;
export const AUTOMATION_CHECKOUT_MAX_AGE_MS = 48 * 60 * 60 * 1000;
export const LOG_TRIM_MAX_BYTES = 100 * 1024 * 1024;
export const LOG_TRIM_KEEP_BYTES = 20 * 1024 * 1024;

export const AUTOMATION_CHECKOUT_ROOTS = [
  'mergify-admin-requeue-work',
  'land-admin-bypass-work',
] as const;

export const KNOWN_INVOKER_LOG_NAMES = [
  'invoker.log',
  'gui.log',
] as const;

export const KNOWN_INVOKER_LOG_GLOBS = [
  'merge-*.log',
  'ui-*-events.jsonl',
] as const;

export interface ReaperCleanupResult {
  ok: boolean;
  reason: string;
  removed?: number;
  trimmed?: number;
  detail?: string;
}

export interface ReaperTargetCleanupResult extends ReaperCleanupResult {
  targetKey: string;
}

export type ReaperRemoteScriptRunner = (
  target: RemoteDiskTarget,
  script: string,
) => Promise<string>;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function safeLocalInvokerHome(
  invokerHome: string,
  userHome: string,
): { ok: true; home: string } | { ok: false; home: string } {
  const home = expandTildeHome(invokerHome, userHome);
  if (!isSafeInvokerHome(home, userHome)) {
    return { ok: false, home };
  }
  return { ok: true, home };
}

function removePath(path: string, errors: string[]): boolean {
  try {
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch (err) {
    errors.push(`${path}: ${errorMessage(err)}`);
    return false;
  }
}

function isOlderThan(path: string, cutoffMs: number, errors: string[]): boolean {
  try {
    return lstatSync(path).mtimeMs < cutoffMs;
  } catch (err) {
    errors.push(`stat ${path}: ${errorMessage(err)}`);
    return false;
  }
}

function cleanupErrorsResult(reason: string, removed: number, errors: string[]): ReaperCleanupResult {
  if (errors.length === 0) return { ok: true, reason, removed };
  return {
    ok: false,
    reason: 'cleanup-error',
    removed,
    detail: errors.slice(0, 5).join('; '),
  };
}

function cleanupLocalDeletingOrphans(opts: {
  invokerHome: string;
  targetKey: string;
  userHome: string;
  nowMs: number;
  minAgeMs: number;
  logger?: Logger;
}): ReaperTargetCleanupResult {
  const safe = safeLocalInvokerHome(opts.invokerHome, opts.userHome);
  if (!safe.ok) {
    return { targetKey: opts.targetKey, ok: false, reason: 'path-guard', detail: safe.home };
  }

  if (!existsSync(safe.home)) {
    return { targetKey: opts.targetKey, ok: true, reason: 'deleting-orphans', removed: 0 };
  }

  const errors: string[] = [];
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(safe.home);
  } catch (err) {
    return {
      targetKey: opts.targetKey,
      ok: false,
      reason: 'cleanup-error',
      detail: `readdir ${safe.home}: ${errorMessage(err)}`,
      removed,
    };
  }

  const cutoffMs = opts.nowMs - opts.minAgeMs;
  for (const name of entries) {
    if (!isDeletingOrphanName(name)) continue;
    const entryPath = join(safe.home, name);
    if (!isOlderThan(entryPath, cutoffMs, errors)) continue;
    if (removePath(entryPath, errors)) removed += 1;
  }

  const result = cleanupErrorsResult('deleting-orphans', removed, errors);
  opts.logger?.debug?.('[reaper-reclaim] local deleting orphan pass', {
    module: MODULE,
    targetKey: opts.targetKey,
    removed,
    ok: result.ok,
  });
  return { targetKey: opts.targetKey, ...result };
}

export function buildDeletingOrphanReclaimScript(
  invokerHome: string,
  minAgeMinutes: number = DELETING_ORPHAN_MIN_AGE_MS / 60_000,
): string {
  const homeQ = shellPosixSingleQuote(invokerHome);
  const safeMinAgeMinutes = Math.max(0, Math.floor(minAgeMinutes));
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
done < <(find "$INVOKER_HOME" -mindepth 1 -maxdepth 1 -name '*.deleting.*' -mmin +${safeMinAgeMinutes} -print0 2>/dev/null)
echo "[reaper-reclaim] deleting-orphans removed=$removed home=$INVOKER_HOME"
exit 0
`;
}

function defaultRunRemoteDeletingOrphans(
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

async function cleanupRemoteDeletingOrphans(opts: {
  target: RemoteDiskTarget;
  minAgeMs: number;
  logger?: Logger;
  runRemoteScript?: ReaperRemoteScriptRunner;
}): Promise<ReaperTargetCleanupResult> {
  const targetKey = `ssh:${opts.target.name} ${opts.target.remotePath}`;
  if (!isSafeRemoteInvokerHomePath(opts.target.remotePath)) {
    return { targetKey, ok: false, reason: 'path-guard', detail: opts.target.remotePath };
  }

  const minAgeMinutes = Math.ceil(opts.minAgeMs / 60_000);
  const script = buildDeletingOrphanReclaimScript(opts.target.remotePath, minAgeMinutes);
  const run = opts.runRemoteScript ?? defaultRunRemoteDeletingOrphans;
  try {
    const output = await run(opts.target, script);
    opts.logger?.debug?.('[reaper-reclaim] remote deleting orphan pass', {
      module: MODULE,
      targetKey,
      outputTail: output.slice(-400),
    });
    return {
      targetKey,
      ok: true,
      reason: 'deleting-orphans',
      detail: output.slice(-400),
    };
  } catch (err) {
    const detail = errorMessage(err);
    opts.logger?.warn?.(`[reaper-reclaim] remote deleting orphan pass failed ${targetKey}: ${detail}`, {
      module: MODULE,
      targetKey,
    });
    return { targetKey, ok: false, reason: 'cleanup-error', detail };
  }
}

export async function reclaimDeletingOrphans(opts: {
  invokerHome?: string;
  remoteTargets?: RemoteDiskTarget[];
  userHome?: string;
  nowMs?: number;
  minAgeMs?: number;
  logger?: Logger;
  runRemoteScript?: ReaperRemoteScriptRunner;
} = {}): Promise<ReaperTargetCleanupResult[]> {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const localTargetKey = `local ${invokerHome}`;
  const nowMs = opts.nowMs ?? Date.now();
  const minAgeMs = opts.minAgeMs ?? DELETING_ORPHAN_MIN_AGE_MS;
  const local = cleanupLocalDeletingOrphans({
    invokerHome,
    targetKey: localTargetKey,
    userHome: opts.userHome ?? homedir(),
    nowMs,
    minAgeMs,
    logger: opts.logger,
  });

  const remotes = await Promise.all(
    (opts.remoteTargets ?? []).map((target) =>
      cleanupRemoteDeletingOrphans({
        target,
        minAgeMs,
        logger: opts.logger,
        runRemoteScript: opts.runRemoteScript,
      })),
  );
  return [local, ...remotes];
}

export function reclaimStaleAutomationCheckouts(opts: {
  invokerHome?: string;
  userHome?: string;
  nowMs?: number;
  maxAgeMs?: number;
  logger?: Logger;
} = {}): ReaperCleanupResult {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const safe = safeLocalInvokerHome(invokerHome, opts.userHome ?? homedir());
  if (!safe.ok) {
    return { ok: false, reason: 'path-guard', detail: safe.home, removed: 0 };
  }

  const cutoffMs = (opts.nowMs ?? Date.now()) - (opts.maxAgeMs ?? AUTOMATION_CHECKOUT_MAX_AGE_MS);
  const errors: string[] = [];
  let removed = 0;

  for (const rootName of AUTOMATION_CHECKOUT_ROOTS) {
    const root = join(safe.home, rootName);
    if (!existsSync(root)) continue;

    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch (err) {
      errors.push(`readdir ${root}: ${errorMessage(err)}`);
      continue;
    }

    for (const name of entries) {
      const entryPath = join(root, name);
      if (!isOlderThan(entryPath, cutoffMs, errors)) continue;
      if (removePath(entryPath, errors)) removed += 1;
    }
  }

  const result = cleanupErrorsResult('automation-checkouts', removed, errors);
  opts.logger?.debug?.('[reaper-reclaim] automation checkout pass', {
    module: MODULE,
    removed,
    ok: result.ok,
  });
  return result;
}

export function pruneHourlySnapshotsForReaper(opts: {
  invokerHome?: string;
  backupDir?: string;
} = {}): ReaperCleanupResult {
  const backupDir = opts.backupDir ?? join(opts.invokerHome ?? resolveInvokerHomeRoot(), 'db-backups');
  const removed = pruneHourlySnapshots(backupDir, hourlySnapshotRetention());
  return { ok: true, reason: 'hourly-snapshots', removed };
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

function knownLogPaths(invokerHome: string): string[] {
  const paths = new Set<string>();
  for (const name of KNOWN_INVOKER_LOG_NAMES) {
    paths.add(join(invokerHome, name));
  }

  if (!existsSync(invokerHome)) return [...paths];
  let entries: string[];
  try {
    entries = readdirSync(invokerHome);
  } catch {
    return [...paths];
  }

  const globs = KNOWN_INVOKER_LOG_GLOBS.map(globToRegExp);
  for (const name of entries) {
    if (globs.some((re) => re.test(name))) {
      paths.add(join(invokerHome, name));
    }
  }
  return [...paths];
}

function trimLogFile(path: string, maxBytes: number, keepBytes: number, errors: string[]): boolean {
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.size <= maxBytes) return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      errors.push(`stat ${path}: ${errorMessage(err)}`);
    }
    return false;
  }

  let fd: number | undefined;
  try {
    fd = openSync(path, 'r+');
    const size = fstatSync(fd).size;
    if (size <= maxBytes) return false;

    const bytesToKeep = Math.min(size, keepBytes);
    const buffer = Buffer.allocUnsafe(bytesToKeep);
    const position = size - bytesToKeep;
    const bytesRead = bytesToKeep > 0 ? readSync(fd, buffer, 0, bytesToKeep, position) : 0;
    ftruncateSync(fd, 0);
    if (bytesRead > 0) {
      writeSync(fd, buffer, 0, bytesRead, 0);
    }
    ftruncateSync(fd, bytesRead);
    return true;
  } catch (err) {
    errors.push(`${path}: ${errorMessage(err)}`);
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Best effort cleanup.
      }
    }
  }
}

export function trimKnownInvokerLogs(opts: {
  invokerHome?: string;
  userHome?: string;
  maxBytes?: number;
  keepBytes?: number;
  logger?: Logger;
} = {}): ReaperCleanupResult {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const safe = safeLocalInvokerHome(invokerHome, opts.userHome ?? homedir());
  if (!safe.ok) {
    return { ok: false, reason: 'path-guard', detail: safe.home, trimmed: 0 };
  }

  const maxBytes = Math.max(0, Math.floor(opts.maxBytes ?? LOG_TRIM_MAX_BYTES));
  const keepBytes = Math.max(0, Math.floor(opts.keepBytes ?? LOG_TRIM_KEEP_BYTES));
  const errors: string[] = [];
  let trimmed = 0;

  for (const path of knownLogPaths(safe.home)) {
    if (trimLogFile(path, maxBytes, keepBytes, errors)) trimmed += 1;
  }

  if (errors.length > 0) {
    return {
      ok: false,
      reason: 'cleanup-error',
      trimmed,
      detail: errors.slice(0, 5).join('; '),
    };
  }

  opts.logger?.debug?.('[reaper-reclaim] known log trim pass', {
    module: MODULE,
    trimmed,
  });
  return { ok: true, reason: 'known-log-trim', trimmed };
}
