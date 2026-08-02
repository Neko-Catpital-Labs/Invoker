import {
  closeSync,
  existsSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
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

export const REAPER_DELETING_ORPHAN_MIN_AGE_MS = 30 * 60 * 1000;
export const REAPER_ADMIN_WORK_MIN_AGE_MS = 48 * 60 * 60 * 1000;
export const REAPER_LOG_TRIM_THRESHOLD_BYTES = 100 * 1024 * 1024;
export const REAPER_LOG_TAIL_BYTES = 20 * 1024 * 1024;

export const REAPER_ADMIN_WORK_DIRS = [
  'mergify-admin-requeue-work',
  'land-admin-bypass-work',
] as const;

export const REAPER_EXACT_LOG_FILES = ['invoker.log', 'gui.log'] as const;
export const REAPER_LARGE_LOG_GLOBS = ['auto-*-self-prs.log'] as const;

export interface ReaperReclaimResult {
  targetKey: string;
  ok: boolean;
  reason: string;
  removed?: number;
  detail?: string;
}

export interface ReaperLogTrimResult {
  path: string;
  ok: boolean;
  action: 'trimmed' | 'skipped' | 'error';
  beforeBytes?: number;
  afterBytes?: number;
  detail?: string;
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

function immediateChildrenOlderThan(opts: {
  root: string;
  minAgeMs: number;
  nowMs: number;
  matchName?: (name: string) => boolean;
  errors: string[];
}): string[] {
  if (!existsSync(opts.root)) return [];
  let names: string[];
  try {
    names = readdirSync(opts.root);
  } catch (err) {
    opts.errors.push(`readdir ${opts.root}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  const cutoffMs = opts.nowMs - opts.minAgeMs;
  const selected: string[] = [];
  for (const name of names) {
    if (opts.matchName && !opts.matchName(name)) continue;
    const child = join(opts.root, name);
    let stat;
    try {
      stat = lstatSync(child);
    } catch (err) {
      opts.errors.push(`lstat ${child}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (stat.mtimeMs <= cutoffMs) {
      selected.push(child);
    }
  }
  return selected;
}

function reclaimLocalImmediateChildren(opts: {
  root: string;
  minAgeMs: number;
  nowMs: number;
  matchName?: (name: string) => boolean;
}): { removed: number; errors: string[] } {
  const errors: string[] = [];
  const stale = immediateChildrenOlderThan({
    root: opts.root,
    minAgeMs: opts.minAgeMs,
    nowMs: opts.nowMs,
    matchName: opts.matchName,
    errors,
  });

  let removed = 0;
  for (const path of stale) {
    if (removePath(path, errors)) removed += 1;
  }
  return { removed, errors };
}

function buildDeletingOrphanReclaimScript(invokerHome: string, minAgeMinutes: number): string {
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
echo "[reaper-reclaim] deleting-orphans begin home=$INVOKER_HOME"
if [ -d "$INVOKER_HOME" ]; then
  while IFS= read -r -d '' entry; do
    rm -rf "$entry" 2>/dev/null || true
  done < <(find "$INVOKER_HOME" -mindepth 1 -maxdepth 1 -name '*.deleting.*' -mmin +${minAgeMinutes} -print0 2>/dev/null)
fi
echo "[reaper-reclaim] deleting-orphans done"
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

export async function reclaimDeletingOrphans(opts: {
  invokerHome?: string;
  remoteTargets?: RemoteDiskTarget[];
  logger?: Logger;
  userHome?: string;
  nowMs?: number;
  runRemoteScript?: (target: RemoteDiskTarget, script: string) => Promise<string>;
} = {}): Promise<ReaperReclaimResult[]> {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const userHome = opts.userHome ?? homedir();
  const home = expandTildeHome(invokerHome, userHome);
  const nowMs = opts.nowMs ?? Date.now();
  const results: ReaperReclaimResult[] = [];

  const localTargetKey = `local ${home}`;
  if (!isSafeInvokerHome(home, userHome)) {
    results.push({ targetKey: localTargetKey, ok: false, reason: 'path-guard', detail: home });
  } else {
    const { removed, errors } = reclaimLocalImmediateChildren({
      root: home,
      minAgeMs: REAPER_DELETING_ORPHAN_MIN_AGE_MS,
      nowMs,
      matchName: isDeletingOrphanName,
    });
    if (errors.length > 0) {
      opts.logger?.warn?.('[reaper-reclaim] deleting-orphans local partial failures', {
        module: 'reaper-reclaim',
        targetKey: localTargetKey,
        errors,
      });
      results.push({
        targetKey: localTargetKey,
        ok: false,
        reason: 'cleanup-error',
        removed,
        detail: errors.slice(0, 5).join('; '),
      });
    } else {
      results.push({
        targetKey: localTargetKey,
        ok: true,
        reason: 'deleting-orphan-reclaim',
        removed,
      });
    }
  }

  const runRemote = opts.runRemoteScript ?? defaultRunRemoteDeletingOrphans;
  const remoteResults = await Promise.all(
    (opts.remoteTargets ?? []).map(async (target): Promise<ReaperReclaimResult> => {
      const targetKey = `ssh:${target.name} ${target.remotePath}`;
      if (!isSafeRemoteInvokerHomePath(target.remotePath)) {
        return {
          targetKey,
          ok: false,
          reason: 'path-guard',
          detail: target.remotePath,
        };
      }

      const script = buildDeletingOrphanReclaimScript(
        target.remotePath,
        Math.floor(REAPER_DELETING_ORPHAN_MIN_AGE_MS / 60_000),
      );
      try {
        const output = await runRemote(target, script);
        return {
          targetKey,
          ok: true,
          reason: 'deleting-orphan-reclaim',
          detail: output.slice(-400),
        };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        opts.logger?.warn?.(`[reaper-reclaim] deleting-orphans remote failed ${targetKey}: ${detail}`, {
          module: 'reaper-reclaim',
          targetKey,
        });
        return {
          targetKey,
          ok: false,
          reason: 'cleanup-error',
          detail,
        };
      }
    }),
  );
  results.push(...remoteResults);

  return results;
}

export function reclaimAutomationCheckoutWork(opts: {
  invokerHome?: string;
  nowMs?: number;
} = {}): ReaperReclaimResult[] {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const nowMs = opts.nowMs ?? Date.now();
  return REAPER_ADMIN_WORK_DIRS.map((name) => {
    const targetKey = join(invokerHome, name);
    const { removed, errors } = reclaimLocalImmediateChildren({
      root: targetKey,
      minAgeMs: REAPER_ADMIN_WORK_MIN_AGE_MS,
      nowMs,
    });
    return {
      targetKey,
      ok: errors.length === 0,
      reason: errors.length === 0 ? 'automation-checkout-reclaim' : 'cleanup-error',
      removed,
      detail: errors.length > 0 ? errors.slice(0, 5).join('; ') : undefined,
    };
  });
}

export function pruneHourlySnapshotBacklog(opts: {
  invokerHome?: string;
  backupDir?: string;
} = {}): number {
  const backupDir = opts.backupDir ?? join(opts.invokerHome ?? resolveInvokerHomeRoot(), 'db-backups');
  return pruneHourlySnapshots(backupDir, hourlySnapshotRetention());
}

function globToTopLevelRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '[^/]*')}$`);
}

const REAPER_LARGE_LOG_REGEXES = REAPER_LARGE_LOG_GLOBS.map(globToTopLevelRegExp);

function largeLogGlobMatches(name: string): boolean {
  return REAPER_LARGE_LOG_REGEXES.some((regex) => regex.test(name));
}

function resolveLogTrimCandidates(invokerHome: string): string[] {
  const paths = new Set(REAPER_EXACT_LOG_FILES.map((name) => join(invokerHome, name)));
  let names: string[];
  try {
    names = readdirSync(invokerHome);
  } catch {
    return [...paths];
  }
  for (const name of names) {
    if (largeLogGlobMatches(name)) {
      paths.add(join(invokerHome, name));
    }
  }
  return [...paths].sort();
}

function trimLogFile(path: string, thresholdBytes: number, tailBytes: number): ReaperLogTrimResult {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path, ok: true, action: 'skipped' };
    }
    return {
      path,
      ok: false,
      action: 'error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (size <= thresholdBytes) {
    return { path, ok: true, action: 'skipped', beforeBytes: size, afterBytes: size };
  }

  const bytesToKeep = Math.min(size, tailBytes);
  const buffer = Buffer.allocUnsafe(bytesToKeep);
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r+');
    const bytesRead = readSync(fd, buffer, 0, bytesToKeep, size - bytesToKeep);
    ftruncateSync(fd, 0);
    writeSync(fd, buffer, 0, bytesRead, 0);
    ftruncateSync(fd, bytesRead);
    return {
      path,
      ok: true,
      action: 'trimmed',
      beforeBytes: size,
      afterBytes: bytesRead,
    };
  } catch (err) {
    return {
      path,
      ok: false,
      action: 'error',
      beforeBytes: size,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function trimInvokerLogs(opts: {
  invokerHome?: string;
  thresholdBytes?: number;
  tailBytes?: number;
} = {}): ReaperLogTrimResult[] {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const thresholdBytes = opts.thresholdBytes ?? REAPER_LOG_TRIM_THRESHOLD_BYTES;
  const tailBytes = opts.tailBytes ?? REAPER_LOG_TAIL_BYTES;
  if (thresholdBytes < 0 || tailBytes <= 0) {
    return [{
      path: invokerHome,
      ok: false,
      action: 'error',
      detail: 'invalid log trim size',
    }];
  }
  return resolveLogTrimCandidates(invokerHome)
    .map((path) => trimLogFile(path, thresholdBytes, tailBytes));
}
