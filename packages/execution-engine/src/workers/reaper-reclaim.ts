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
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

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
export const AUTOMATION_CHECKOUT_MIN_AGE_MS = 48 * 60 * 60 * 1000;
export const LOG_TRIM_TRIGGER_BYTES = 100 * 1024 * 1024;
export const LOG_TRIM_KEEP_BYTES = 20 * 1024 * 1024;

export const AUTOMATION_CHECKOUT_DIRS = [
  'mergify-admin-requeue-work',
  'land-admin-bypass-work',
] as const;

export const INVOKER_LOG_FILE_NAMES = [
  'invoker.log',
  'gui.log',
] as const;

export const INVOKER_LOG_FILE_GLOBS = [
  '*-trace.log',
] as const;

export interface LocalReaperResult {
  targetKey: string;
  ok: boolean;
  reason: string;
  removed: number;
  kept: number;
  detail?: string;
}

export interface RemoteReaperResult {
  targetKey: string;
  ok: boolean;
  reason: string;
  detail?: string;
}

export interface DeletingOrphanReclaimResult {
  local: LocalReaperResult;
  remotes: RemoteReaperResult[];
}

export interface AutomationCheckoutReclaimResult {
  removed: number;
  kept: number;
  errors: string[];
}

export interface LogTrimResult {
  trimmed: number;
  kept: number;
  errors: string[];
}

type ChildSweepPredicate = (name: string) => boolean;

function childAgeMs(path: string, nowMs: number): number | null {
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

function sweepImmediateChildren(options: {
  root: string;
  targetKey: string;
  minAgeMs: number;
  nowMs: number;
  predicate: ChildSweepPredicate;
}): LocalReaperResult {
  if (!existsSync(options.root)) {
    return {
      targetKey: options.targetKey,
      ok: true,
      reason: 'missing-root',
      removed: 0,
      kept: 0,
    };
  }

  let names: string[];
  try {
    names = readdirSync(options.root);
  } catch (err) {
    return {
      targetKey: options.targetKey,
      ok: false,
      reason: 'readdir-error',
      removed: 0,
      kept: 0,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const errors: string[] = [];
  let removed = 0;
  let kept = 0;

  for (const name of names) {
    if (!options.predicate(name)) {
      kept += 1;
      continue;
    }
    const path = join(options.root, name);
    const ageMs = childAgeMs(path, options.nowMs);
    if (ageMs === null || ageMs <= options.minAgeMs) {
      kept += 1;
      continue;
    }
    if (removePath(path, errors)) removed += 1;
  }

  return {
    targetKey: options.targetKey,
    ok: errors.length === 0,
    reason: errors.length === 0 ? 'sweep' : 'cleanup-error',
    removed,
    kept,
    detail: errors.length > 0 ? errors.slice(0, 5).join('; ') : undefined,
  };
}

function buildDeletingOrphanReclaimScript(invokerHome: string): string {
  const homeQ = shellPosixSingleQuote(invokerHome);
  const minAgeMinutes = Math.ceil(DELETING_ORPHAN_MIN_AGE_MS / 60_000);
  return `set -euo pipefail
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
  rm -rf -- "$entry"
  removed=$((removed + 1))
done < <(find "$INVOKER_HOME" -mindepth 1 -maxdepth 1 -name '*.deleting.*' -mmin +${minAgeMinutes} -print0 2>/dev/null)
echo "__INVOKER_REAPER_REMOVED__=$removed"
`;
}

function defaultRunRemoteDeletingOrphans(target: RemoteDiskTarget, script: string): Promise<string> {
  const sshArgs = buildSshConnectionArgs(target.connection, { batchMode: true });
  return execRemoteCapture({
    sshArgs,
    script,
    phase: `reaper-deleting-orphans:${target.name}`,
  });
}

async function reclaimRemoteDeletingOrphans(opts: {
  target: RemoteDiskTarget;
  logger?: Logger;
  runRemoteScript?: (target: RemoteDiskTarget, script: string) => Promise<string>;
}): Promise<RemoteReaperResult> {
  const targetKey = `ssh:${opts.target.name} ${opts.target.remotePath}`;
  if (!isSafeRemoteInvokerHomePath(opts.target.remotePath)) {
    return {
      targetKey,
      ok: false,
      reason: 'path-guard',
      detail: opts.target.remotePath,
    };
  }

  const script = buildDeletingOrphanReclaimScript(opts.target.remotePath);
  const run = opts.runRemoteScript ?? defaultRunRemoteDeletingOrphans;
  try {
    const output = await run(opts.target, script);
    opts.logger?.debug?.('[reaper-reclaim] remote deleting orphan sweep complete', {
      module: MODULE,
      targetKey,
      outputTail: output.slice(-400),
    });
    return {
      targetKey,
      ok: true,
      reason: 'sweep',
      detail: output.slice(-400),
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    opts.logger?.warn?.(`[reaper-reclaim] remote deleting orphan sweep failed ${targetKey}: ${detail}`, {
      module: MODULE,
      targetKey,
    });
    return { targetKey, ok: false, reason: 'cleanup-error', detail };
  }
}

export async function reclaimDeletingOrphans(opts: {
  invokerHome?: string;
  userHome?: string;
  remoteTargets?: RemoteDiskTarget[];
  nowMs?: number;
  logger?: Logger;
  runRemoteScript?: (target: RemoteDiskTarget, script: string) => Promise<string>;
} = {}): Promise<DeletingOrphanReclaimResult> {
  const userHome = opts.userHome ?? homedir();
  const home = expandTildeHome(opts.invokerHome ?? resolveInvokerHomeRoot(), userHome);
  const nowMs = opts.nowMs ?? Date.now();
  const targetKey = `local ${home}`;

  const local = isSafeInvokerHome(home, userHome)
    ? sweepImmediateChildren({
      root: home,
      targetKey,
      minAgeMs: DELETING_ORPHAN_MIN_AGE_MS,
      nowMs,
      predicate: isDeletingOrphanName,
    })
    : {
      targetKey,
      ok: false,
      reason: 'path-guard',
      removed: 0,
      kept: 0,
      detail: home,
    };

  const remotes = await Promise.all(
    (opts.remoteTargets ?? []).map((target) => reclaimRemoteDeletingOrphans({
      target,
      logger: opts.logger,
      runRemoteScript: opts.runRemoteScript,
    })),
  );

  return { local, remotes };
}

export function reclaimAutomationCheckoutWork(opts: {
  invokerHome?: string;
  userHome?: string;
  nowMs?: number;
} = {}): AutomationCheckoutReclaimResult {
  const userHome = opts.userHome ?? homedir();
  const home = expandTildeHome(opts.invokerHome ?? resolveInvokerHomeRoot(), userHome);
  if (!isSafeInvokerHome(home, userHome)) {
    return { removed: 0, kept: 0, errors: [`unsafe invoker home: ${home}`] };
  }

  const nowMs = opts.nowMs ?? Date.now();
  const errors: string[] = [];
  let removed = 0;
  let kept = 0;

  for (const name of AUTOMATION_CHECKOUT_DIRS) {
    const result = sweepImmediateChildren({
      root: join(home, name),
      targetKey: `local ${join(home, name)}`,
      minAgeMs: AUTOMATION_CHECKOUT_MIN_AGE_MS,
      nowMs,
      predicate: () => true,
    });
    removed += result.removed;
    kept += result.kept;
    if (!result.ok && result.detail) errors.push(result.detail);
  }

  return { removed, kept, errors };
}

export function pruneHourlySnapshotsForInvokerHome(opts: {
  invokerHome?: string;
} = {}): number {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const backupDir = join(invokerHome, 'db-backups');
  return pruneHourlySnapshots(backupDir, hourlySnapshotRetention());
}

function matchesSimpleGlob(name: string, glob: string): boolean {
  const escaped = glob
    .split('*')
    .map((part) => part.replace(/[\\^$+?.()|[\]{}]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`).test(name);
}

function invokerLogPaths(invokerHome: string): string[] {
  const paths = new Set(INVOKER_LOG_FILE_NAMES.map((name) => join(invokerHome, name)));
  let names: string[];
  try {
    names = readdirSync(invokerHome);
  } catch {
    return [...paths];
  }
  for (const name of names) {
    if (INVOKER_LOG_FILE_GLOBS.some((glob) => matchesSimpleGlob(name, glob))) {
      paths.add(join(invokerHome, name));
    }
  }
  return [...paths];
}

function trimFileToTail(path: string, keepBytes: number): void {
  const stat = statSync(path);
  const bytesToRead = Math.min(keepBytes, stat.size);
  const offset = Math.max(0, stat.size - bytesToRead);
  const buffer = Buffer.alloc(bytesToRead);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buffer, 0, bytesToRead, offset);
  } finally {
    closeSync(fd);
  }
  writeFileSync(path, buffer);
}

export function trimInvokerHomeLogs(opts: {
  invokerHome?: string;
  triggerBytes?: number;
  keepBytes?: number;
} = {}): LogTrimResult {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const triggerBytes = opts.triggerBytes ?? LOG_TRIM_TRIGGER_BYTES;
  const keepBytes = opts.keepBytes ?? LOG_TRIM_KEEP_BYTES;
  const errors: string[] = [];
  let trimmed = 0;
  let kept = 0;

  for (const path of invokerLogPaths(invokerHome)) {
    try {
      if (basename(path).includes('/') || !existsSync(path)) continue;
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      if (stat.size <= triggerBytes) {
        kept += 1;
        continue;
      }
      trimFileToTail(path, keepBytes);
      trimmed += 1;
    } catch (err) {
      errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { trimmed, kept, errors };
}
