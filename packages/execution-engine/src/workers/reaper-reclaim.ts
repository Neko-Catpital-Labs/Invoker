import {
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
import { closeSync } from 'node:fs';
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

export const REAPER_DELETING_ORPHAN_MIN_AGE_MS = 30 * 60 * 1000;
export const REAPER_AUTOMATION_WORK_MIN_AGE_MS = 48 * 60 * 60 * 1000;
export const REAPER_LOG_TRIM_MAX_BYTES = 100 * 1024 * 1024;
export const REAPER_LOG_TRIM_KEEP_BYTES = 20 * 1024 * 1024;

export const REAPER_AUTOMATION_WORK_DIRS = [
  'mergify-admin-requeue-work',
  'land-admin-bypass-work',
] as const;

export const REAPER_LOG_FILE_NAMES = [
  'invoker.log',
  'gui.log',
  'merge-trace.log',
  'reconciliation-refactor-cron.log',
] as const;

export const REAPER_LOG_FILE_GLOBS = [
  'slack-manager*.log',
  'slack-manager/*.log',
  'e2e-regression-watch/*.log',
] as const;

export interface ReaperCleanupSummary {
  ok: boolean;
  removed: number;
  trimmed: number;
  skipped: number;
  detail?: string;
}

export interface ReaperRemoteResult {
  targetKey: string;
  ok: boolean;
  reason: string;
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
  userHome?: string;
  nowMs?: number;
  minAgeMs?: number;
}

export interface PruneHourlySnapshotsOptions {
  invokerHome?: string;
  userHome?: string;
}

export interface TrimInvokerLogsOptions {
  invokerHome?: string;
  userHome?: string;
  maxBytes?: number;
  keepBytes?: number;
}

function emptySummary(): ReaperCleanupSummary {
  return { ok: true, removed: 0, trimmed: 0, skipped: 0 };
}

function guardedHome(invokerHome: string, userHome: string): string | null {
  const home = expandTildeHome(invokerHome, userHome);
  return isSafeInvokerHome(home, userHome) ? home : null;
}

function isOlderThan(path: string, cutoffMs: number): boolean {
  try {
    return lstatSync(path).mtimeMs < cutoffMs;
  } catch {
    return false;
  }
}

function removePath(path: string): boolean {
  try {
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function reclaimLocalDeletingOrphans(opts: {
  invokerHome: string;
  userHome: string;
  nowMs: number;
  minAgeMs: number;
}): ReaperCleanupSummary {
  const home = guardedHome(opts.invokerHome, opts.userHome);
  if (!home) return { ...emptySummary(), ok: false, detail: 'path-guard' };
  if (!existsSync(home)) return emptySummary();

  let names: string[];
  try {
    names = readdirSync(home);
  } catch (err) {
    return {
      ...emptySummary(),
      ok: false,
      detail: `readdir ${home}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const summary = emptySummary();
  const cutoffMs = opts.nowMs - opts.minAgeMs;
  for (const name of names) {
    if (!isDeletingOrphanName(name)) continue;
    const entry = join(home, name);
    if (!isOlderThan(entry, cutoffMs)) {
      summary.skipped += 1;
      continue;
    }
    if (removePath(entry)) summary.removed += 1;
    else summary.ok = false;
  }
  return summary;
}

export function buildDeletingOrphanReclaimScript(
  invokerHome: string,
  minAgeMinutes = Math.floor(REAPER_DELETING_ORPHAN_MIN_AGE_MS / 60_000),
): string {
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
if [ ! -d "$INVOKER_HOME" ]; then
  echo "removed=0"
  exit 0
fi
removed=0
while IFS= read -r -d '' entry; do
  name="\${entry##*/}"
  case "$name" in
    *'.deleting.'*)
      rm -rf -- "$entry" >/dev/null 2>&1 || true
      removed=$((removed + 1))
      ;;
  esac
done < <(find "$INVOKER_HOME" -mindepth 1 -maxdepth 1 -name '*.deleting.*' -mmin +${minAgeMinutes} -print0 2>/dev/null)
echo "removed=$removed"
exit 0
`;
}

async function reclaimRemoteDeletingOrphans(opts: {
  target: RemoteDiskTarget;
  logger?: Logger;
  minAgeMs: number;
  runRemoteScript?: (target: RemoteDiskTarget, script: string) => Promise<string>;
}): Promise<ReaperRemoteResult> {
  const targetKey = `ssh:${opts.target.name} ${opts.target.remotePath}`;
  if (!isSafeRemoteInvokerHomePath(opts.target.remotePath)) {
    return { targetKey, ok: false, reason: 'path-guard', detail: opts.target.remotePath };
  }

  const script = buildDeletingOrphanReclaimScript(
    opts.target.remotePath,
    Math.floor(opts.minAgeMs / 60_000),
  );
  const run = opts.runRemoteScript ?? defaultRunRemoteReaperScript;
  try {
    const output = await run(opts.target, script);
    opts.logger?.info?.(`[reaper-reclaim] remote deleting orphan sweep ${targetKey}`, {
      module: 'reaper-reclaim',
      targetKey,
      outputTail: output.slice(-400),
    });
    return { targetKey, ok: true, reason: 'deleting-orphans', detail: output.slice(-400) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    opts.logger?.warn?.(`[reaper-reclaim] remote deleting orphan sweep failed ${targetKey}`, {
      module: 'reaper-reclaim',
      targetKey,
      detail,
    });
    return { targetKey, ok: false, reason: 'cleanup-error', detail };
  }
}

function defaultRunRemoteReaperScript(target: RemoteDiskTarget, script: string): Promise<string> {
  const sshArgs = buildSshConnectionArgs(target.connection, { batchMode: true });
  return execRemoteCapture({
    sshArgs,
    script,
    phase: `reaper-reclaim:${target.name}`,
  });
}

export async function reclaimDeletingOrphans(
  opts: ReclaimDeletingOrphansOptions = {},
): Promise<{ local: ReaperCleanupSummary; remotes: ReaperRemoteResult[] }> {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const userHome = opts.userHome ?? homedir();
  const minAgeMs = opts.minAgeMs ?? REAPER_DELETING_ORPHAN_MIN_AGE_MS;
  const nowMs = opts.nowMs ?? Date.now();

  const local = reclaimLocalDeletingOrphans({ invokerHome, userHome, minAgeMs, nowMs });
  const remotes = await Promise.all(
    (opts.remoteTargets ?? []).map((target) =>
      reclaimRemoteDeletingOrphans({
        target,
        logger: opts.logger,
        minAgeMs,
        runRemoteScript: opts.runRemoteScript,
      }),
    ),
  );
  return { local, remotes };
}

export function reclaimAutomationCheckoutWork(
  opts: ReclaimAutomationWorkOptions = {},
): ReaperCleanupSummary {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const userHome = opts.userHome ?? homedir();
  const home = guardedHome(invokerHome, userHome);
  if (!home) return { ...emptySummary(), ok: false, detail: 'path-guard' };

  const summary = emptySummary();
  const cutoffMs = (opts.nowMs ?? Date.now()) - (opts.minAgeMs ?? REAPER_AUTOMATION_WORK_MIN_AGE_MS);
  for (const dir of REAPER_AUTOMATION_WORK_DIRS) {
    const parent = join(home, dir);
    let names: string[];
    try {
      names = readdirSync(parent);
    } catch {
      continue;
    }
    for (const name of names) {
      const entry = join(parent, name);
      if (!isOlderThan(entry, cutoffMs)) {
        summary.skipped += 1;
        continue;
      }
      if (removePath(entry)) summary.removed += 1;
      else summary.ok = false;
    }
  }
  return summary;
}

export function pruneHourlySnapshotsOnReaperSchedule(
  opts: PruneHourlySnapshotsOptions = {},
): number {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const userHome = opts.userHome ?? homedir();
  const home = guardedHome(invokerHome, userHome);
  if (!home) return 0;
  const backupDir = join(home, 'db-backups');
  return pruneHourlySnapshots(backupDir, hourlySnapshotRetention());
}

function logGlobMatches(invokerHome: string, glob: string): string[] {
  if (glob === 'slack-manager*.log') {
    let names: string[];
    try {
      names = readdirSync(invokerHome);
    } catch {
      return [];
    }
    return names
      .filter((name) => /^slack-manager.*\.log$/.test(name))
      .map((name) => join(invokerHome, name));
  }
  if (glob === 'slack-manager/*.log' || glob === 'e2e-regression-watch/*.log') {
    const [dirName] = glob.split('/');
    let names: string[];
    try {
      names = readdirSync(join(invokerHome, dirName));
    } catch {
      return [];
    }
    return names
      .filter((name) => name.endsWith('.log'))
      .map((name) => join(invokerHome, dirName, name));
  }
  return [];
}

function knownLogPaths(invokerHome: string): string[] {
  const paths = [
    ...REAPER_LOG_FILE_NAMES.map((name) => join(invokerHome, name)),
    ...REAPER_LOG_FILE_GLOBS.flatMap((glob) => logGlobMatches(invokerHome, glob)),
  ];
  return [...new Set(paths)];
}

function trimFileInPlace(path: string, maxBytes: number, keepBytes: number): boolean {
  let size = 0;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size <= maxBytes) return false;
    size = stat.size;
  } catch {
    return false;
  }

  const fd = openSync(path, 'r+');
  try {
    const current = fstatSync(fd);
    if (!current.isFile() || current.size <= maxBytes) return false;
    size = current.size;
    const tailBytes = Math.min(keepBytes, size);
    const tail = Buffer.allocUnsafe(tailBytes);
    const bytesRead = readSync(fd, tail, 0, tailBytes, size - tailBytes);
    ftruncateSync(fd, 0);
    writeSync(fd, tail, 0, bytesRead, 0);
    ftruncateSync(fd, bytesRead);
    return true;
  } finally {
    closeSync(fd);
  }
}

export function trimInvokerLogs(opts: TrimInvokerLogsOptions = {}): ReaperCleanupSummary {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const userHome = opts.userHome ?? homedir();
  const home = guardedHome(invokerHome, userHome);
  if (!home) return { ...emptySummary(), ok: false, detail: 'path-guard' };

  const maxBytes = opts.maxBytes ?? REAPER_LOG_TRIM_MAX_BYTES;
  const keepBytes = opts.keepBytes ?? REAPER_LOG_TRIM_KEEP_BYTES;
  const summary = emptySummary();
  for (const path of knownLogPaths(home)) {
    try {
      if (trimFileInPlace(path, maxBytes, keepBytes)) summary.trimmed += 1;
      else summary.skipped += 1;
    } catch {
      summary.ok = false;
    }
  }
  return summary;
}

import {
  hourlySnapshotRetention,
  pruneHourlySnapshots,
} from '../../../app/src/delete-all-snapshot.js';
