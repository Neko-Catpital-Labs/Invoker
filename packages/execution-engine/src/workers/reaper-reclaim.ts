import {
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  globSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveInvokerHomeRoot, type Logger } from '@invoker/contracts';

import { buildSshConnectionArgs } from '../ssh-transport-options.js';
import { bashNormalizeTildePath, execRemoteCapture, shellPosixSingleQuote } from '../ssh-git-exec.js';

import type { RemoteDiskTarget } from './disk-headroom-monitor.js';
import {
  expandTildeHome,
  isDeletingOrphanName,
  isSafeInvokerHome,
  isSafeRemoteInvokerHomePath,
} from './disk-headroom-reclaim.js';
import {
  hourlySnapshotRetention,
  pruneHourlySnapshots,
} from '../../../app/src/delete-all-snapshot.js';

const MODULE = 'reaper-reclaim';

export const DELETING_ORPHAN_MIN_AGE_MS = 30 * 60 * 1000;
export const DELETING_ORPHAN_MIN_AGE_MINUTES = 30;
export const AUTOMATION_CHECKOUT_MIN_AGE_MS = 48 * 60 * 60 * 1000;
export const LOG_TRIM_THRESHOLD_BYTES = 100 * 1024 * 1024;
export const LOG_TRIM_KEEP_BYTES = 20 * 1024 * 1024;

export const AUTOMATION_CHECKOUT_ROOTS = [
  'mergify-admin-requeue-work',
  'land-admin-bypass-work',
] as const;

export const TRIMMED_LOG_FILES = [
  'invoker.log',
  'gui.log',
  'merge-trace.log',
  'slack-manager.log',
  'slack-manager.keepalive.log',
  'auto-fix-ci-self-prs.log',
  'auto-approve-self-prs.log',
  'reconciliation-refactor-cron.log',
] as const;

export const TRIMMED_LOG_GLOBS = [
  'slack-manager/*.log',
  'e2e-regression-watch/*.log',
  'task-output/full/*.log',
] as const;

export interface LocalReaperResult {
  root: string;
  scanned: number;
  removed: number;
  errors: string[];
}

export interface RemoteReaperResult {
  targetKey: string;
  ok: boolean;
  reason: string;
  detail?: string;
}

export interface DeletingOrphanReaperResult {
  local: LocalReaperResult;
  remotes: RemoteReaperResult[];
}

export interface SnapshotReaperResult {
  backupDir: string;
  retain: number;
  removed: number;
}

export interface LogTrimResult {
  scanned: number;
  trimmed: number;
  errors: string[];
}

function resolveHome(invokerHome: string, userHome: string): string {
  return expandTildeHome(invokerHome, userHome);
}

function isOlderThan(mtimeMs: number, minAgeMs: number, nowMs: number): boolean {
  return nowMs - mtimeMs > minAgeMs;
}

function removeEntry(path: string, errors: string[]): boolean {
  try {
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch (err) {
    errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function emptyLocalResult(root: string, detail: string): LocalReaperResult {
  return { root, scanned: 0, removed: 0, errors: [detail] };
}

function sweepImmediateChildren(opts: {
  root: string;
  nowMs: number;
  minAgeMs: number;
  shouldRemove: (name: string) => boolean;
}): LocalReaperResult {
  const result: LocalReaperResult = { root: opts.root, scanned: 0, removed: 0, errors: [] };
  if (!existsSync(opts.root)) return result;

  let entries: string[];
  try {
    entries = readdirSync(opts.root);
  } catch (err) {
    result.errors.push(`readdir ${opts.root}: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }

  for (const name of entries) {
    const entryPath = join(opts.root, name);
    result.scanned += 1;
    if (!opts.shouldRemove(name)) continue;
    try {
      const stat = lstatSync(entryPath);
      if (!isOlderThan(stat.mtimeMs, opts.minAgeMs, opts.nowMs)) continue;
      if (removeEntry(entryPath, result.errors)) result.removed += 1;
    } catch (err) {
      result.errors.push(`${entryPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

export function buildDeletingOrphanReclaimScript(invokerHome: string): string {
  const homeQ = shellPosixSingleQuote(invokerHome);
  return `set -euo pipefail
INVOKER_HOME=${homeQ}
${bashNormalizeTildePath('INVOKER_HOME')}
case "$INVOKER_HOME" in
  ""|"/"|"$HOME"|"~")
    echo "Refusing unsafe INVOKER_HOME: $INVOKER_HOME" >&2
    exit 64
    ;;
esac
find "$INVOKER_HOME" -mindepth 1 -maxdepth 1 -mmin +${DELETING_ORPHAN_MIN_AGE_MINUTES} -print0 2>/dev/null | while IFS= read -r -d '' entry; do
  name="$(basename "$entry")"
  case "$name" in
    *'.deleting.'*) rm -rf -- "$entry" ;;
  esac
done
`;
}

async function defaultRunRemoteScript(target: RemoteDiskTarget, script: string): Promise<string> {
  const sshArgs = buildSshConnectionArgs(target.connection, { batchMode: true });
  return execRemoteCapture({
    sshArgs,
    script,
    phase: `reaper-reclaim:${target.name}`,
  });
}

export async function reapDeletingOrphans(opts: {
  invokerHome?: string;
  remoteTargets?: RemoteDiskTarget[];
  logger?: Logger;
  nowMs?: number;
  userHome?: string;
  runRemoteScript?: (target: RemoteDiskTarget, script: string) => Promise<string>;
} = {}): Promise<DeletingOrphanReaperResult> {
  const userHome = opts.userHome ?? homedir();
  const home = resolveHome(opts.invokerHome ?? resolveInvokerHomeRoot(), userHome);
  const nowMs = opts.nowMs ?? Date.now();
  const local = isSafeInvokerHome(home, userHome)
    ? sweepImmediateChildren({
        root: home,
        nowMs,
        minAgeMs: DELETING_ORPHAN_MIN_AGE_MS,
        shouldRemove: isDeletingOrphanName,
      })
    : emptyLocalResult(home, 'path-guard');

  const run = opts.runRemoteScript ?? defaultRunRemoteScript;
  const remotes = await Promise.all((opts.remoteTargets ?? []).map(async (target) => {
    const targetKey = `ssh:${target.name} ${target.remotePath}`;
    if (!isSafeRemoteInvokerHomePath(target.remotePath)) {
      return { targetKey, ok: false, reason: 'path-guard', detail: target.remotePath };
    }

    try {
      const output = await run(target, buildDeletingOrphanReclaimScript(target.remotePath));
      return { targetKey, ok: true, reason: 'deleting-orphans', detail: output.slice(-400) };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      opts.logger?.warn?.(`[reaper-reclaim] deleting orphan remote sweep failed ${targetKey}: ${detail}`, {
        module: MODULE,
        targetKey,
      });
      return { targetKey, ok: false, reason: 'cleanup-error', detail };
    }
  }));

  return { local, remotes };
}

export function reapStaleAutomationCheckouts(opts: {
  invokerHome?: string;
  nowMs?: number;
  userHome?: string;
} = {}): LocalReaperResult {
  const userHome = opts.userHome ?? homedir();
  const home = resolveHome(opts.invokerHome ?? resolveInvokerHomeRoot(), userHome);
  if (!isSafeInvokerHome(home, userHome)) return emptyLocalResult(home, 'path-guard');

  const aggregate: LocalReaperResult = { root: home, scanned: 0, removed: 0, errors: [] };
  for (const name of AUTOMATION_CHECKOUT_ROOTS) {
    const result = sweepImmediateChildren({
      root: join(home, name),
      nowMs: opts.nowMs ?? Date.now(),
      minAgeMs: AUTOMATION_CHECKOUT_MIN_AGE_MS,
      shouldRemove: () => true,
    });
    aggregate.scanned += result.scanned;
    aggregate.removed += result.removed;
    aggregate.errors.push(...result.errors);
  }
  return aggregate;
}

export function pruneInvokerHourlySnapshots(invokerHomeRoot: string = resolveInvokerHomeRoot()): SnapshotReaperResult {
  const backupDir = join(invokerHomeRoot, 'db-backups');
  const retain = hourlySnapshotRetention();
  const removed = pruneHourlySnapshots(backupDir, retain);
  return { backupDir, retain, removed };
}

function candidateLogPaths(invokerHome: string): string[] {
  const direct = TRIMMED_LOG_FILES.map((name) => join(invokerHome, name));
  const globbed = TRIMMED_LOG_GLOBS.flatMap((pattern) => globSync(join(invokerHome, pattern)));
  return Array.from(new Set([...direct, ...globbed]));
}

function trimOneLogFile(path: string, thresholdBytes: number, keepBytes: number): 'trimmed' | 'skipped' {
  let fd: number | undefined;
  try {
    const linkStat = lstatSync(path);
    if (!linkStat.isFile()) return 'skipped';
    fd = openSync(path, 'r+');
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= thresholdBytes) return 'skipped';
    const bytesToKeep = Math.min(keepBytes, stat.size);
    const buffer = Buffer.allocUnsafe(bytesToKeep);
    const bytesRead = readSync(fd, buffer, 0, bytesToKeep, stat.size - bytesToKeep);
    ftruncateSync(fd, 0);
    writeSync(fd, buffer, 0, bytesRead, 0);
    ftruncateSync(fd, bytesRead);
    return 'trimmed';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function trimLargeInvokerLogs(opts: {
  invokerHome?: string;
  thresholdBytes?: number;
  keepBytes?: number;
  userHome?: string;
} = {}): LogTrimResult {
  const userHome = opts.userHome ?? homedir();
  const home = resolveHome(opts.invokerHome ?? resolveInvokerHomeRoot(), userHome);
  if (!isSafeInvokerHome(home, userHome)) return { scanned: 0, trimmed: 0, errors: ['path-guard'] };

  const result: LogTrimResult = { scanned: 0, trimmed: 0, errors: [] };
  for (const path of candidateLogPaths(home)) {
    result.scanned += 1;
    if (!existsSync(path)) continue;
    try {
      if (trimOneLogFile(path, opts.thresholdBytes ?? LOG_TRIM_THRESHOLD_BYTES, opts.keepBytes ?? LOG_TRIM_KEEP_BYTES) === 'trimmed') {
        result.trimmed += 1;
      }
    } catch (err) {
      result.errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}
