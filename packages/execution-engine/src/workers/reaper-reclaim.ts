import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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

export const DELETING_ORPHAN_MIN_AGE_MS = 30 * 60 * 1000;
export const AUTOMATION_WORK_MIN_AGE_MS = 48 * 60 * 60 * 1000;
export const LOG_TRIM_THRESHOLD_BYTES = 100 * 1024 * 1024;
export const LOG_RETAIN_BYTES = 20 * 1024 * 1024;

export const AUTOMATION_CHECKOUT_WORK_DIRS = [
  'mergify-admin-requeue-work',
  'land-admin-bypass-work',
] as const;

export const KNOWN_INVOKER_LOG_FILES = [
  'invoker.log',
  'gui.log',
  'merge-trace.log',
] as const;

export const KNOWN_INVOKER_LOG_GLOBS = [
  'ui-*-events.jsonl',
] as const;

export interface ReaperReclaimResult {
  removed: number;
  trimmed: number;
  bytesFreed: number;
  errors: string[];
}

export interface DeletingOrphanReclaimResult extends ReaperReclaimResult {
  remoteResults: Array<{
    targetKey: string;
    ok: boolean;
    detail?: string;
  }>;
}

function emptyResult(): ReaperReclaimResult {
  return { removed: 0, trimmed: 0, bytesFreed: 0, errors: [] };
}

function removePath(path: string, result: ReaperReclaimResult): void {
  let before = 0;
  try {
    before = lstatSync(path).size;
    rmSync(path, { recursive: true, force: true });
    result.removed += 1;
    result.bytesFreed += before;
  } catch (err) {
    result.errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function isOlderThan(path: string, cutoffMs: number, errors: string[]): boolean {
  try {
    return lstatSync(path).mtimeMs <= cutoffMs;
  } catch (err) {
    errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function readImmediateChildren(dir: string, errors: string[]): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir);
  } catch (err) {
    errors.push(`readdir ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

export function reclaimLocalDeletingOrphans(opts: {
  invokerHome?: string;
  userHome?: string;
  nowMs?: number;
  minAgeMs?: number;
} = {}): ReaperReclaimResult {
  const result = emptyResult();
  const userHome = opts.userHome;
  const home = expandTildeHome(opts.invokerHome ?? resolveInvokerHomeRoot(), userHome);
  if (!isSafeInvokerHome(home, userHome)) {
    result.errors.push(`refusing unsafe invoker home: ${home}`);
    return result;
  }

  const cutoffMs = (opts.nowMs ?? Date.now()) - (opts.minAgeMs ?? DELETING_ORPHAN_MIN_AGE_MS);
  for (const name of readImmediateChildren(home, result.errors)) {
    if (!isDeletingOrphanName(name)) continue;
    const path = join(home, name);
    if (!isOlderThan(path, cutoffMs, result.errors)) continue;
    removePath(path, result);
  }
  return result;
}

export function buildDeletingOrphanReclaimScript(invokerHome: string): string {
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
find "$INVOKER_HOME" -mindepth 1 -maxdepth 1 -name '*.deleting.*' -mmin +30 -exec rm -rf -- {} + 2>/dev/null
exit 0
`;
}

function defaultRunRemoteReaperScript(target: RemoteDiskTarget, script: string): Promise<string> {
  const sshArgs = buildSshConnectionArgs(target.connection, { batchMode: true });
  return execRemoteCapture({
    sshArgs,
    script,
    phase: `reaper-reclaim:${target.name}`,
  });
}

export async function reclaimDeletingOrphans(opts: {
  invokerHome?: string;
  userHome?: string;
  remoteTargets?: RemoteDiskTarget[];
  nowMs?: number;
  minAgeMs?: number;
  logger?: Logger;
  runRemoteScript?: (target: RemoteDiskTarget, script: string) => Promise<string>;
} = {}): Promise<DeletingOrphanReclaimResult> {
  const local = reclaimLocalDeletingOrphans({
    invokerHome: opts.invokerHome,
    userHome: opts.userHome,
    nowMs: opts.nowMs,
    minAgeMs: opts.minAgeMs,
  });
  const result: DeletingOrphanReclaimResult = { ...local, remoteResults: [] };
  const run = opts.runRemoteScript ?? defaultRunRemoteReaperScript;

  for (const target of opts.remoteTargets ?? []) {
    const targetKey = `ssh:${target.name} ${target.remotePath}`;
    if (!isSafeRemoteInvokerHomePath(target.remotePath)) {
      const detail = `refusing unsafe remote invoker home: ${target.remotePath}`;
      result.errors.push(detail);
      result.remoteResults.push({ targetKey, ok: false, detail });
      continue;
    }

    try {
      const output = await run(target, buildDeletingOrphanReclaimScript(target.remotePath));
      result.remoteResults.push({ targetKey, ok: true, detail: output.slice(-400) });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      opts.logger?.warn?.(`[reaper-reclaim] remote deleting-orphan sweep failed ${targetKey}: ${detail}`, {
        module: 'reaper-reclaim',
        targetKey,
      });
      result.errors.push(`${targetKey}: ${detail}`);
      result.remoteResults.push({ targetKey, ok: false, detail });
    }
  }

  return result;
}

export function reclaimAutomationCheckoutWork(opts: {
  invokerHome?: string;
  userHome?: string;
  nowMs?: number;
  minAgeMs?: number;
} = {}): ReaperReclaimResult {
  const result = emptyResult();
  const userHome = opts.userHome;
  const home = expandTildeHome(opts.invokerHome ?? resolveInvokerHomeRoot(), userHome);
  if (!isSafeInvokerHome(home, userHome)) {
    result.errors.push(`refusing unsafe invoker home: ${home}`);
    return result;
  }

  const cutoffMs = (opts.nowMs ?? Date.now()) - (opts.minAgeMs ?? AUTOMATION_WORK_MIN_AGE_MS);
  for (const dirName of AUTOMATION_CHECKOUT_WORK_DIRS) {
    const parent = join(home, dirName);
    for (const name of readImmediateChildren(parent, result.errors)) {
      const child = join(parent, name);
      if (!isOlderThan(child, cutoffMs, result.errors)) continue;
      removePath(child, result);
    }
  }
  return result;
}

export function reclaimHourlySnapshotBacklog(opts: {
  invokerHome?: string;
  backupDir?: string;
} = {}): ReaperReclaimResult {
  const result = emptyResult();
  const backupDir = opts.backupDir ?? join(opts.invokerHome ?? resolveInvokerHomeRoot(), 'db-backups');
  result.removed = pruneHourlySnapshots(backupDir, hourlySnapshotRetention());
  return result;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

export function resolveKnownInvokerLogPaths(invokerHome: string): string[] {
  const paths = new Set<string>();
  for (const name of KNOWN_INVOKER_LOG_FILES) {
    paths.add(join(invokerHome, name));
  }
  const matchers = KNOWN_INVOKER_LOG_GLOBS.map(globToRegExp);
  for (const name of readImmediateChildren(invokerHome, [])) {
    if (matchers.some((matcher) => matcher.test(name))) {
      paths.add(join(invokerHome, name));
    }
  }
  return [...paths];
}

function trimFileTail(path: string, retainBytes: number): number {
  const before = statSync(path).size;
  const keep = Math.min(before, retainBytes);
  const buffer = Buffer.allocUnsafe(keep);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buffer, 0, keep, before - keep);
  } finally {
    closeSync(fd);
  }
  writeFileSync(path, buffer);
  return before - keep;
}

export function trimKnownInvokerLogs(opts: {
  invokerHome?: string;
  maxBytes?: number;
  retainBytes?: number;
} = {}): ReaperReclaimResult {
  const result = emptyResult();
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const maxBytes = opts.maxBytes ?? LOG_TRIM_THRESHOLD_BYTES;
  const retainBytes = opts.retainBytes ?? LOG_RETAIN_BYTES;
  if (retainBytes <= 0 || maxBytes < 0) return result;

  for (const path of resolveKnownInvokerLogPaths(invokerHome)) {
    if (!existsSync(path)) continue;
    try {
      const stats = statSync(path);
      if (!stats.isFile() || stats.size <= maxBytes) continue;
      result.bytesFreed += trimFileTail(path, retainBytes);
      result.trimmed += 1;
    } catch (err) {
      result.errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}
