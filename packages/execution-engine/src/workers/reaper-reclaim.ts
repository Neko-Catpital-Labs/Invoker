/**
 * Low-pressure cleanup checks for Invoker-owned disk waste.
 *
 * These helpers are intentionally narrower than critical disk-headroom cleanup:
 * each one acts only on one established path/name convention.
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
  statSync,
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

export const REAPER_DELETING_ORPHAN_MIN_AGE_MINUTES = 30;
export const REAPER_DELETING_ORPHAN_MIN_AGE_MS =
  REAPER_DELETING_ORPHAN_MIN_AGE_MINUTES * 60 * 1000;

export const REAPER_AUTOMATION_WORK_MIN_AGE_HOURS = 48;
export const REAPER_AUTOMATION_WORK_MIN_AGE_MS =
  REAPER_AUTOMATION_WORK_MIN_AGE_HOURS * 60 * 60 * 1000;

export const REAPER_LOG_TRIM_THRESHOLD_BYTES = 100 * 1024 * 1024;
export const REAPER_LOG_RETAIN_BYTES = 20 * 1024 * 1024;

export const REAPER_AUTOMATION_WORK_DIRS = [
  'mergify-admin-requeue-work',
  'land-admin-bypass-work',
] as const;

export const REAPER_FIXED_LOG_FILES = [
  'invoker.log',
  'gui.log',
  'merge-trace.log',
  'auto-approve-self-prs.log',
  'auto-fix-ci-self-prs.log',
] as const;

export const REAPER_LOG_GLOBS = ['task-output/full/*.log'] as const;

export type ReaperReclaimCategory =
  | 'deleting-orphans'
  | 'automation-work'
  | 'hourly-snapshots'
  | 'log-trim';

export interface ReaperReclaimResult {
  category: ReaperReclaimCategory;
  targetKey: string;
  ok: boolean;
  reason: string;
  removed?: number;
  trimmed?: number;
  bytesBefore?: number;
  bytesAfter?: number;
  detail?: string;
}

export interface ReaperDeletingOrphanCleanupOptions {
  invokerHome?: string;
  userHome?: string;
  remoteTargets?: RemoteDiskTarget[];
  nowMs?: number;
  logger?: Logger;
  runRemoteScript?: (target: RemoteDiskTarget, script: string) => Promise<string>;
}

export interface ReaperAutomationWorkCleanupOptions {
  invokerHome?: string;
  userHome?: string;
  nowMs?: number;
  logger?: Logger;
}

export interface ReaperHourlySnapshotCleanupOptions {
  invokerHome?: string;
  backupDir?: string;
  logger?: Logger;
  hourlySnapshotRetention: () => number;
  pruneHourlySnapshots: (backupDir: string, retain: number) => number;
}

export interface ReaperLogTrimOptions {
  invokerHome?: string;
  userHome?: string;
  maxBytes?: number;
  keepBytes?: number;
  logger?: Logger;
}

function result(
  category: ReaperReclaimCategory,
  targetKey: string,
  ok: boolean,
  reason: string,
  fields: Omit<ReaperReclaimResult, 'category' | 'targetKey' | 'ok' | 'reason'> = {},
): ReaperReclaimResult {
  return { category, targetKey, ok, reason, ...fields };
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function removePath(path: string, errors: string[]): boolean {
  try {
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch (err) {
    errors.push(`${path}: ${errorDetail(err)}`);
    return false;
  }
}

function isEntryOlderThan(path: string, cutoffMs: number, errors: string[]): boolean {
  try {
    return lstatSync(path).mtimeMs < cutoffMs;
  } catch (err) {
    errors.push(`stat ${path}: ${errorDetail(err)}`);
    return false;
  }
}

function sweepImmediateChildrenOlderThan(
  dir: string,
  cutoffMs: number,
  shouldRemoveName: (name: string) => boolean,
): { removed: number; errors: string[] } {
  if (!existsSync(dir)) return { removed: 0, errors: [] };

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    return { removed: 0, errors: [`readdir ${dir}: ${errorDetail(err)}`] };
  }

  const errors: string[] = [];
  let removed = 0;
  for (const name of names) {
    if (!shouldRemoveName(name)) continue;
    const path = join(dir, name);
    if (!isEntryOlderThan(path, cutoffMs, errors)) continue;
    if (removePath(path, errors)) removed += 1;
  }
  return { removed, errors };
}

function guardedLocalHome(
  invokerHome: string | undefined,
  userHome: string | undefined,
): { ok: true; home: string; userHome: string } | { ok: false; home: string; userHome: string } {
  const resolvedUserHome = userHome ?? homedir();
  const home = expandTildeHome(invokerHome ?? resolveInvokerHomeRoot(), resolvedUserHome);
  if (!isSafeInvokerHome(home, resolvedUserHome)) {
    return { ok: false, home, userHome: resolvedUserHome };
  }
  return { ok: true, home, userHome: resolvedUserHome };
}

function parseRemovedCount(output: string): number | undefined {
  const match = output.match(/\bremoved=(\d+)\b/);
  if (!match) return undefined;
  const parsed = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function buildDeletingOrphanReclaimScript(
  invokerHome: string,
  minAgeMinutes: number = REAPER_DELETING_ORPHAN_MIN_AGE_MINUTES,
): string {
  const homeQ = shellPosixSingleQuote(invokerHome);
  const age = Math.max(0, Math.floor(minAgeMinutes));
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
      if rm -rf -- "$entry" >/dev/null 2>&1; then
        removed=$((removed + 1))
      fi
      ;;
  esac
done < <(find "$INVOKER_HOME" -mindepth 1 -maxdepth 1 -name '*.deleting.*' -mmin +${age} -print0 2>/dev/null)
echo "[reaper-reclaim] deleting-orphans removed=$removed home=$INVOKER_HOME"
exit 0
`;
}

async function reclaimRemoteDeletingOrphans(
  target: RemoteDiskTarget,
  runRemoteScript: (target: RemoteDiskTarget, script: string) => Promise<string>,
  logger: Logger | undefined,
): Promise<ReaperReclaimResult> {
  const targetKey = `ssh:${target.name} ${target.remotePath}`;
  if (!isSafeRemoteInvokerHomePath(target.remotePath)) {
    return result('deleting-orphans', targetKey, false, 'path-guard', {
      detail: target.remotePath,
    });
  }

  const script = buildDeletingOrphanReclaimScript(target.remotePath);
  try {
    logger?.debug?.(`[reaper-reclaim] remote deleting-orphans begin ${targetKey}`, {
      module: 'reaper-reclaim',
      targetKey,
    });
    const output = await runRemoteScript(target, script);
    logger?.debug?.(`[reaper-reclaim] remote deleting-orphans done ${targetKey}`, {
      module: 'reaper-reclaim',
      targetKey,
      outputTail: output.slice(-400),
    });
    const removed = parseRemovedCount(output);
    return result('deleting-orphans', targetKey, true, removed ? 'reclaimed' : 'noop', {
      removed,
      detail: output.slice(-400),
    });
  } catch (err) {
    const detail = errorDetail(err);
    logger?.warn?.(`[reaper-reclaim] remote deleting-orphans failed ${targetKey}: ${detail}`, {
      module: 'reaper-reclaim',
      targetKey,
    });
    return result('deleting-orphans', targetKey, false, 'cleanup-error', { detail });
  }
}

function defaultRunRemoteReaper(target: RemoteDiskTarget, script: string): Promise<string> {
  const sshArgs = buildSshConnectionArgs(target.connection, { batchMode: true });
  return execRemoteCapture({
    sshArgs,
    script,
    phase: `reaper-reclaim:${target.name}`,
  });
}

export async function reclaimDeletingOrphans(
  opts: ReaperDeletingOrphanCleanupOptions = {},
): Promise<ReaperReclaimResult[]> {
  const homeGuard = guardedLocalHome(opts.invokerHome, opts.userHome);
  const targetKey = `local ${homeGuard.home}`;
  const results: ReaperReclaimResult[] = [];

  if (!homeGuard.ok) {
    results.push(result('deleting-orphans', targetKey, false, 'path-guard', {
      detail: homeGuard.home,
    }));
  } else {
    const cutoffMs = (opts.nowMs ?? Date.now()) - REAPER_DELETING_ORPHAN_MIN_AGE_MS;
    const { removed, errors } = sweepImmediateChildrenOlderThan(
      homeGuard.home,
      cutoffMs,
      isDeletingOrphanName,
    );
    if (errors.length > 0) {
      results.push(result('deleting-orphans', targetKey, false, 'cleanup-error', {
        removed,
        detail: errors.slice(0, 5).join('; '),
      }));
    } else {
      results.push(result('deleting-orphans', targetKey, true, removed > 0 ? 'reclaimed' : 'noop', {
        removed,
      }));
    }
  }

  const runRemoteScript = opts.runRemoteScript ?? defaultRunRemoteReaper;
  const remoteResults = await Promise.all(
    (opts.remoteTargets ?? []).map((target) =>
      reclaimRemoteDeletingOrphans(target, runRemoteScript, opts.logger),
    ),
  );
  results.push(...remoteResults);
  return results;
}

export function reclaimAutomationCheckoutWork(
  opts: ReaperAutomationWorkCleanupOptions = {},
): ReaperReclaimResult {
  const homeGuard = guardedLocalHome(opts.invokerHome, opts.userHome);
  const targetKey = `local ${homeGuard.home}`;
  if (!homeGuard.ok) {
    return result('automation-work', targetKey, false, 'path-guard', { detail: homeGuard.home });
  }

  const cutoffMs = (opts.nowMs ?? Date.now()) - REAPER_AUTOMATION_WORK_MIN_AGE_MS;
  const errors: string[] = [];
  let removed = 0;
  for (const name of REAPER_AUTOMATION_WORK_DIRS) {
    const sweep = sweepImmediateChildrenOlderThan(join(homeGuard.home, name), cutoffMs, () => true);
    removed += sweep.removed;
    errors.push(...sweep.errors);
  }

  if (errors.length > 0) {
    opts.logger?.warn?.('[reaper-reclaim] automation-work partial failures', {
      module: 'reaper-reclaim',
      targetKey,
      errors,
    });
    return result('automation-work', targetKey, false, 'cleanup-error', {
      removed,
      detail: errors.slice(0, 5).join('; '),
    });
  }

  return result('automation-work', targetKey, true, removed > 0 ? 'reclaimed' : 'noop', {
    removed,
  });
}

export function reclaimHourlySnapshots(
  opts: ReaperHourlySnapshotCleanupOptions,
): ReaperReclaimResult {
  const backupDir = opts.backupDir ?? join(opts.invokerHome ?? resolveInvokerHomeRoot(), 'db-backups');
  try {
    const removed = opts.pruneHourlySnapshots(backupDir, opts.hourlySnapshotRetention());
    return result('hourly-snapshots', backupDir, true, removed > 0 ? 'reclaimed' : 'noop', {
      removed,
    });
  } catch (err) {
    const detail = errorDetail(err);
    opts.logger?.warn?.(`[reaper-reclaim] hourly snapshot prune failed: ${detail}`, {
      module: 'reaper-reclaim',
      backupDir,
    });
    return result('hourly-snapshots', backupDir, false, 'cleanup-error', { detail });
  }
}

function taskOutputLogFiles(invokerHome: string): string[] {
  const dir = join(invokerHome, 'task-output', 'full');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.log'))
    .map((name) => join(dir, name));
}

function logFileCandidates(invokerHome: string): string[] {
  return [
    ...REAPER_FIXED_LOG_FILES.map((name) => join(invokerHome, name)),
    ...taskOutputLogFiles(invokerHome),
  ];
}

function trimFileToLastBytes(
  file: string,
  maxBytes: number,
  keepBytes: number,
): { trimmed: boolean; before: number; after: number } {
  if (!existsSync(file)) return { trimmed: false, before: 0, after: 0 };
  if (!statSync(file).isFile()) return { trimmed: false, before: 0, after: 0 };

  const fd = openSync(file, 'r+');
  try {
    const before = fstatSync(fd).size;
    const retain = Math.min(before, Math.max(0, Math.floor(keepBytes)));
    if (before <= maxBytes || retain === before) {
      return { trimmed: false, before, after: before };
    }

    const buffer = Buffer.allocUnsafe(retain);
    let totalRead = 0;
    const start = before - retain;
    while (totalRead < retain) {
      const n = readSync(fd, buffer, totalRead, retain - totalRead, start + totalRead);
      if (n === 0) break;
      totalRead += n;
    }

    ftruncateSync(fd, 0);
    let totalWritten = 0;
    while (totalWritten < totalRead) {
      totalWritten += writeSync(fd, buffer, totalWritten, totalRead - totalWritten, totalWritten);
    }
    ftruncateSync(fd, totalWritten);
    return { trimmed: true, before, after: totalWritten };
  } finally {
    closeSync(fd);
  }
}

export function trimInvokerLogFiles(opts: ReaperLogTrimOptions = {}): ReaperReclaimResult {
  const homeGuard = guardedLocalHome(opts.invokerHome, opts.userHome);
  const targetKey = `local ${homeGuard.home}`;
  if (!homeGuard.ok) {
    return result('log-trim', targetKey, false, 'path-guard', { detail: homeGuard.home });
  }

  const maxBytes = Math.max(0, Math.floor(opts.maxBytes ?? REAPER_LOG_TRIM_THRESHOLD_BYTES));
  const keepBytes = Math.max(0, Math.floor(opts.keepBytes ?? REAPER_LOG_RETAIN_BYTES));
  const errors: string[] = [];
  let trimmed = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;

  for (const file of logFileCandidates(homeGuard.home)) {
    try {
      const fileResult = trimFileToLastBytes(file, maxBytes, keepBytes);
      bytesBefore += fileResult.before;
      bytesAfter += fileResult.after;
      if (fileResult.trimmed) trimmed += 1;
    } catch (err) {
      errors.push(`${file}: ${errorDetail(err)}`);
    }
  }

  if (errors.length > 0) {
    opts.logger?.warn?.('[reaper-reclaim] log trim partial failures', {
      module: 'reaper-reclaim',
      targetKey,
      errors,
    });
    return result('log-trim', targetKey, false, 'cleanup-error', {
      trimmed,
      bytesBefore,
      bytesAfter,
      detail: errors.slice(0, 5).join('; '),
    });
  }

  return result('log-trim', targetKey, true, trimmed > 0 ? 'reclaimed' : 'noop', {
    trimmed,
    bytesBefore,
    bytesAfter,
  });
}
