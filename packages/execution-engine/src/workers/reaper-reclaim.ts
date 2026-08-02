import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  writeSync,
  ftruncateSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveInvokerHomeRoot, type Logger } from '@invoker/contracts';

import {
  hourlySnapshotRetention,
  pruneHourlySnapshots,
} from '../../../app/src/delete-all-snapshot.js';
import { buildSshConnectionArgs } from '../ssh-transport-options.js';
import { bashNormalizeTildePath, execRemoteCapture, shellPosixSingleQuote } from '../ssh-git-exec.js';

import type { RemoteDiskTarget } from './disk-headroom-monitor.js';
import {
  expandTildeHome,
  isDeletingOrphanName,
  isSafeInvokerHome,
  isSafeRemoteInvokerHomePath,
} from './disk-headroom-reclaim.js';

export const DELETING_ORPHAN_MIN_AGE_MS = 30 * 60 * 1000;
export const AUTOMATION_CHECKOUT_MIN_AGE_MS = 48 * 60 * 60 * 1000;

export const AUTOMATION_CHECKOUT_DIRS = [
  'mergify-admin-requeue-work',
  'land-admin-bypass-work',
] as const;

export const INVOKER_LOG_TRIM_THRESHOLD_BYTES = 100 * 1024 * 1024;
export const INVOKER_LOG_TRIM_KEEP_BYTES = 20 * 1024 * 1024;
export const INVOKER_DIRECT_LOG_FILES = [
  'invoker.log',
  'gui.log',
  'merge-trace.log',
] as const;
export const INVOKER_GLOB_LOG_FILES = ['ui-*-events.jsonl'] as const;

export type ReaperReclaimAction =
  | 'deleting-orphans'
  | 'automation-checkout-work'
  | 'hourly-snapshots'
  | 'invoker-log-trim';

export interface ReaperReclaimResult {
  action: ReaperReclaimAction;
  targetKey: string;
  ok: boolean;
  reason: string;
  removed?: number;
  trimmed?: number;
  detail?: string;
}

export type RemoteReaperScriptRunner = (
  target: RemoteDiskTarget,
  script: string,
) => Promise<string>;

function fileAgeMs(path: string, nowMs: number): number | null {
  try {
    return nowMs - lstatSync(path).mtimeMs;
  } catch {
    return null;
  }
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

function resultFromErrors(
  action: ReaperReclaimAction,
  targetKey: string,
  removed: number,
  errors: string[],
): ReaperReclaimResult {
  if (errors.length > 0) {
    return {
      action,
      targetKey,
      ok: false,
      reason: 'cleanup-error',
      removed,
      detail: errors.slice(0, 5).join('; '),
    };
  }
  return { action, targetKey, ok: true, reason: 'cleanup', removed };
}

function readdirOrNull(path: string): string[] | null {
  try {
    return readdirSync(path);
  } catch {
    return null;
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

export function buildDeletingOrphanReclaimScript(
  invokerHome: string,
  minAgeMinutes = Math.floor(DELETING_ORPHAN_MIN_AGE_MS / 60_000),
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
removed=0
while IFS= read -r -d '' entry; do
  rm -rf "$entry" >/dev/null 2>&1 && removed=$((removed + 1))
done < <(find "$INVOKER_HOME" -mindepth 1 -maxdepth 1 -name '*.deleting.*' -mmin +${minAgeMinutes} -print0 2>/dev/null)
echo "[reaper-reclaim] deleting-orphans removed=$removed home=$INVOKER_HOME"
exit 0
`;
}

function reclaimLocalDeletingOrphans(opts: {
  invokerHome: string;
  userHome?: string;
  nowMs?: number;
  minAgeMs?: number;
}): ReaperReclaimResult {
  const userHome = opts.userHome ?? homedir();
  const home = expandTildeHome(opts.invokerHome, userHome);
  const targetKey = `local ${opts.invokerHome}`;
  if (!isSafeInvokerHome(home, userHome)) {
    return { action: 'deleting-orphans', targetKey, ok: false, reason: 'path-guard', detail: home };
  }

  const names = readdirOrNull(home);
  if (!names) return { action: 'deleting-orphans', targetKey, ok: true, reason: 'missing', removed: 0 };

  const nowMs = opts.nowMs ?? Date.now();
  const minAgeMs = opts.minAgeMs ?? DELETING_ORPHAN_MIN_AGE_MS;
  const errors: string[] = [];
  let removed = 0;
  for (const name of names) {
    if (!isDeletingOrphanName(name)) continue;
    const path = join(home, name);
    const age = fileAgeMs(path, nowMs);
    if (age === null || age < minAgeMs) continue;
    if (removePath(path, errors)) removed += 1;
  }
  return resultFromErrors('deleting-orphans', targetKey, removed, errors);
}

export async function reclaimDeletingOrphans(opts: {
  invokerHome?: string;
  remoteTargets?: RemoteDiskTarget[];
  logger?: Logger;
  userHome?: string;
  nowMs?: number;
  minAgeMs?: number;
  runRemoteScript?: RemoteReaperScriptRunner;
} = {}): Promise<ReaperReclaimResult[]> {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const results = [
    reclaimLocalDeletingOrphans({
      invokerHome,
      userHome: opts.userHome,
      nowMs: opts.nowMs,
      minAgeMs: opts.minAgeMs,
    }),
  ];

  const minAgeMinutes = Math.floor((opts.minAgeMs ?? DELETING_ORPHAN_MIN_AGE_MS) / 60_000);
  const runRemoteScript = opts.runRemoteScript ?? defaultRunRemoteReaper;
  for (const target of opts.remoteTargets ?? []) {
    const targetKey = `ssh:${target.name} ${target.remotePath}`;
    if (!isSafeRemoteInvokerHomePath(target.remotePath)) {
      results.push({
        action: 'deleting-orphans',
        targetKey,
        ok: false,
        reason: 'path-guard',
        detail: target.remotePath,
      });
      continue;
    }

    const script = buildDeletingOrphanReclaimScript(target.remotePath, minAgeMinutes);
    try {
      const output = await runRemoteScript(target, script);
      results.push({
        action: 'deleting-orphans',
        targetKey,
        ok: true,
        reason: 'cleanup',
        detail: output.slice(-400),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      opts.logger?.warn?.(`[reaper-reclaim] deleting orphan remote cleanup failed ${targetKey}: ${detail}`, {
        module: 'reaper-reclaim',
        targetKey,
      });
      results.push({
        action: 'deleting-orphans',
        targetKey,
        ok: false,
        reason: 'cleanup-error',
        detail,
      });
    }
  }

  return results;
}

export function reclaimAutomationCheckoutWork(opts: {
  invokerHome?: string;
  userHome?: string;
  nowMs?: number;
  minAgeMs?: number;
} = {}): ReaperReclaimResult {
  const userHome = opts.userHome ?? homedir();
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const home = expandTildeHome(invokerHome, userHome);
  const targetKey = `local ${invokerHome}`;
  if (!isSafeInvokerHome(home, userHome)) {
    return { action: 'automation-checkout-work', targetKey, ok: false, reason: 'path-guard', detail: home };
  }

  const nowMs = opts.nowMs ?? Date.now();
  const minAgeMs = opts.minAgeMs ?? AUTOMATION_CHECKOUT_MIN_AGE_MS;
  const errors: string[] = [];
  let removed = 0;
  for (const dirName of AUTOMATION_CHECKOUT_DIRS) {
    const parent = join(home, dirName);
    const names = readdirOrNull(parent);
    if (!names) continue;
    for (const name of names) {
      const path = join(parent, name);
      const age = fileAgeMs(path, nowMs);
      if (age === null || age < minAgeMs) continue;
      if (removePath(path, errors)) removed += 1;
    }
  }
  return resultFromErrors('automation-checkout-work', targetKey, removed, errors);
}

export function reclaimHourlySnapshots(opts: {
  invokerHome?: string;
  backupDir?: string;
} = {}): ReaperReclaimResult {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const backupDir = opts.backupDir ?? join(invokerHome, 'db-backups');
  const removed = pruneHourlySnapshots(backupDir, hourlySnapshotRetention());
  return {
    action: 'hourly-snapshots',
    targetKey: backupDir,
    ok: true,
    reason: 'cleanup',
    removed,
  };
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function logFilesInHome(invokerHome: string): string[] {
  const files = new Set(INVOKER_DIRECT_LOG_FILES.map((name) => join(invokerHome, name)));
  const names = readdirOrNull(invokerHome);
  if (!names) return [...files];

  const regexes = INVOKER_GLOB_LOG_FILES.map(globToRegExp);
  for (const name of names) {
    if (regexes.some((re) => re.test(name))) files.add(join(invokerHome, name));
  }
  return [...files];
}

function trimLogFile(path: string, thresholdBytes: number, keepBytes: number, errors: string[]): boolean {
  let fd: number | null = null;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size <= thresholdBytes) return false;

    fd = openSync(path, 'r+');
    const size = fstatSync(fd).size;
    if (size <= thresholdBytes) return false;
    const bytesToKeep = Math.min(size, keepBytes);
    const buffer = Buffer.allocUnsafe(bytesToKeep);
    readSync(fd, buffer, 0, bytesToKeep, size - bytesToKeep);
    ftruncateSync(fd, 0);
    writeSync(fd, buffer, 0, bytesToKeep, 0);
    return true;
  } catch (err) {
    if (existsSync(path)) {
      errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function reclaimInvokerLogs(opts: {
  invokerHome?: string;
  userHome?: string;
  thresholdBytes?: number;
  keepBytes?: number;
} = {}): ReaperReclaimResult {
  const userHome = opts.userHome ?? homedir();
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const home = expandTildeHome(invokerHome, userHome);
  const targetKey = `local ${invokerHome}`;
  if (!isSafeInvokerHome(home, userHome)) {
    return { action: 'invoker-log-trim', targetKey, ok: false, reason: 'path-guard', detail: home };
  }

  const thresholdBytes = opts.thresholdBytes ?? INVOKER_LOG_TRIM_THRESHOLD_BYTES;
  const keepBytes = opts.keepBytes ?? INVOKER_LOG_TRIM_KEEP_BYTES;
  const errors: string[] = [];
  let trimmed = 0;
  for (const file of logFilesInHome(home)) {
    if (trimLogFile(file, thresholdBytes, keepBytes, errors)) trimmed += 1;
  }

  if (errors.length > 0) {
    return {
      action: 'invoker-log-trim',
      targetKey,
      ok: false,
      reason: 'cleanup-error',
      trimmed,
      detail: errors.slice(0, 5).join('; '),
    };
  }
  return { action: 'invoker-log-trim', targetKey, ok: true, reason: 'cleanup', trimmed };
}
