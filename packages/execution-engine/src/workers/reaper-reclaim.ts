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
export const AUTOMATION_CHECKOUT_WORK_MIN_AGE_MS = 48 * 60 * 60 * 1000;
export const LOG_TRIM_THRESHOLD_BYTES = 100 * 1024 * 1024;
export const LOG_RETAIN_BYTES = 20 * 1024 * 1024;

export const AUTOMATION_CHECKOUT_WORK_DIRS = [
  'mergify-admin-requeue-work',
  'land-admin-bypass-work',
] as const;

export const INVOKER_LOG_RELATIVE_PATHS = [
  'invoker.log',
  'gui.log',
  'merge-trace.log',
  'slack-manager.log',
  'slack-manager.keepalive.log',
  'reconciliation-refactor-cron.log',
  'e2e-regression-watch/cron.log',
] as const;

export const INVOKER_LOG_GLOBS = ['slack-manager/*.log'] as const;

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
  minAgeMs?: number;
  logger?: Logger;
  runRemoteScript?: (target: RemoteDiskTarget, script: string) => Promise<string>;
}

export interface ReapAutomationCheckoutWorkOptions {
  invokerHome?: string;
  userHome?: string;
  nowMs?: number;
  minAgeMs?: number;
  logger?: Logger;
}

interface DeleteAllSnapshotExports {
  hourlySnapshotRetention: () => number;
  pruneHourlySnapshots: (backupDir: string, retain: number) => number;
}

export interface PruneHourlySnapshotsForReaperOptions {
  invokerHome?: string;
  backupDir?: string;
  snapshotFns?: DeleteAllSnapshotExports;
}

export interface TrimInvokerLogFilesOptions {
  invokerHome?: string;
  thresholdBytes?: number;
  retainBytes?: number;
  logger?: Logger;
}

function ageEligible(mtimeMs: number, nowMs: number, minAgeMs: number): boolean {
  return mtimeMs <= nowMs - minAgeMs;
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

function localInvokerHome(invokerHome: string | undefined, userHome: string | undefined): string {
  return expandTildeHome(invokerHome ?? resolveInvokerHomeRoot(), userHome ?? homedir());
}

function reapLocalDeletingOrphans(opts: {
  invokerHome: string;
  userHome?: string;
  nowMs: number;
  minAgeMs: number;
  logger?: Logger;
}): ReaperReclaimResult {
  const userHome = opts.userHome ?? homedir();
  const home = expandTildeHome(opts.invokerHome, userHome);
  const targetKey = `local ${home}`;
  if (!isSafeInvokerHome(home, userHome)) {
    return { targetKey, ok: false, reason: 'path-guard', detail: home };
  }
  if (!existsSync(home)) {
    return { targetKey, ok: true, reason: 'deleting-orphans', removed: 0 };
  }

  const errors: string[] = [];
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(home);
  } catch (err) {
    return {
      targetKey,
      ok: false,
      reason: 'readdir-error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  for (const name of entries) {
    if (!isDeletingOrphanName(name)) continue;
    const path = join(home, name);
    try {
      const stat = lstatSync(path);
      if (!ageEligible(stat.mtimeMs, opts.nowMs, opts.minAgeMs)) continue;
      if (removePath(path, errors)) removed += 1;
    } catch (err) {
      errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (errors.length > 0) {
    opts.logger?.warn?.('[reaper-reclaim] local deleting orphan sweep partial failures', {
      module: 'reaper-reclaim',
      targetKey,
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

  return { targetKey, ok: true, reason: 'deleting-orphans', removed };
}

function buildRemoteDeletingOrphanReaperScript(invokerHome: string, minAgeMinutes: number): string {
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
  if rm -rf -- "$entry" >/dev/null 2>&1; then
    removed=$((removed + 1))
  fi
done < <(find "$INVOKER_HOME" -mindepth 1 -maxdepth 1 -name '*.deleting.*' -mmin +${minAgeMinutes} -print0 2>/dev/null)
echo "[reaper-reclaim] deleting-orphans removed=$removed home=$INVOKER_HOME"
exit 0
`;
}

function defaultRunRemoteReaper(target: RemoteDiskTarget, script: string): Promise<string> {
  const sshArgs = buildSshConnectionArgs(target.connection, { batchMode: true });
  return execRemoteCapture({
    sshArgs,
    script,
    phase: `reaper-reclaim:${target.name}`,
  });
}

async function reapRemoteDeletingOrphans(opts: {
  target: RemoteDiskTarget;
  minAgeMs: number;
  logger?: Logger;
  runRemoteScript?: (target: RemoteDiskTarget, script: string) => Promise<string>;
}): Promise<ReaperReclaimResult> {
  const targetKey = `ssh:${opts.target.name} ${opts.target.remotePath}`;
  if (!isSafeRemoteInvokerHomePath(opts.target.remotePath)) {
    return { targetKey, ok: false, reason: 'path-guard', detail: opts.target.remotePath };
  }
  const minAgeMinutes = Math.floor(opts.minAgeMs / 60_000);
  const script = buildRemoteDeletingOrphanReaperScript(opts.target.remotePath, minAgeMinutes);
  const run = opts.runRemoteScript ?? defaultRunRemoteReaper;
  try {
    const output = await run(opts.target, script);
    const removedMatch = output.match(/deleting-orphans removed=(\d+)/);
    return {
      targetKey,
      ok: true,
      reason: 'deleting-orphans',
      removed: removedMatch ? Number(removedMatch[1]) : undefined,
      detail: output.slice(-400),
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    opts.logger?.warn?.(`[reaper-reclaim] remote deleting orphan sweep failed ${targetKey}: ${detail}`, {
      module: 'reaper-reclaim',
      targetKey,
    });
    return { targetKey, ok: false, reason: 'cleanup-error', detail };
  }
}

export async function reapDeletingOrphans(
  opts: ReapDeletingOrphansOptions = {},
): Promise<ReaperReclaimResult[]> {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const minAgeMs = opts.minAgeMs ?? DELETING_ORPHAN_MIN_AGE_MS;
  const nowMs = opts.nowMs ?? Date.now();
  const local = reapLocalDeletingOrphans({
    invokerHome,
    userHome: opts.userHome,
    nowMs,
    minAgeMs,
    logger: opts.logger,
  });
  const remotes = await Promise.all(
    (opts.remoteTargets ?? []).map((target) =>
      reapRemoteDeletingOrphans({
        target,
        minAgeMs,
        logger: opts.logger,
        runRemoteScript: opts.runRemoteScript,
      }),
    ),
  );
  return [local, ...remotes];
}

export function reapAutomationCheckoutWork(
  opts: ReapAutomationCheckoutWorkOptions = {},
): ReaperReclaimResult {
  const home = localInvokerHome(opts.invokerHome, opts.userHome);
  const userHome = opts.userHome ?? homedir();
  const targetKey = `local ${home}`;
  if (!isSafeInvokerHome(home, userHome)) {
    return { targetKey, ok: false, reason: 'path-guard', detail: home };
  }

  const nowMs = opts.nowMs ?? Date.now();
  const minAgeMs = opts.minAgeMs ?? AUTOMATION_CHECKOUT_WORK_MIN_AGE_MS;
  const errors: string[] = [];
  let removed = 0;

  for (const dirName of AUTOMATION_CHECKOUT_WORK_DIRS) {
    const root = join(home, dirName);
    if (!existsSync(root)) continue;
    let children: string[];
    try {
      children = readdirSync(root);
    } catch (err) {
      errors.push(`readdir ${root}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const child of children) {
      const path = join(root, child);
      try {
        const stat = lstatSync(path);
        if (!ageEligible(stat.mtimeMs, nowMs, minAgeMs)) continue;
        if (removePath(path, errors)) removed += 1;
      } catch (err) {
        errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (errors.length > 0) {
    opts.logger?.warn?.('[reaper-reclaim] automation checkout sweep partial failures', {
      module: 'reaper-reclaim',
      targetKey,
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

  return { targetKey, ok: true, reason: 'automation-checkout-work', removed };
}

async function loadDeleteAllSnapshotExports(): Promise<DeleteAllSnapshotExports> {
  return import('../../../app/src/delete-all-snapshot.js') as Promise<DeleteAllSnapshotExports>;
}

export async function pruneHourlySnapshotsForReaper(
  opts: PruneHourlySnapshotsForReaperOptions = {},
): Promise<number> {
  const snapshotFns = opts.snapshotFns ?? await loadDeleteAllSnapshotExports();
  const backupDir = opts.backupDir ?? join(opts.invokerHome ?? resolveInvokerHomeRoot(), 'db-backups');
  return snapshotFns.pruneHourlySnapshots(backupDir, snapshotFns.hourlySnapshotRetention());
}

function collectInvokerLogPaths(invokerHome: string): string[] {
  const paths = new Set<string>();
  for (const relativePath of INVOKER_LOG_RELATIVE_PATHS) {
    paths.add(join(invokerHome, relativePath));
  }

  const slackManagerLogDir = join(invokerHome, 'slack-manager');
  if (existsSync(slackManagerLogDir)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(slackManagerLogDir);
    } catch {
      entries = [];
    }
    for (const name of entries) {
      if (name.endsWith('.log')) paths.add(join(slackManagerLogDir, name));
    }
  }

  return [...paths];
}

function trimOneLogFile(path: string, thresholdBytes: number, retainBytes: number): boolean {
  if (!existsSync(path)) return false;
  const lst = lstatSync(path);
  if (!lst.isFile() || lst.size <= thresholdBytes) return false;

  const fd = openSync(path, 'r+');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= thresholdBytes) return false;
    const keep = Math.min(retainBytes, stat.size);
    const buffer = Buffer.allocUnsafe(keep);
    readSync(fd, buffer, 0, keep, stat.size - keep);
    ftruncateSync(fd, 0);
    writeSync(fd, buffer, 0, keep, 0);
    return true;
  } finally {
    closeSync(fd);
  }
}

export function trimInvokerLogFiles(
  opts: TrimInvokerLogFilesOptions = {},
): ReaperReclaimResult {
  const home = opts.invokerHome ?? resolveInvokerHomeRoot();
  const targetKey = `local ${home}`;
  const thresholdBytes = opts.thresholdBytes ?? LOG_TRIM_THRESHOLD_BYTES;
  const retainBytes = opts.retainBytes ?? LOG_RETAIN_BYTES;
  const errors: string[] = [];
  let trimmed = 0;

  for (const logPath of collectInvokerLogPaths(home)) {
    try {
      if (trimOneLogFile(logPath, thresholdBytes, retainBytes)) trimmed += 1;
    } catch (err) {
      errors.push(`${logPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (errors.length > 0) {
    opts.logger?.warn?.('[reaper-reclaim] log trim partial failures', {
      module: 'reaper-reclaim',
      targetKey,
      errors,
    });
    return {
      targetKey,
      ok: false,
      reason: 'trim-error',
      trimmed,
      detail: errors.slice(0, 5).join('; '),
    };
  }

  return { targetKey, ok: true, reason: 'log-trim', trimmed };
}
