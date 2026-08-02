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

import type { Logger } from '@invoker/contracts';

import { buildSshConnectionArgs } from '../ssh-transport-options.js';
import { bashNormalizeTildePath, execRemoteCapture, shellPosixSingleQuote } from '../ssh-git-exec.js';
import { resolveInvokerHomeRoot } from '../worker-lock.js';

import type { RemoteDiskTarget } from './disk-headroom-monitor.js';
import {
  expandTildeHome,
  isDeletingOrphanName,
  isSafeInvokerHome,
  isSafeRemoteInvokerHomePath,
} from './disk-headroom-reclaim.js';

export const DELETING_ORPHAN_MIN_AGE_MS = 30 * 60 * 1000;
export const AUTOMATION_CHECKOUT_MIN_AGE_MS = 48 * 60 * 60 * 1000;
export const LOG_TRIM_THRESHOLD_BYTES = 100 * 1024 * 1024;
export const LOG_TRIM_KEEP_BYTES = 20 * 1024 * 1024;

export const AUTOMATION_CHECKOUT_DIRS = [
  'mergify-admin-requeue-work',
  'land-admin-bypass-work',
] as const;

export const INVOKER_HOME_LOG_FILES = [
  'invoker.log',
  'gui.log',
  'merge-trace.log',
] as const;

export const INVOKER_HOME_LOG_GLOBS = [
  'ui-*-events.jsonl',
  '*.keepalive.log',
] as const;

export interface ReaperReclaimResult {
  targetKey: string;
  ok: boolean;
  reason: string;
  removed?: number;
  trimmed?: number;
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

export interface ReclaimAutomationCheckoutWorkOptions {
  invokerHome?: string;
  userHome?: string;
  nowMs?: number;
  minAgeMs?: number;
}

export interface PruneHourlySnapshotRetentionOptions {
  invokerHomeRoot?: string;
  loadSnapshotRetentionModule?: () => Promise<SnapshotRetentionModule> | SnapshotRetentionModule;
}

export interface TrimInvokerHomeLogsOptions {
  invokerHome?: string;
  userHome?: string;
  thresholdBytes?: number;
  keepBytes?: number;
}

interface SnapshotRetentionModule {
  hourlySnapshotRetention: () => number;
  pruneHourlySnapshots: (backupDir: string, retain: number) => number;
}

function safeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isOlderThan(statMs: number, nowMs: number, minAgeMs: number): boolean {
  return nowMs - statMs >= minAgeMs;
}

function removePath(path: string, errors: string[]): boolean {
  try {
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch (err) {
    errors.push(`${path}: ${safeError(err)}`);
    return false;
  }
}

function resolveSafeLocalHome(
  invokerHome: string,
  userHome: string,
): { ok: true; home: string } | { ok: false; home: string } {
  const home = expandTildeHome(invokerHome, userHome);
  if (!isSafeInvokerHome(home, userHome)) return { ok: false, home };
  return { ok: true, home };
}

function removeImmediateChildrenOlderThan(opts: {
  parent: string;
  nowMs: number;
  minAgeMs: number;
  shouldRemove: (name: string) => boolean;
  errors: string[];
}): number {
  if (!existsSync(opts.parent)) return 0;
  let entries: string[];
  try {
    entries = readdirSync(opts.parent);
  } catch (err) {
    opts.errors.push(`readdir ${opts.parent}: ${safeError(err)}`);
    return 0;
  }

  let removed = 0;
  for (const name of entries) {
    if (!opts.shouldRemove(name)) continue;
    const path = join(opts.parent, name);
    let stat;
    try {
      stat = lstatSync(path);
    } catch (err) {
      opts.errors.push(`stat ${path}: ${safeError(err)}`);
      continue;
    }
    if (!isOlderThan(stat.mtimeMs, opts.nowMs, opts.minAgeMs)) continue;
    if (removePath(path, opts.errors)) removed += 1;
  }
  return removed;
}

function reclaimLocalDeletingOrphans(opts: {
  invokerHome: string;
  targetKey: string;
  userHome: string;
  nowMs: number;
  minAgeMs: number;
}): ReaperReclaimResult {
  const resolved = resolveSafeLocalHome(opts.invokerHome, opts.userHome);
  if (!resolved.ok) {
    return { targetKey: opts.targetKey, ok: false, reason: 'path-guard', detail: resolved.home };
  }

  const errors: string[] = [];
  const removed = removeImmediateChildrenOlderThan({
    parent: resolved.home,
    nowMs: opts.nowMs,
    minAgeMs: opts.minAgeMs,
    shouldRemove: isDeletingOrphanName,
    errors,
  });
  if (errors.length > 0) {
    return {
      targetKey: opts.targetKey,
      ok: false,
      reason: 'cleanup-error',
      removed,
      detail: errors.slice(0, 5).join('; '),
    };
  }
  return { targetKey: opts.targetKey, ok: true, reason: 'deleting-orphans', removed };
}

export function buildDeletingOrphanReclaimScript(
  invokerHome: string,
  minAgeMinutes: number = 30,
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
errors=0
while IFS= read -r -d '' entry; do
  base="\${entry##*/}"
  case "$base" in
    *'.deleting.'*)
      if rm -rf "$entry" >/dev/null 2>&1; then
        removed=$((removed + 1))
      else
        errors=$((errors + 1))
      fi
      ;;
  esac
done < <(find "$INVOKER_HOME" -mindepth 1 -maxdepth 1 -mmin +${minAgeMinutes} -print0 2>/dev/null)
echo "[reaper-reclaim] deleting-orphans removed=$removed errors=$errors"
[ "$errors" -eq 0 ]
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

async function reclaimRemoteDeletingOrphans(opts: {
  target: RemoteDiskTarget;
  minAgeMs: number;
  runRemoteScript: (target: RemoteDiskTarget, script: string) => Promise<string>;
  logger?: Logger;
}): Promise<ReaperReclaimResult> {
  const targetKey = `ssh:${opts.target.name} ${opts.target.remotePath}`;
  if (!isSafeRemoteInvokerHomePath(opts.target.remotePath)) {
    return { targetKey, ok: false, reason: 'path-guard', detail: opts.target.remotePath };
  }

  const minAgeMinutes = Math.max(0, Math.floor(opts.minAgeMs / 60_000));
  const script = buildDeletingOrphanReclaimScript(opts.target.remotePath, minAgeMinutes);
  try {
    const output = await opts.runRemoteScript(opts.target, script);
    opts.logger?.debug?.(`[reaper-reclaim] remote deleting-orphans done ${targetKey}`, {
      module: 'reaper-reclaim',
      targetKey,
      outputTail: output.slice(-400),
    });
    return { targetKey, ok: true, reason: 'deleting-orphans', detail: output.slice(-400) };
  } catch (err) {
    const detail = safeError(err);
    opts.logger?.warn?.(`[reaper-reclaim] remote deleting-orphans failed ${targetKey}: ${detail}`, {
      module: 'reaper-reclaim',
      targetKey,
    });
    return { targetKey, ok: false, reason: 'cleanup-error', detail };
  }
}

export async function reclaimDeletingOrphans(
  opts: ReclaimDeletingOrphansOptions = {},
): Promise<ReaperReclaimResult[]> {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const remoteTargets = opts.remoteTargets ?? [];
  const nowMs = opts.nowMs ?? Date.now();
  const minAgeMs = opts.minAgeMs ?? DELETING_ORPHAN_MIN_AGE_MS;
  const userHome = opts.userHome ?? homedir();
  const runRemoteScript = opts.runRemoteScript ?? defaultRunRemoteDeletingOrphans;

  const results: ReaperReclaimResult[] = [
    reclaimLocalDeletingOrphans({
      invokerHome,
      targetKey: `local ${invokerHome}`,
      userHome,
      nowMs,
      minAgeMs,
    }),
  ];

  const remotes = await Promise.all(
    remoteTargets.map((target) =>
      reclaimRemoteDeletingOrphans({
        target,
        minAgeMs,
        runRemoteScript,
        logger: opts.logger,
      })),
  );
  results.push(...remotes);
  return results;
}

export function reclaimAutomationCheckoutWork(
  opts: ReclaimAutomationCheckoutWorkOptions = {},
): ReaperReclaimResult {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const userHome = opts.userHome ?? homedir();
  const resolved = resolveSafeLocalHome(invokerHome, userHome);
  const targetKey = `local ${invokerHome}`;
  if (!resolved.ok) {
    return { targetKey, ok: false, reason: 'path-guard', detail: resolved.home };
  }

  const errors: string[] = [];
  let removed = 0;
  for (const name of AUTOMATION_CHECKOUT_DIRS) {
    removed += removeImmediateChildrenOlderThan({
      parent: join(resolved.home, name),
      nowMs: opts.nowMs ?? Date.now(),
      minAgeMs: opts.minAgeMs ?? AUTOMATION_CHECKOUT_MIN_AGE_MS,
      shouldRemove: () => true,
      errors,
    });
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
  return { targetKey, ok: true, reason: 'automation-checkout-work', removed };
}

async function loadDeleteAllSnapshotModule(): Promise<SnapshotRetentionModule> {
  const modulePath = '../../../app/src/delete-all-snapshot.js';
  return import(modulePath) as Promise<SnapshotRetentionModule>;
}

export async function pruneHourlySnapshotRetention(
  opts: PruneHourlySnapshotRetentionOptions = {},
): Promise<ReaperReclaimResult> {
  const invokerHomeRoot = opts.invokerHomeRoot ?? resolveInvokerHomeRoot();
  const backupDir = join(invokerHomeRoot, 'db-backups');
  const snapshotRetention = await (opts.loadSnapshotRetentionModule ?? loadDeleteAllSnapshotModule)();
  const retain = snapshotRetention.hourlySnapshotRetention();
  const removed = snapshotRetention.pruneHourlySnapshots(backupDir, retain);
  return {
    targetKey: backupDir,
    ok: true,
    reason: 'hourly-snapshot-retention',
    removed,
  };
}

function escapeRegexChar(char: string): string {
  return /[\\^$+?.()|{}[\]]/.test(char) ? `\\${char}` : char;
}

function globMatches(name: string, glob: string): boolean {
  let source = '^';
  for (const char of glob) {
    if (char === '*') source += '.*';
    else if (char === '?') source += '.';
    else source += escapeRegexChar(char);
  }
  source += '$';
  return new RegExp(source).test(name);
}

function isInvokerHomeLogName(name: string): boolean {
  if ((INVOKER_HOME_LOG_FILES as readonly string[]).includes(name)) return true;
  return INVOKER_HOME_LOG_GLOBS.some((glob) => globMatches(name, glob));
}

function knownLogPaths(invokerHome: string): string[] {
  if (!existsSync(invokerHome)) return [];
  let entries: string[];
  try {
    entries = readdirSync(invokerHome);
  } catch {
    return [];
  }
  return entries.filter(isInvokerHomeLogName).map((name) => join(invokerHome, name));
}

function writeAllSync(fd: number, buffer: Buffer): void {
  let written = 0;
  while (written < buffer.length) {
    written += writeSync(fd, buffer, written, buffer.length - written, written);
  }
}

function trimFileToTail(path: string, keepBytes: number): boolean {
  const fd = openSync(path, 'r+');
  try {
    const stat = fstatSync(fd);
    const bytesToKeep = Math.min(stat.size, keepBytes);
    const tail = Buffer.alloc(bytesToKeep);
    readSync(fd, tail, 0, bytesToKeep, stat.size - bytesToKeep);
    writeAllSync(fd, tail);
    ftruncateSync(fd, bytesToKeep);
    return true;
  } finally {
    closeSync(fd);
  }
}

export function trimInvokerHomeLogs(opts: TrimInvokerHomeLogsOptions = {}): ReaperReclaimResult {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const userHome = opts.userHome ?? homedir();
  const resolved = resolveSafeLocalHome(invokerHome, userHome);
  const targetKey = `local ${invokerHome}`;
  if (!resolved.ok) {
    return { targetKey, ok: false, reason: 'path-guard', detail: resolved.home };
  }

  const thresholdBytes = opts.thresholdBytes ?? LOG_TRIM_THRESHOLD_BYTES;
  const keepBytes = opts.keepBytes ?? LOG_TRIM_KEEP_BYTES;
  const errors: string[] = [];
  let trimmed = 0;

  for (const path of knownLogPaths(resolved.home)) {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size <= thresholdBytes) continue;
      if (trimFileToTail(path, keepBytes)) trimmed += 1;
    } catch (err) {
      errors.push(`${path}: ${safeError(err)}`);
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
  return { targetKey, ok: true, reason: 'invoker-home-logs', trimmed };
}
