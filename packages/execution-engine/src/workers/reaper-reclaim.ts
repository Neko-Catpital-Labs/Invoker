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

import type { RemoteDiskTarget } from './disk-headroom-monitor.js';
import {
  expandTildeHome,
  isDeletingOrphanName,
  isSafeInvokerHome,
  isSafeRemoteInvokerHomePath,
} from './disk-headroom-reclaim.js';

const MODULE = 'reaper-reclaim';

export const DELETING_ORPHAN_MIN_AGE_MS = 30 * 60 * 1000;
export const AUTOMATION_WORK_MIN_AGE_MS = 48 * 60 * 60 * 1000;
export const LOG_TRIM_THRESHOLD_BYTES = 100 * 1024 * 1024;
export const LOG_TRIM_KEEP_BYTES = 20 * 1024 * 1024;

export const AUTOMATION_CHECKOUT_WORK_DIRS = [
  'mergify-admin-requeue-work',
  'land-admin-bypass-work',
] as const;

export const TOP_LEVEL_LOG_FILES = [
  'invoker.log',
  'gui.log',
  'slack-manager.log',
] as const;

export const TOP_LEVEL_LOG_GLOBS = ['*-trace.log'] as const;
export const NESTED_LOG_GLOBS = ['slack-manager/*.log'] as const;

export interface ReaperCleanupResult {
  targetKey: string;
  ok: boolean;
  reason: string;
  removed?: number;
  trimmed?: number;
  detail?: string;
}

export interface DeletingOrphanReclaimOptions {
  invokerHome?: string;
  userHome?: string;
  remoteTargets?: RemoteDiskTarget[];
  minAgeMs?: number;
  nowMs?: number;
  logger?: Logger;
  runRemoteScript?: (target: RemoteDiskTarget, script: string) => Promise<string>;
}

export interface AutomationCheckoutReclaimOptions {
  invokerHome?: string;
  userHome?: string;
  minAgeMs?: number;
  nowMs?: number;
  logger?: Logger;
}

export type SnapshotPruneFn = (backupDir: string, retain: number) => number;
export type SnapshotRetentionFn = () => number;

export interface HourlySnapshotReclaimOptions {
  invokerHomeRoot?: string;
  backupDir?: string;
  pruneHourlySnapshots: SnapshotPruneFn;
  hourlySnapshotRetention: SnapshotRetentionFn;
  logger?: Logger;
}

export interface LogTrimOptions {
  invokerHome?: string;
  userHome?: string;
  thresholdBytes?: number;
  keepBytes?: number;
  logger?: Logger;
}

function resultError(targetKey: string, reason: string, err: unknown): ReaperCleanupResult {
  return {
    targetKey,
    ok: false,
    reason,
    detail: err instanceof Error ? err.message : String(err),
  };
}

function localHomeFromOptions(opts: {
  invokerHome?: string;
  userHome?: string;
}): { home: string; userHome: string } {
  const userHome = opts.userHome ?? homedir();
  const configured = opts.invokerHome ?? resolveInvokerHomeRoot();
  return { home: expandTildeHome(configured, userHome), userHome };
}

function entryIsOlderThan(path: string, cutoffMs: number): boolean {
  return lstatSync(path).mtimeMs < cutoffMs;
}

function removeImmediateChildrenOlderThan(opts: {
  parent: string;
  minAgeMs: number;
  nowMs: number;
  filter: (name: string) => boolean;
}): { removed: number; errors: string[] } {
  if (!existsSync(opts.parent)) return { removed: 0, errors: [] };

  let names: string[];
  try {
    names = readdirSync(opts.parent);
  } catch (err) {
    return {
      removed: 0,
      errors: [`readdir ${opts.parent}: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  const cutoffMs = opts.nowMs - opts.minAgeMs;
  const errors: string[] = [];
  let removed = 0;
  for (const name of names) {
    if (!opts.filter(name)) continue;
    const path = join(opts.parent, name);
    try {
      if (!entryIsOlderThan(path, cutoffMs)) continue;
      rmSync(path, { recursive: true, force: true });
      removed += 1;
    } catch (err) {
      errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { removed, errors };
}

export function reclaimLocalDeletingOrphans(opts: DeletingOrphanReclaimOptions = {}): ReaperCleanupResult {
  const { home, userHome } = localHomeFromOptions(opts);
  const targetKey = `local ${home}`;
  if (!isSafeInvokerHome(home, userHome)) {
    return { targetKey, ok: false, reason: 'path-guard', detail: home };
  }

  const { removed, errors } = removeImmediateChildrenOlderThan({
    parent: home,
    minAgeMs: opts.minAgeMs ?? DELETING_ORPHAN_MIN_AGE_MS,
    nowMs: opts.nowMs ?? Date.now(),
    filter: isDeletingOrphanName,
  });
  if (errors.length > 0) {
    return {
      targetKey,
      ok: false,
      reason: 'cleanup-error',
      removed,
      detail: errors.slice(0, 5).join('; '),
    };
  }
  opts.logger?.debug?.('[reaper-reclaim] local deleting-orphans done', {
    module: MODULE,
    targetKey,
    removed,
  });
  return { targetKey, ok: true, reason: 'deleting-orphans', removed };
}

export function buildDeletingOrphanReclaimScript(
  invokerHome: string,
  minAgeMs: number = DELETING_ORPHAN_MIN_AGE_MS,
): string {
  const homeQ = shellPosixSingleQuote(invokerHome);
  const minAgeMinutes = Math.max(0, Math.floor(minAgeMs / 60_000));
  return `set +e
INVOKER_HOME=${homeQ}
${bashNormalizeTildePath('INVOKER_HOME')}
case "$INVOKER_HOME" in
  ""|"/"|"$HOME"|"~")
    echo "Refusing unsafe INVOKER_HOME: $INVOKER_HOME" >&2
    exit 64
    ;;
esac
find "$INVOKER_HOME" -mindepth 1 -maxdepth 1 -mmin +${minAgeMinutes} -print0 2>/dev/null | while IFS= read -r -d '' entry; do
  base="\${entry##*/}"
  case "$base" in
    *'.deleting.'*) rm -rf "$entry" >/dev/null 2>&1 || true ;;
  esac
done
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

export async function reclaimRemoteDeletingOrphans(opts: {
  target: RemoteDiskTarget;
  minAgeMs?: number;
  logger?: Logger;
  runRemoteScript?: (target: RemoteDiskTarget, script: string) => Promise<string>;
}): Promise<ReaperCleanupResult> {
  const targetKey = `ssh:${opts.target.name} ${opts.target.remotePath}`;
  if (!isSafeRemoteInvokerHomePath(opts.target.remotePath)) {
    return { targetKey, ok: false, reason: 'path-guard', detail: opts.target.remotePath };
  }

  const script = buildDeletingOrphanReclaimScript(
    opts.target.remotePath,
    opts.minAgeMs ?? DELETING_ORPHAN_MIN_AGE_MS,
  );
  const run = opts.runRemoteScript ?? defaultRunRemoteDeletingOrphanReclaim;
  try {
    const output = await run(opts.target, script);
    opts.logger?.debug?.('[reaper-reclaim] remote deleting-orphans done', {
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
    opts.logger?.warn?.('[reaper-reclaim] remote deleting-orphans failed', {
      module: MODULE,
      targetKey,
      err,
    });
    return resultError(targetKey, 'cleanup-error', err);
  }
}

export async function reclaimDeletingOrphans(
  opts: DeletingOrphanReclaimOptions = {},
): Promise<ReaperCleanupResult[]> {
  const local = reclaimLocalDeletingOrphans(opts);
  const remotes = await Promise.all(
    (opts.remoteTargets ?? []).map((target) =>
      reclaimRemoteDeletingOrphans({
        target,
        minAgeMs: opts.minAgeMs,
        logger: opts.logger,
        runRemoteScript: opts.runRemoteScript,
      }),
    ),
  );
  return [local, ...remotes];
}

export function reclaimAutomationCheckoutWork(
  opts: AutomationCheckoutReclaimOptions = {},
): ReaperCleanupResult {
  const { home, userHome } = localHomeFromOptions(opts);
  const targetKey = `local ${home}`;
  if (!isSafeInvokerHome(home, userHome)) {
    return { targetKey, ok: false, reason: 'path-guard', detail: home };
  }

  const minAgeMs = opts.minAgeMs ?? AUTOMATION_WORK_MIN_AGE_MS;
  const nowMs = opts.nowMs ?? Date.now();
  const errors: string[] = [];
  let removed = 0;
  for (const dir of AUTOMATION_CHECKOUT_WORK_DIRS) {
    const result = removeImmediateChildrenOlderThan({
      parent: join(home, dir),
      minAgeMs,
      nowMs,
      filter: () => true,
    });
    removed += result.removed;
    errors.push(...result.errors);
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
  opts.logger?.debug?.('[reaper-reclaim] automation checkout work done', {
    module: MODULE,
    targetKey,
    removed,
  });
  return { targetKey, ok: true, reason: 'automation-checkout-work', removed };
}

export function reclaimHourlySnapshots(opts: HourlySnapshotReclaimOptions): ReaperCleanupResult {
  const home = opts.invokerHomeRoot ?? resolveInvokerHomeRoot();
  const backupDir = opts.backupDir ?? join(home, 'db-backups');
  const targetKey = `local ${backupDir}`;

  try {
    const removed = opts.pruneHourlySnapshots(backupDir, opts.hourlySnapshotRetention());
    opts.logger?.debug?.('[reaper-reclaim] hourly snapshots done', {
      module: MODULE,
      targetKey,
      removed,
    });
    return { targetKey, ok: true, reason: 'hourly-snapshots', removed };
  } catch (err) {
    return resultError(targetKey, 'cleanup-error', err);
  }
}

function addExistingLogPath(paths: Set<string>, path: string): void {
  if (existsSync(path)) paths.add(path);
}

function addTopLevelTraceLogs(paths: Set<string>, home: string): void {
  let names: string[];
  try {
    names = readdirSync(home);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.endsWith('-trace.log')) addExistingLogPath(paths, join(home, name));
  }
}

function addSlackManagerLogs(paths: Set<string>, home: string): void {
  const dir = join(home, 'slack-manager');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.endsWith('.log')) addExistingLogPath(paths, join(dir, name));
  }
}

export function listInvokerLogTrimCandidates(invokerHome: string): string[] {
  const paths = new Set<string>();
  for (const name of TOP_LEVEL_LOG_FILES) {
    addExistingLogPath(paths, join(invokerHome, name));
  }
  addTopLevelTraceLogs(paths, invokerHome);
  addSlackManagerLogs(paths, invokerHome);
  return Array.from(paths).sort();
}

function trimFileToTail(path: string, thresholdBytes: number, keepBytes: number): boolean {
  const fd = openSync(path, 'r+');
  try {
    const before = fstatSync(fd);
    if (before.size <= thresholdBytes) return false;

    const bytesToKeep = Math.min(keepBytes, before.size);
    const tail = Buffer.alloc(bytesToKeep);
    readSync(fd, tail, 0, bytesToKeep, before.size - bytesToKeep);
    ftruncateSync(fd, 0);
    writeSync(fd, tail, 0, bytesToKeep, 0);
    ftruncateSync(fd, bytesToKeep);
    return true;
  } finally {
    closeSync(fd);
  }
}

export function trimInvokerLogs(opts: LogTrimOptions = {}): ReaperCleanupResult {
  const { home, userHome } = localHomeFromOptions(opts);
  const targetKey = `local ${home}`;
  if (!isSafeInvokerHome(home, userHome)) {
    return { targetKey, ok: false, reason: 'path-guard', detail: home };
  }

  const thresholdBytes = opts.thresholdBytes ?? LOG_TRIM_THRESHOLD_BYTES;
  const keepBytes = opts.keepBytes ?? LOG_TRIM_KEEP_BYTES;
  const errors: string[] = [];
  let trimmed = 0;
  for (const path of listInvokerLogTrimCandidates(home)) {
    try {
      if (trimFileToTail(path, thresholdBytes, keepBytes)) trimmed += 1;
    } catch (err) {
      errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (errors.length > 0) {
    return {
      targetKey,
      ok: false,
      reason: 'cleanup-error',
      trimmed,
      detail: errors.slice(0, 5).join('; '),
    };
  }
  opts.logger?.debug?.('[reaper-reclaim] log trim done', {
    module: MODULE,
    targetKey,
    trimmed,
  });
  return { targetKey, ok: true, reason: 'log-trim', trimmed };
}
