import {
  closeSync,
  existsSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Logger } from '@invoker/contracts';
import { resolveInvokerHomeRoot } from '@invoker/contracts';

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
export const AUTOMATION_CHECKOUT_MIN_AGE_MS = 48 * 60 * 60 * 1000;
export const LOG_TRIM_THRESHOLD_BYTES = 100 * 1024 * 1024;
export const LOG_RETAIN_BYTES = 20 * 1024 * 1024;

export const AUTOMATION_CHECKOUT_DIRS = [
  'mergify-admin-requeue-work',
  'land-admin-bypass-work',
] as const;

export const ROOT_LOG_FILES = [
  'invoker.log',
  'gui.log',
] as const;

export const ROOT_LOG_GLOBS = [
  '*-trace.log',
  'ui-*-events.jsonl',
] as const;

export interface ReaperReclaimResult {
  ok: boolean;
  reason: string;
  removed: number;
  trimmed: number;
  errors: string[];
}

export interface ReaperTargetResult extends ReaperReclaimResult {
  targetKey: string;
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

export interface ReclaimLocalOptions {
  invokerHome?: string;
  nowMs?: number;
  userHome?: string;
  logger?: Logger;
}

export interface ReclaimHourlySnapshotOptions {
  invokerHome?: string;
  snapshotModule?: {
    hourlySnapshotRetention: () => number;
    pruneHourlySnapshots: (backupDir: string, retain: number) => number;
  };
}

export interface ReclaimLargeInvokerLogsOptions {
  invokerHome?: string;
  thresholdBytes?: number;
  retainBytes?: number;
  userHome?: string;
  logger?: Logger;
}

function emptyResult(reason: string): ReaperReclaimResult {
  return { ok: true, reason, removed: 0, trimmed: 0, errors: [] };
}

function targetResult(targetKey: string, reason: string): ReaperTargetResult {
  return { ...emptyResult(reason), targetKey };
}

function isOlderThan(mtimeMs: number, minAgeMs: number, nowMs: number): boolean {
  return nowMs - mtimeMs > minAgeMs;
}

function resolveSafeLocalHome(
  invokerHome: string,
  userHome: string,
): { ok: true; home: string } | { ok: false; home: string } {
  const home = expandTildeHome(invokerHome, userHome);
  if (!isSafeInvokerHome(home, userHome)) return { ok: false, home };
  return { ok: true, home };
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

function reclaimLocalDeletingOrphans(
  invokerHome: string,
  nowMs: number,
  userHome: string,
): ReaperTargetResult {
  const targetKey = `local ${invokerHome}`;
  const safe = resolveSafeLocalHome(invokerHome, userHome);
  if (!safe.ok) {
    return {
      ...targetResult(targetKey, 'path-guard'),
      ok: false,
      detail: safe.home,
    };
  }
  const result = targetResult(`local ${safe.home}`, 'deleting-orphans');
  if (!existsSync(safe.home)) return result;

  let entries: string[];
  try {
    entries = readdirSync(safe.home);
  } catch (err) {
    result.ok = false;
    result.errors.push(`readdir ${safe.home}: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }

  for (const name of entries) {
    if (!isDeletingOrphanName(name)) continue;
    const path = join(safe.home, name);
    try {
      const stat = lstatSync(path);
      if (!isOlderThan(stat.mtimeMs, DELETING_ORPHAN_MIN_AGE_MS, nowMs)) continue;
      if (removePath(path, result.errors)) result.removed += 1;
    } catch (err) {
      result.errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  result.ok = result.errors.length === 0;
  return result;
}

function buildRemoteDeletingOrphansScript(invokerHome: string): string {
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
  base="\${entry##*/}"
  case "$base" in
    *'.deleting.'*)
      rm -rf -- "$entry" >/dev/null 2>&1 && removed=$((removed + 1))
      ;;
  esac
done < <(find "$INVOKER_HOME" -mindepth 1 -maxdepth 1 -mmin +30 -print0 2>/dev/null)
echo "[reaper-reclaim] deleting-orphans removed=$removed"
exit 0
`;
}

async function defaultRunRemoteReaper(target: RemoteDiskTarget, script: string): Promise<string> {
  const sshArgs = buildSshConnectionArgs(target.connection, { batchMode: true });
  return execRemoteCapture({
    sshArgs,
    script,
    phase: `reaper-reclaim:${target.name}`,
  });
}

async function reclaimRemoteDeletingOrphans(
  target: RemoteDiskTarget,
  runRemoteScript: (target: RemoteDiskTarget, script: string) => Promise<string>,
  logger?: Logger,
): Promise<ReaperTargetResult> {
  const targetKey = `ssh:${target.name} ${target.remotePath}`;
  if (!isSafeRemoteInvokerHomePath(target.remotePath)) {
    return {
      ...targetResult(targetKey, 'path-guard'),
      ok: false,
      detail: target.remotePath,
    };
  }

  const result = targetResult(targetKey, 'deleting-orphans');
  try {
    const output = await runRemoteScript(target, buildRemoteDeletingOrphansScript(target.remotePath));
    result.detail = output.slice(-400);
  } catch (err) {
    result.ok = false;
    result.errors.push(err instanceof Error ? err.message : String(err));
    logger?.warn?.(`[reaper-reclaim] remote deleting orphan sweep failed ${targetKey}`, {
      module: 'reaper-reclaim',
      targetKey,
      reason: result.errors[0],
    });
  }
  return result;
}

export async function reclaimDeletingOrphans(
  opts: ReclaimDeletingOrphansOptions = {},
): Promise<ReaperTargetResult[]> {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const nowMs = opts.nowMs ?? Date.now();
  const userHome = opts.userHome ?? homedir();
  const results = [
    reclaimLocalDeletingOrphans(invokerHome, nowMs, userHome),
  ];
  const runRemoteScript = opts.runRemoteScript ?? defaultRunRemoteReaper;
  const remoteResults = await Promise.all(
    (opts.remoteTargets ?? []).map((target) =>
      reclaimRemoteDeletingOrphans(target, runRemoteScript, opts.logger)),
  );
  return [...results, ...remoteResults];
}

export function reclaimAutomationCheckoutWorkdirs(
  opts: ReclaimLocalOptions = {},
): ReaperReclaimResult {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const nowMs = opts.nowMs ?? Date.now();
  const userHome = opts.userHome ?? homedir();
  const safe = resolveSafeLocalHome(invokerHome, userHome);
  if (!safe.ok) {
    return { ...emptyResult('path-guard'), ok: false, errors: [safe.home] };
  }

  const result = emptyResult('automation-checkout-workdirs');
  for (const dirName of AUTOMATION_CHECKOUT_DIRS) {
    const parent = join(safe.home, dirName);
    if (!existsSync(parent)) continue;

    let entries: string[];
    try {
      entries = readdirSync(parent);
    } catch (err) {
      result.errors.push(`readdir ${parent}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    for (const name of entries) {
      const path = join(parent, name);
      try {
        const stat = lstatSync(path);
        if (!isOlderThan(stat.mtimeMs, AUTOMATION_CHECKOUT_MIN_AGE_MS, nowMs)) continue;
        if (removePath(path, result.errors)) result.removed += 1;
      } catch (err) {
        result.errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  result.ok = result.errors.length === 0;
  return result;
}

async function loadSnapshotModule(): Promise<Required<ReclaimHourlySnapshotOptions>['snapshotModule']> {
  return import('../../../app/src/delete-all-snapshot.js');
}

export async function reclaimHourlySnapshotOverflow(
  opts: ReclaimHourlySnapshotOptions = {},
): Promise<ReaperReclaimResult> {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const snapshotModule = opts.snapshotModule ?? await loadSnapshotModule();
  const backupDir = join(invokerHome, 'db-backups');
  const removed = snapshotModule.pruneHourlySnapshots(
    backupDir,
    snapshotModule.hourlySnapshotRetention(),
  );
  return {
    ...emptyResult('hourly-snapshot-retention'),
    removed,
  };
}

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

function rootLogCandidates(invokerHome: string): string[] {
  const names = new Set<string>(ROOT_LOG_FILES);
  const globMatchers = ROOT_LOG_GLOBS.map(globToRegex);
  try {
    for (const name of readdirSync(invokerHome)) {
      if (globMatchers.some((matcher) => matcher.test(name))) names.add(name);
    }
  } catch {
    return [...names].map((name) => join(invokerHome, name));
  }
  return [...names].map((name) => join(invokerHome, name));
}

function readTail(fd: number, size: number, retainBytes: number): Buffer {
  const bytesToRead = Math.min(size, retainBytes);
  const buffer = Buffer.allocUnsafe(bytesToRead);
  const start = size - bytesToRead;
  let offset = 0;
  while (offset < bytesToRead) {
    const read = readSync(fd, buffer, offset, bytesToRead - offset, start + offset);
    if (read === 0) break;
    offset += read;
  }
  return offset === bytesToRead ? buffer : buffer.subarray(0, offset);
}

function trimFileToTail(path: string, size: number, retainBytes: number): void {
  const fd = openSync(path, 'r+');
  try {
    const tail = readTail(fd, size, retainBytes);
    ftruncateSync(fd, 0);
    if (tail.length > 0) {
      writeSync(fd, tail, 0, tail.length, 0);
    }
    ftruncateSync(fd, tail.length);
  } finally {
    closeSync(fd);
  }
}

export function reclaimLargeInvokerLogs(
  opts: ReclaimLargeInvokerLogsOptions = {},
): ReaperReclaimResult {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const userHome = opts.userHome ?? homedir();
  const safe = resolveSafeLocalHome(invokerHome, userHome);
  if (!safe.ok) {
    return { ...emptyResult('path-guard'), ok: false, errors: [safe.home] };
  }

  const result = emptyResult('large-invoker-logs');
  const thresholdBytes = opts.thresholdBytes ?? LOG_TRIM_THRESHOLD_BYTES;
  const retainBytes = opts.retainBytes ?? LOG_RETAIN_BYTES;
  mkdirSync(safe.home, { recursive: true });

  for (const path of rootLogCandidates(safe.home)) {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size <= thresholdBytes) continue;
      trimFileToTail(path, stat.size, retainBytes);
      result.trimmed += 1;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      result.errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  result.ok = result.errors.length === 0;
  return result;
}
