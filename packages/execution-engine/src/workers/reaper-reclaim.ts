import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Logger } from '@invoker/contracts';

import { hourlySnapshotRetention, pruneHourlySnapshots } from '../../../app/src/delete-all-snapshot.js';
import { buildSshConnectionArgs } from '../ssh-transport-options.js';
import { bashNormalizeTildePath, execRemoteCapture, shellPosixSingleQuote } from '../ssh-git-exec.js';

import type { RemoteDiskTarget } from './disk-headroom-monitor.js';
import {
  expandTildeHome,
  isDeletingOrphanName,
  isSafeInvokerHome,
  isSafeRemoteInvokerHomePath,
  type DiskCleanupResult,
} from './disk-headroom-reclaim.js';

export const DELETING_ORPHAN_MIN_AGE_MINUTES = 30;

export const AUTOMATION_CHECKOUT_DIRS = [
  'mergify-admin-requeue-work',
  'land-admin-bypass-work',
] as const;

export const AUTOMATION_CHECKOUT_MIN_AGE_HOURS = 48;

export const LOG_TRIM_MAX_BYTES = 100 * 1024 * 1024;
export const LOG_TRIM_KEEP_BYTES = 20 * 1024 * 1024;
export const REAPER_LOG_SUFFIX = '.log';

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function entryAgeMs(path: string, nowMs: number): number | null {
  try {
    return nowMs - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

export function buildDeletingOrphanReapScript(invokerHome: string): string {
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
find "$INVOKER_HOME" -mindepth 1 -maxdepth 1 -name '*.deleting.*' -mmin +${DELETING_ORPHAN_MIN_AGE_MINUTES} \\
  -print0 2>/dev/null | while IFS= read -r -d '' entry; do
  rm -rf "$entry" >/dev/null 2>&1
done
exit 0
`;
}

export function reapLocalDeletingOrphans(opts: {
  invokerHome: string;
  logger?: Logger;
  userHome?: string;
  nowMs?: number;
}): DiskCleanupResult {
  const targetKey = `local ${opts.invokerHome}`;
  const userHome = opts.userHome ?? homedir();
  const home = expandTildeHome(opts.invokerHome, userHome);
  if (!isSafeInvokerHome(home, userHome)) {
    return { targetKey, ok: false, reason: 'path-guard', detail: home };
  }
  if (!existsSync(home)) {
    return { targetKey, ok: true, reason: 'reap-orphans', detail: 'removed 0' };
  }

  const nowMs = opts.nowMs ?? Date.now();
  const minAgeMs = DELETING_ORPHAN_MIN_AGE_MINUTES * 60 * 1000;
  const errors: string[] = [];
  let removed = 0;

  let entries: string[] = [];
  try {
    entries = readdirSync(home);
  } catch (err) {
    errors.push(`readdir ${home}: ${errorDetail(err)}`);
  }
  for (const name of entries) {
    if (!isDeletingOrphanName(name)) continue;
    const path = join(home, name);
    const ageMs = entryAgeMs(path, nowMs);
    if (ageMs === null || ageMs < minAgeMs) continue;
    try {
      rmSync(path, { recursive: true, force: true });
      removed += 1;
      opts.logger?.info?.(`[reaper] removed orphan ${path}`, { module: 'reaper', targetKey });
    } catch (err) {
      errors.push(`${path}: ${errorDetail(err)}`);
    }
  }

  if (errors.length > 0) {
    return { targetKey, ok: false, reason: 'cleanup-error', detail: errors.slice(0, 5).join('; ') };
  }
  return { targetKey, ok: true, reason: 'reap-orphans', detail: `removed ${removed}` };
}

export async function reapRemoteDeletingOrphans(opts: {
  target: RemoteDiskTarget;
  logger?: Logger;
  runRemoteScript?: (target: RemoteDiskTarget, script: string) => Promise<string>;
}): Promise<DiskCleanupResult> {
  const targetKey = `ssh:${opts.target.name} ${opts.target.remotePath}`;
  if (!isSafeRemoteInvokerHomePath(opts.target.remotePath)) {
    return { targetKey, ok: false, reason: 'path-guard', detail: opts.target.remotePath };
  }

  const script = buildDeletingOrphanReapScript(opts.target.remotePath);
  const run = opts.runRemoteScript ?? defaultRunRemoteReap;
  try {
    const output = await run(opts.target, script);
    return { targetKey, ok: true, reason: 'reap-orphans', detail: output.slice(-400) };
  } catch (err) {
    const detail = errorDetail(err);
    opts.logger?.error?.(`[reaper] remote orphan reap failed ${targetKey}: ${detail}`, {
      module: 'reaper',
      targetKey,
    });
    return { targetKey, ok: false, reason: 'cleanup-error', detail };
  }
}

function defaultRunRemoteReap(target: RemoteDiskTarget, script: string): Promise<string> {
  const sshArgs = buildSshConnectionArgs(target.connection, { batchMode: true });
  return execRemoteCapture({
    sshArgs,
    script,
    phase: `reaper-orphans:${target.name}`,
  });
}

export async function reapDeletingOrphans(opts: {
  invokerHome: string;
  remoteTargets?: RemoteDiskTarget[];
  logger?: Logger;
  userHome?: string;
  nowMs?: number;
  runRemoteScript?: (target: RemoteDiskTarget, script: string) => Promise<string>;
}): Promise<DiskCleanupResult[]> {
  const results: DiskCleanupResult[] = [reapLocalDeletingOrphans(opts)];
  for (const target of opts.remoteTargets ?? []) {
    results.push(
      await reapRemoteDeletingOrphans({
        target,
        logger: opts.logger,
        runRemoteScript: opts.runRemoteScript,
      }),
    );
  }
  return results;
}

export function reapStaleAutomationCheckouts(opts: {
  invokerHome: string;
  logger?: Logger;
  userHome?: string;
  nowMs?: number;
}): string[] {
  const userHome = opts.userHome ?? homedir();
  const home = expandTildeHome(opts.invokerHome, userHome);
  if (!isSafeInvokerHome(home, userHome)) return [];

  const nowMs = opts.nowMs ?? Date.now();
  const minAgeMs = AUTOMATION_CHECKOUT_MIN_AGE_HOURS * 60 * 60 * 1000;
  const removed: string[] = [];

  for (const dirName of AUTOMATION_CHECKOUT_DIRS) {
    const dir = join(home, dirName);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const path = join(dir, name);
      const ageMs = entryAgeMs(path, nowMs);
      if (ageMs === null || ageMs < minAgeMs) continue;
      try {
        rmSync(path, { recursive: true, force: true });
        removed.push(path);
        opts.logger?.info?.(`[reaper] removed stale checkout ${path}`, { module: 'reaper' });
      } catch (err) {
        opts.logger?.warn?.(`[reaper] failed to remove ${path}: ${errorDetail(err)}`, {
          module: 'reaper',
        });
      }
    }
  }
  return removed;
}

export function enforceHourlySnapshotRetention(
  invokerHome: string,
  userHome: string = homedir(),
): number {
  const home = expandTildeHome(invokerHome, userHome);
  return pruneHourlySnapshots(join(home, 'db-backups'), hourlySnapshotRetention());
}

export function trimOversizedLogs(opts: {
  invokerHome: string;
  logger?: Logger;
  userHome?: string;
  maxBytes?: number;
  keepBytes?: number;
}): string[] {
  const userHome = opts.userHome ?? homedir();
  const home = expandTildeHome(opts.invokerHome, userHome);
  if (!isSafeInvokerHome(home, userHome)) return [];

  const maxBytes = opts.maxBytes ?? LOG_TRIM_MAX_BYTES;
  const keepBytes = opts.keepBytes ?? LOG_TRIM_KEEP_BYTES;

  let entries: string[];
  try {
    entries = readdirSync(home);
  } catch {
    return [];
  }

  const trimmed: string[] = [];
  for (const name of entries) {
    if (!name.endsWith(REAPER_LOG_SUFFIX)) continue;
    const path = join(home, name);
    let size: number;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      size = stat.size;
    } catch {
      continue;
    }
    if (size <= maxBytes) continue;
    try {
      trimLogTail(path, size, keepBytes);
      trimmed.push(path);
      opts.logger?.info?.(`[reaper] trimmed log ${path} from ${size} bytes`, { module: 'reaper' });
    } catch (err) {
      opts.logger?.warn?.(`[reaper] failed to trim ${path}: ${errorDetail(err)}`, {
        module: 'reaper',
      });
    }
  }
  return trimmed;
}

function trimLogTail(path: string, size: number, keepBytes: number): void {
  const length = Math.min(keepBytes, size);
  const tail = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, tail, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  writeFileSync(path, tail);
}
