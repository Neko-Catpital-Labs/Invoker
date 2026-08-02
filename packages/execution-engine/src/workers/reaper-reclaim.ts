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

import { hourlySnapshotRetention, pruneHourlySnapshots } from '../../../app/src/delete-all-snapshot.js';
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

export const DELETING_ORPHAN_MIN_AGE_MINUTES = 30;
export const AUTOMATION_CHECKOUT_WORK_MIN_AGE_HOURS = 48;
export const LOG_TRIM_MAX_BYTES = 100 * 1024 * 1024;
export const LOG_TRIM_KEEP_BYTES = 20 * 1024 * 1024;

export const AUTOMATION_CHECKOUT_WORK_DIRS = [
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
] as const;

export interface ReaperReclaimResult {
  removed: string[];
  kept: string[];
  errors: string[];
}

export interface ReaperRemoteResult {
  targetKey: string;
  ok: boolean;
  removed?: number;
  detail?: string;
}

export interface DeletingOrphanReclaimResult extends ReaperReclaimResult {
  remote: ReaperRemoteResult[];
}

export interface LogTrimResult {
  trimmed: string[];
  kept: string[];
  errors: string[];
}

export type ReaperRemoteScriptRunner = (
  target: RemoteDiskTarget,
  script: string,
) => Promise<string>;

function emptyReclaimResult(): ReaperReclaimResult {
  return { removed: [], kept: [], errors: [] };
}

function ageMsFromMinutes(minutes: number): number {
  return minutes * 60 * 1000;
}

function ageMsFromHours(hours: number): number {
  return hours * 60 * 60 * 1000;
}

function isOlderThan(path: string, minAgeMs: number, nowMs: number): boolean {
  const stat = lstatSync(path);
  return nowMs - stat.mtimeMs > minAgeMs;
}

function removePath(path: string, result: ReaperReclaimResult): void {
  try {
    rmSync(path, { recursive: true, force: true });
    result.removed.push(path);
  } catch (err) {
    result.errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function guardedLocalHome(
  invokerHome: string | undefined,
  userHome: string | undefined,
  errors: string[],
): string | null {
  const resolvedUserHome = userHome ?? homedir();
  const home = expandTildeHome(invokerHome ?? resolveInvokerHomeRoot(), resolvedUserHome);
  if (!isSafeInvokerHome(home, resolvedUserHome)) {
    errors.push(`Refusing unsafe INVOKER_HOME: ${home}`);
    return null;
  }
  return home;
}

function reapLocalDeletingOrphans(opts: {
  invokerHome?: string;
  userHome?: string;
  nowMs: number;
  minAgeMs: number;
}): ReaperReclaimResult {
  const result = emptyReclaimResult();
  const home = guardedLocalHome(opts.invokerHome, opts.userHome, result.errors);
  if (!home || !existsSync(home)) return result;

  let entries: string[];
  try {
    entries = readdirSync(home);
  } catch (err) {
    result.errors.push(`readdir ${home}: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }

  for (const name of entries) {
    if (!isDeletingOrphanName(name)) continue;
    const path = join(home, name);
    try {
      if (isOlderThan(path, opts.minAgeMs, opts.nowMs)) removePath(path, result);
      else result.kept.push(path);
    } catch (err) {
      result.errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

export function buildDeletingOrphanReclaimScript(
  invokerHome: string,
  minAgeMinutes: number = DELETING_ORPHAN_MIN_AGE_MINUTES,
): string {
  const homeQ = shellPosixSingleQuote(invokerHome);
  const ageMinutes = Math.max(0, Math.floor(minAgeMinutes));
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
  [ -e "$entry" ] || continue
  if rm -rf "$entry" >/dev/null 2>&1; then
    removed=$((removed + 1))
  fi
done < <(find "$INVOKER_HOME" -mindepth 1 -maxdepth 1 -name '*.deleting.*' -mmin +${ageMinutes} -print0 2>/dev/null)
echo "[reaper-reclaim] deleting-orphans removed=$removed home=$INVOKER_HOME"
exit 0
`;
}

function parseRemoteRemovedCount(output: string): number | undefined {
  const match = output.match(/\bremoved=(\d+)\b/);
  if (!match) return undefined;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : undefined;
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

export async function reapDeletingOrphanEntries(opts: {
  invokerHome?: string;
  userHome?: string;
  remoteTargets?: RemoteDiskTarget[];
  minAgeMinutes?: number;
  nowMs?: number;
  logger?: Logger;
  runRemoteScript?: ReaperRemoteScriptRunner;
} = {}): Promise<DeletingOrphanReclaimResult> {
  const minAgeMinutes = opts.minAgeMinutes ?? DELETING_ORPHAN_MIN_AGE_MINUTES;
  const local = reapLocalDeletingOrphans({
    invokerHome: opts.invokerHome,
    userHome: opts.userHome,
    nowMs: opts.nowMs ?? Date.now(),
    minAgeMs: ageMsFromMinutes(minAgeMinutes),
  });
  const runRemoteScript = opts.runRemoteScript ?? defaultRunRemoteDeletingOrphanReclaim;
  const remote = await Promise.all((opts.remoteTargets ?? []).map(async (target) => {
    const targetKey = `ssh:${target.name} ${target.remotePath}`;
    if (!isSafeRemoteInvokerHomePath(target.remotePath)) {
      return {
        targetKey,
        ok: false,
        detail: `Refusing unsafe INVOKER_HOME: ${target.remotePath}`,
      };
    }

    const script = buildDeletingOrphanReclaimScript(target.remotePath, minAgeMinutes);
    try {
      const output = await runRemoteScript(target, script);
      return {
        targetKey,
        ok: true,
        removed: parseRemoteRemovedCount(output),
        detail: output.slice(-400),
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      opts.logger?.warn?.(`[reaper-reclaim] deleting orphan remote failed ${targetKey}: ${detail}`, {
        module: 'reaper-reclaim',
        targetKey,
      });
      return { targetKey, ok: false, detail };
    }
  }));

  return {
    removed: local.removed,
    kept: local.kept,
    errors: local.errors,
    remote,
  };
}

export function reapAutomationCheckoutWorkDirs(opts: {
  invokerHome?: string;
  userHome?: string;
  minAgeHours?: number;
  nowMs?: number;
} = {}): ReaperReclaimResult {
  const result = emptyReclaimResult();
  const home = guardedLocalHome(opts.invokerHome, opts.userHome, result.errors);
  if (!home) return result;

  const minAgeMs = ageMsFromHours(opts.minAgeHours ?? AUTOMATION_CHECKOUT_WORK_MIN_AGE_HOURS);
  const nowMs = opts.nowMs ?? Date.now();

  for (const dirName of AUTOMATION_CHECKOUT_WORK_DIRS) {
    const parent = join(home, dirName);
    if (!existsSync(parent)) continue;

    let children: string[];
    try {
      children = readdirSync(parent);
    } catch (err) {
      result.errors.push(`readdir ${parent}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    for (const child of children) {
      const childPath = join(parent, child);
      try {
        if (isOlderThan(childPath, minAgeMs, nowMs)) removePath(childPath, result);
        else result.kept.push(childPath);
      } catch (err) {
        result.errors.push(`${childPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return result;
}

export function pruneHourlySnapshotsToRetention(opts: {
  invokerHome?: string;
  backupDir?: string;
} = {}): number {
  const invokerHome = opts.invokerHome ?? resolveInvokerHomeRoot();
  const backupDir = opts.backupDir ?? join(invokerHome, 'db-backups');
  return pruneHourlySnapshots(backupDir, hourlySnapshotRetention());
}

function simpleGlobToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

function resolveInvokerLogPaths(
  invokerHome: string,
  fileNames: readonly string[],
  globs: readonly string[],
): string[] {
  const paths = new Set(fileNames.map((name) => join(invokerHome, name)));
  if (globs.length === 0 || !existsSync(invokerHome)) return [...paths];

  const matchers = globs.map(simpleGlobToRegExp);
  for (const entry of readdirSync(invokerHome)) {
    if (matchers.some((matcher) => matcher.test(entry))) {
      paths.add(join(invokerHome, entry));
    }
  }
  return [...paths];
}

function trimFileTailInPlace(path: string, maxBytes: number, keepBytes: number): boolean {
  const fd = openSync(path, 'r+');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= maxBytes) return false;

    const tailLength = Math.min(keepBytes, stat.size);
    const offset = stat.size - tailLength;
    const tail = Buffer.alloc(tailLength);
    let read = 0;
    while (read < tailLength) {
      const n = readSync(fd, tail, read, tailLength - read, offset + read);
      if (n === 0) break;
      read += n;
    }

    ftruncateSync(fd, 0);
    let written = 0;
    while (written < read) {
      written += writeSync(fd, tail, written, read - written, written);
    }
    ftruncateSync(fd, read);
    return true;
  } finally {
    closeSync(fd);
  }
}

export function trimInvokerHomeLogs(opts: {
  invokerHome?: string;
  userHome?: string;
  maxBytes?: number;
  keepBytes?: number;
  fileNames?: readonly string[];
  globs?: readonly string[];
} = {}): LogTrimResult {
  const result: LogTrimResult = { trimmed: [], kept: [], errors: [] };
  const home = guardedLocalHome(opts.invokerHome, opts.userHome, result.errors);
  if (!home) return result;

  const maxBytes = opts.maxBytes ?? LOG_TRIM_MAX_BYTES;
  const keepBytes = opts.keepBytes ?? LOG_TRIM_KEEP_BYTES;
  let paths: string[];
  try {
    paths = resolveInvokerLogPaths(
      home,
      opts.fileNames ?? INVOKER_HOME_LOG_FILES,
      opts.globs ?? INVOKER_HOME_LOG_GLOBS,
    );
  } catch (err) {
    result.errors.push(`readdir ${home}: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }

  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      if (trimFileTailInPlace(path, maxBytes, keepBytes)) result.trimmed.push(path);
      else result.kept.push(path);
    } catch (err) {
      result.errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}
