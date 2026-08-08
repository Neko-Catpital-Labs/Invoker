/**
 * Critical-disk remediation for the disk-headroom worker.
 *
 * Wipes reclaimable Invoker-managed dirs under the Invoker home only.
 * Never touches invoker.db / config.json / the home root / paths outside the home.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { rm as rmAsync } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import type { Logger } from '@invoker/contracts';
import type { TaskState } from '@invoker/workflow-core';

import { computeRepoCacheHash } from '../git-utils.js';
import { buildSshConnectionArgs } from '../ssh-transport-options.js';
import { bashNormalizeTildePath, execRemoteCapture, shellPosixSingleQuote } from '../ssh-git-exec.js';

import type { RemoteDiskTarget } from './disk-headroom-monitor.js';

export const DEFAULT_DISK_CLEANUP_COOLDOWN_MS = 30 * 60 * 1000;

/** Invoker-managed dirs reclaimed on critical disk pressure (local + remote). */
export const DISK_RECLAIMABLE_DIRS = [
  'runtime',
  'repos',
  'worktrees',
  'merge-clones',
  'merge-launches',
  'pr-cron-work',
] as const;

export type DiskReclaimableDir = (typeof DISK_RECLAIMABLE_DIRS)[number];

/**
 * Invoker/test scratch name globs reclaimed from the shared temp dir. The
 * disk-headroom cleaner never wipes `/tmp` wholesale — only entries matching
 * these globs, plus stale mktemp leftovers older than the age threshold below.
 */
export const TMP_SCRATCH_GLOBS = [
  'invoker-*',
  'scoped_dir*',
  'electron-download-*',
  'playwright-artifacts-*',
  'playwright-transform-cache-*',
  'esbuild-*.map',
  'node-compile-cache',
  'runner-test-*',
  'omp-*',
] as const;

export const TMP_TRANSIENT_TEST_GLOBS = [
  'invoker-e2e-db.*',
  'invoker-e2e-home.*',
  'invoker-chaos-*-db.*',
  'invoker-chaos-*-home.*',
] as const;

/** Leave temp entries newer than this alone — an active run may still hold them. */
export const TMP_SCRATCH_MIN_AGE_MINUTES = 60;

export interface DiskCleanupResult {
  targetKey: string;
  ok: boolean;
  reason: string;
  detail?: string;
  protectedSkipCount: number;
  protectedSkipBytes: number;
  protectedSkipBytesTruncated?: boolean;
}

export type LocalDiskCleanupMode = 'critical' | 'stale-only';

export interface CleanupLocalInvokerHomeOptions {
  invokerHome: string;
  targetKey?: string;
  logger?: Logger;
  userHome?: string;
  store?: DiskHeadroomWorkerStore;
  mode?: LocalDiskCleanupMode;
  minAgeMinutes?: number;
}

/**
 * Refuse empty, `/`, and `$HOME` (or literal `~`) so cleanup cannot wipe the
 * whole machine. Relative paths and other absolute homes are allowed.
 */
export function isSafeInvokerHome(
  invokerHome: string,
  userHome: string = homedir(),
): boolean {
  const trimmed = invokerHome.trim();
  if (!trimmed) return false;
  if (trimmed === '/' || trimmed === '~') return false;
  const expanded = expandTildeHome(trimmed, userHome);
  if (!expanded || expanded === '/') return false;
  if (expanded === userHome || expanded === `${userHome}/`) return false;
  return true;
}

export function expandTildeHome(path: string, userHome: string = homedir()): string {
  if (path === '~') return userHome;
  if (path.startsWith('~/')) return join(userHome, path.slice(2));
  return path;
}

/** True unless explicitly disabled with `INVOKER_DISK_CLEANUP_ENABLED=0|false`. */
export function resolveDiskCleanupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.INVOKER_DISK_CLEANUP_ENABLED;
  if (raw === undefined || raw === '') return true;
  return raw !== '0' && raw.toLowerCase() !== 'false';
}

export function resolveDiskCleanupCooldownMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.INVOKER_DISK_CLEANUP_COOLDOWN_MS;
  if (!raw) return DEFAULT_DISK_CLEANUP_COOLDOWN_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_DISK_CLEANUP_COOLDOWN_MS;
  return n;
}

/**
 * Whether a configured remote path is safe to pass into the cleanup script.
 * `~/.invoker` is allowed (expanded on the remote). Bare `~` / `$HOME` / `/` are not.
 */
export function isSafeRemoteInvokerHomePath(remotePath: string): boolean {
  const raw = remotePath.trim();
  if (!raw || raw === '/' || raw === '~' || raw === '$HOME') return false;
  if (raw === '~/') return false;
  return true;
}

export function isDeletingOrphanName(name: string): boolean {
  return name.includes('.deleting.');
}

/** Reclaimable dirs swept one child at a time so `preservePaths` can protect a single in-use child without protecting its siblings. */
const REMOTE_CHILD_SWEPT_DIRS = ['repos', 'worktrees', 'merge-clones', 'merge-launches'] as const;

/**
 * Remote bash that frees Invoker-managed disk under `$INVOKER_HOME`.
 * Kills only provision grinders (pnpm install / electron unzip), not every
 * process whose argv mentions the home (that can kill the SSH session).
 * Deletes synchronously so SSH timeout cannot leave fire-and-forget orphans.
 *
 * `preservePaths` are paths relative to `$INVOKER_HOME` (e.g. `repos/<hash>`,
 * `worktrees/<hash>/<branch>`) for in-flight work on this target's own pool.
 * Each direct child of a REMOTE_CHILD_SWEPT_DIRS entry is checked against
 * this set before deletion; a match is passed over instead of removed.
 */
export function buildInvokerHomeCleanupScript(
  invokerHome: string,
  preservePaths: readonly string[] = [],
): string {
  const homeQ = shellPosixSingleQuote(invokerHome);
  const preserveArrayLiteral = preservePaths.map((p) => shellPosixSingleQuote(p)).join(' ');
  const childSweptRemoveCalls = REMOTE_CHILD_SWEPT_DIRS
    .map((name) => `sweep_children_preserving "$INVOKER_HOME/${name}" "${name}"`)
    .join('\n');
  const wholeDirRemoveCalls = `remove_path "$INVOKER_HOME/runtime"
# pr-cron-work: PR #6632 retired its only producer, so there is nothing to preserve here.
remove_path "$INVOKER_HOME/pr-cron-work"`;
  const mkdirArgs = DISK_RECLAIMABLE_DIRS
    .map((name) => `"$INVOKER_HOME/${name}"`)
    .join(' ');
  const tmpGlobList = TMP_SCRATCH_GLOBS.join(' ');
  const transientTestGlobList = TMP_TRANSIENT_TEST_GLOBS.join(' ');
  return `set +e
INVOKER_HOME=${homeQ}
${bashNormalizeTildePath('INVOKER_HOME')}
case "$INVOKER_HOME" in
  ""|"/"|"$HOME"|"~")
    echo "Refusing unsafe INVOKER_HOME: $INVOKER_HOME" >&2
    exit 64
    ;;
esac
echo "[disk-headroom-cleanup] begin home=$INVOKER_HOME"
df -h / | tail -1
# Provision grinders only — do not pkill -f INVOKER_HOME (kills this SSH session).
pkill -9 -f 'pnpm install --frozen-lockfile' >/dev/null 2>&1
pkill -9 -f 'pnpm install' >/dev/null 2>&1
pkill -9 -f 'electron-v[0-9].*-linux-x64.zip' >/dev/null 2>&1
pkill -9 -f 'node_modules/.pnpm/electron@' >/dev/null 2>&1
sleep 1
# Prior rename leftovers from interrupted cleanups.
rm -rf "$INVOKER_HOME"/*.deleting.* >/dev/null 2>&1
remove_path() {
  local path="$1"
  if [ -e "$path" ]; then
    local staged="\${path}.deleting.$$"
    if mv "$path" "$staged" 2>/dev/null; then
      rm -rf "$staged" 2>/dev/null || true
    fi
    rm -rf "$path" 2>/dev/null || true
  fi
}
# In-flight work on this target's own pool — checked before a child is removed below.
PRESERVE=(${preserveArrayLiteral})
is_preserved() {
  local rel="$1"
  local p
  for p in "\${PRESERVE[@]}"; do
    case "$p" in
      "$rel") return 0 ;;
      "$rel"/*) return 0 ;;
    esac
  done
  return 1
}
sweep_children_preserving() {
  local dir="$1"
  local prefix="$2"
  [ -d "$dir" ] || return 0
  find "$dir" -mindepth 1 -maxdepth 1 -print0 2>/dev/null | while IFS= read -r -d '' child; do
    local base
    base=$(basename "$child")
    if is_preserved "$prefix/$base"; then
      echo "[disk-headroom-cleanup] preserve $child (in-use)"
      continue
    fi
    remove_path "$child"
  done
}
${childSweptRemoveCalls}
${wholeDirRemoveCalls}
rm -rf "$INVOKER_HOME"/*.deleting.* >/dev/null 2>&1
mkdir -p ${mkdirArgs}
chmod 700 ${mkdirArgs}
# Shared temp dir: reclaim only Invoker/test scratch, never a blanket /tmp wipe.
# Age guard leaves entries newer than ${TMP_SCRATCH_MIN_AGE_MINUTES}m alone (an active run may hold them).
TMP_CLEAN="\${TMPDIR:-/tmp}"
TMP_CLEAN="\${TMP_CLEAN%/}"
case "$TMP_CLEAN" in
  ""|"/"|"$HOME") TMP_CLEAN=/tmp ;;
esac
# Never reap a temp entry that holds mineable .jsonl session data (agent transcripts).
reap_tmp() {
  [ -e "$1" ] || return 0
  if find "$1" -type f -name '*.jsonl' -print -quit 2>/dev/null | grep -q .; then
    return 0
  fi
  rm -rf "$1" >/dev/null 2>&1
}
reap_transient_test_tmp() {
  [ -e "$1" ] || return 0
  rm -rf "$1" >/dev/null 2>&1
}
set -f
for pat in ${transientTestGlobList}; do
  find "$TMP_CLEAN" -mindepth 1 -maxdepth 1 -name "$pat" -mmin +${TMP_SCRATCH_MIN_AGE_MINUTES} \\
    ! -path "$INVOKER_HOME" -print0 2>/dev/null | while IFS= read -r -d '' entry; do
    reap_transient_test_tmp "$entry"
  done
done
for pat in ${tmpGlobList}; do
  find "$TMP_CLEAN" -mindepth 1 -maxdepth 1 -name "$pat" -mmin +${TMP_SCRATCH_MIN_AGE_MINUTES} \\
    ! -path "$INVOKER_HOME" -print0 2>/dev/null | while IFS= read -r -d '' entry; do
    reap_tmp "$entry"
  done
done
set +f
find "$TMP_CLEAN" -mindepth 1 -maxdepth 1 -mmin +${TMP_SCRATCH_MIN_AGE_MINUTES} \\
  ! -path "$INVOKER_HOME" \\
  ! -name 'systemd-private-*' ! -name 'snap-*' ! -name '.*-unix' \\
  ! -name 'ssh-*' ! -name 'claude-*' ! -name '*.lock' \\
  -print0 2>/dev/null | while IFS= read -r -d '' entry; do
  reap_tmp "$entry"
done
echo "[disk-headroom-cleanup] done"
df -h / | tail -1
exit 0
`;
}

const LOCAL_RM_MAX_RETRIES = 5;
const LOCAL_RM_RETRY_DELAY_MS = 100;
const PROTECTED_SKIP_BYTE_WALK_ENTRY_CAP = 10_000;
const execFileAsync = promisify(execFile);

type ProcessWithNoAsar = NodeJS.Process & { noAsar?: boolean };

interface ProtectedSkipAccounting {
  paths: string[];
  count: number;
  bytes: number;
  truncated: boolean;
}

interface ApproximateTreeBytesResult {
  bytes: number;
  truncated: boolean;
}

/**
 * Read-only accessor for Invoker's own workflow/task state, used to derive
 * which local paths are still in active use before the disk-headroom
 * cleaner deletes anything. Mirrors WorkflowResumeWorkerStore's shape.
 */
export interface DiskHeadroomWorkerStore {
  listWorkflows(): ReadonlyArray<{ id: string; repoUrl?: string }>;
  loadTasks(workflowId: string): TaskState[];
}

export const DISK_HEADROOM_TERMINAL_TASK_STATUSES = ['completed', 'closed', 'stale'] as const;

const TERMINAL_TASK_STATUS_SET = new Set<string>(DISK_HEADROOM_TERMINAL_TASK_STATUSES);

/**
 * Resolved workspacePaths for every non-terminal task across all workflows.
 * These are "in use" regardless of whether any OS process currently touches
 * them, so the cleaner must never delete them. Fails safe to an empty set
 * (protects nothing) on any store error -- see cleanupLocalInvokerHome for
 * why that is the safer failure mode for this worker.
 */
export function computeProtectedLocalPaths(store: DiskHeadroomWorkerStore): Set<string> {
  try {
    const protectedPaths = new Set<string>();
    for (const workflow of store.listWorkflows()) {
      for (const task of store.loadTasks(workflow.id)) {
        if (TERMINAL_TASK_STATUS_SET.has(task.status)) continue;
        if (task.execution?.workspacePath) {
          protectedPaths.add(resolve(task.execution.workspacePath));
        }
      }
    }
    return protectedPaths;
  } catch {
    return new Set();
  }
}

/**
 * Repo-cache hashes (`repos/<hash>` dir names) for non-terminal tasks' workflows.
 * A shared git mirror is named by hash, not by workspacePath, so it needs its
 * own liveness check alongside computeProtectedLocalPaths. Fails safe to an
 * empty set (protects nothing) on any store error, same rationale as above.
 */
export function computeProtectedRepoHashes(store: DiskHeadroomWorkerStore): Set<string> {
  try {
    const protectedHashes = new Set<string>();
    for (const workflow of store.listWorkflows()) {
      if (!workflow.repoUrl) continue;
      const tasks = store.loadTasks(workflow.id);
      const hasNonTerminalTask = tasks.some((task) => !TERMINAL_TASK_STATUS_SET.has(task.status));
      if (hasNonTerminalTask) {
        protectedHashes.add(computeRepoCacheHash(workflow.repoUrl));
      }
    }
    return protectedHashes;
  } catch {
    return new Set();
  }
}

function pathIsProtected(candidate: string, protectedPaths: ReadonlySet<string>): boolean {
  if (protectedPaths.size === 0) return false;
  const resolved = resolve(candidate);
  for (const protectedPath of protectedPaths) {
    if (resolved === protectedPath) return true;
    if (resolved.startsWith(`${protectedPath}${sep}`)) return true;
    if (protectedPath.startsWith(`${resolved}${sep}`)) return true;
  }
  return false;
}

/**
 * Renames `path` aside before erasing the renamed copy, mirroring
 * remove_path() in buildInvokerHomeCleanupScript above. A partial failure
 * mid-erase then leaves a `.deleting.<random>` orphan (swept up by
 * sweepLocalDeletingOrphans next pass) instead of a half-gone directory
 * still sitting under the name other code looks up. Erases out of process
 * (`rm -rf` via execFile) so a large tree does not block the event loop;
 * falls back to the async fs.rm if the rename or the subprocess fails.
 */
async function eraseLocalPath(path: string, errors: string[]): Promise<void> {
  const removeWithNode = async (deletePath: string) => {
    await rmAsync(deletePath, {
      recursive: true,
      force: true,
      maxRetries: LOCAL_RM_MAX_RETRIES,
      retryDelay: LOCAL_RM_RETRY_DELAY_MS,
    });
  };

  let deletePath = `${path}.deleting.${randomUUID().slice(0, 8)}`;
  try {
    renameSync(path, deletePath);
  } catch {
    deletePath = path;
    try {
      await removeWithNode(deletePath);
    } catch (fallbackErr) {
      errors.push(`${path}: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`);
    }
    return;
  }

  try {
    await execFileAsync('rm', ['-rf', deletePath]);
  } catch {
    try {
      await removeWithNode(deletePath);
    } catch (fallbackErr) {
      errors.push(`${path}: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`);
    }
  }
}

function approximateTreeBytes(path: string, capEntries: number): ApproximateTreeBytesResult {
  const stack = [path];
  let visited = 0;
  let bytes = 0;
  let truncated = false;

  while (stack.length > 0) {
    if (visited >= capEntries) {
      truncated = true;
      break;
    }

    const current = stack.pop()!;
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      truncated = true;
      continue;
    }
    visited += 1;
    bytes += stat.size;

    if (!stat.isDirectory()) continue;
    let children: string[];
    try {
      children = readdirSync(current);
    } catch {
      truncated = true;
      continue;
    }
    for (const child of children) {
      stack.push(join(current, child));
    }
  }

  return { bytes, truncated };
}

async function removeLocalDir(
  path: string,
  errors: string[],
  protectedSkips: ProtectedSkipAccounting,
  protectedPaths: ReadonlySet<string>,
  logger?: Logger,
  targetKey?: string,
): Promise<void> {
  if (!existsSync(path)) return;
  if (pathIsProtected(path, protectedPaths)) {
    const approximateBytes = approximateTreeBytes(path, PROTECTED_SKIP_BYTE_WALK_ENTRY_CAP);
    protectedSkips.paths.push(path);
    protectedSkips.count += 1;
    protectedSkips.bytes += approximateBytes.bytes;
    protectedSkips.truncated ||= approximateBytes.truncated;
    logger?.warn?.(`[disk-headroom-cleanup] skip ${path}: protected-path-in-use`, {
      module: 'disk-headroom',
      targetKey,
      path,
      protectedSkipBytes: approximateBytes.bytes,
      protectedSkipBytesTruncated: approximateBytes.truncated,
    });
    return;
  }
  await eraseLocalPath(path, errors);
}

function ensureLocalDir(path: string, errors: string[]): void {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  } catch (err) {
    errors.push(`mkdir ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function logLocalCleanupDone(opts: {
  logger?: Logger;
  mode: LocalDiskCleanupMode;
  home: string;
  targetKey: string;
  ok: boolean;
  reason: string;
  protectedSkips: ProtectedSkipAccounting;
}): void {
  const stalePrefix = opts.mode === 'stale-only' ? 'stale-only ' : '';
  const truncated = opts.protectedSkips.truncated
    ? ' protectedSkipBytesTruncated=true'
    : '';
  opts.logger?.info?.(
    `[disk-headroom-cleanup] local ${stalePrefix}done home=${opts.home} ok=${opts.ok ? 'true' : 'false'} reason=${opts.reason} protectedSkipCount=${opts.protectedSkips.count} protectedSkipBytes=${opts.protectedSkips.bytes}${truncated}`,
    {
      module: 'disk-headroom',
      targetKey: opts.targetKey,
      protectedSkipCount: opts.protectedSkips.count,
      protectedSkipBytes: opts.protectedSkips.bytes,
      protectedSkipBytesTruncated: opts.protectedSkips.truncated,
    },
  );
}

async function sweepLocalDeletingOrphans(
  home: string,
  errors: string[],
  protectedSkips: ProtectedSkipAccounting,
  protectedPaths: ReadonlySet<string>,
  logger?: Logger,
  targetKey?: string,
): Promise<void> {
  if (!existsSync(home)) return;
  let entries: string[];
  try {
    entries = readdirSync(home);
  } catch (err) {
    errors.push(`readdir ${home}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  for (const name of entries) {
    if (!isDeletingOrphanName(name)) continue;
    await removeLocalDir(join(home, name), errors, protectedSkips, protectedPaths, logger, targetKey);
  }
}

/**
 * Sweeps a reclaimable top-level dir (e.g. `worktrees`) one child at a time
 * so a single in-use subdirectory only protects itself, not its siblings.
 */
async function sweepReclaimableChildren(
  dirPath: string,
  errors: string[],
  protectedSkips: ProtectedSkipAccounting,
  protectedPaths: ReadonlySet<string>,
  logger?: Logger,
  targetKey?: string,
): Promise<void> {
  if (!existsSync(dirPath)) return;
  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch (err) {
    errors.push(`readdir ${dirPath}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  for (const name of entries) {
    await removeLocalDir(join(dirPath, name), errors, protectedSkips, protectedPaths, logger, targetKey);
  }
}

/**
 * Sweeps `repos/` one shared git mirror at a time. Mirrors are named by
 * repo-cache hash, not by task workspacePath, so a child is left alone when
 * either its own hash is protected or its resolved path matches/sits above a
 * protected workspacePath.
 */
async function sweepRepoChildren(
  dirPath: string,
  errors: string[],
  protectedSkips: ProtectedSkipAccounting,
  protectedRepoHashes: ReadonlySet<string>,
  protectedPaths: ReadonlySet<string>,
  logger?: Logger,
  targetKey?: string,
): Promise<void> {
  if (!existsSync(dirPath)) return;
  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch (err) {
    errors.push(`readdir ${dirPath}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  for (const name of entries) {
    const childPath = join(dirPath, name);
    if (protectedRepoHashes.has(name) || pathIsProtected(childPath, protectedPaths)) {
      const approximateBytes = approximateTreeBytes(childPath, PROTECTED_SKIP_BYTE_WALK_ENTRY_CAP);
      protectedSkips.paths.push(childPath);
      protectedSkips.count += 1;
      protectedSkips.bytes += approximateBytes.bytes;
      protectedSkips.truncated ||= approximateBytes.truncated;
      logger?.warn?.(`[disk-headroom-cleanup] skip ${childPath}: protected-path-in-use`, {
        module: 'disk-headroom',
        targetKey,
        path: childPath,
        protectedSkipBytes: approximateBytes.bytes,
        protectedSkipBytesTruncated: approximateBytes.truncated,
      });
      continue;
    }
    await eraseLocalPath(childPath, errors);
  }
}

async function sweepStaleReclaimableChildren(
  dirPath: string,
  minAgeMinutes: number,
  errors: string[],
  protectedSkips: ProtectedSkipAccounting,
  protectedPaths: ReadonlySet<string>,
  logger?: Logger,
  targetKey?: string,
): Promise<void> {
  if (!existsSync(dirPath)) return;
  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch (err) {
    errors.push(`readdir ${dirPath}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const cutoffMs = Date.now() - minAgeMinutes * 60 * 1000;
  for (const name of entries) {
    const childPath = join(dirPath, name);
    try {
      if (lstatSync(childPath).mtimeMs > cutoffMs) continue;
    } catch (err) {
      errors.push(`lstat ${childPath}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    await removeLocalDir(childPath, errors, protectedSkips, protectedPaths, logger, targetKey);
  }
}

export async function cleanupLocalInvokerHome(
  opts: CleanupLocalInvokerHomeOptions,
): Promise<DiskCleanupResult> {
  const targetKey = opts.targetKey ?? `local ${opts.invokerHome}`;
  const userHome = opts.userHome ?? homedir();
  const home = expandTildeHome(opts.invokerHome, userHome);
  const mode = opts.mode ?? 'critical';
  if (!isSafeInvokerHome(home, userHome)) {
    return {
      targetKey,
      ok: false,
      reason: 'path-guard',
      detail: home,
      protectedSkipCount: 0,
      protectedSkipBytes: 0,
    };
  }

  const processWithNoAsar = process as ProcessWithNoAsar;
  const hadNoAsar = Object.prototype.hasOwnProperty.call(processWithNoAsar, 'noAsar');
  const previousNoAsar = processWithNoAsar.noAsar;
  processWithNoAsar.noAsar = true;

  try {
    opts.logger?.info?.(`[disk-headroom-cleanup] local ${mode === 'stale-only' ? 'stale-only ' : ''}begin home=${home}`, {
      module: 'disk-headroom',
      targetKey,
    });

    const protectedPaths = opts.store ? computeProtectedLocalPaths(opts.store) : new Set<string>();
    const protectedRepoHashes = opts.store ? computeProtectedRepoHashes(opts.store) : new Set<string>();
    const errors: string[] = [];
    const protectedSkips: ProtectedSkipAccounting = {
      paths: [],
      count: 0,
      bytes: 0,
      truncated: false,
    };
    if (mode === 'stale-only') {
      const minAgeMinutes = Math.max(
        opts.minAgeMinutes ?? TMP_SCRATCH_MIN_AGE_MINUTES,
        TMP_SCRATCH_MIN_AGE_MINUTES,
      );
      for (const name of DISK_RECLAIMABLE_DIRS) {
        await sweepStaleReclaimableChildren(
          join(home, name),
          minAgeMinutes,
          errors,
          protectedSkips,
          protectedPaths,
          opts.logger,
          targetKey,
        );
      }
    } else {
      await sweepLocalDeletingOrphans(home, errors, protectedSkips, protectedPaths, opts.logger, targetKey);
      await sweepRepoChildren(
        join(home, 'repos'),
        errors,
        protectedSkips,
        protectedRepoHashes,
        protectedPaths,
        opts.logger,
        targetKey,
      );
      for (const name of ['runtime', 'worktrees', 'merge-clones', 'merge-launches'] as const) {
        await sweepReclaimableChildren(join(home, name), errors, protectedSkips, protectedPaths, opts.logger, targetKey);
      }
      // pr-cron-work: PR #6632 retired its only producer, so there is nothing there to preserve.
      await removeLocalDir(join(home, 'pr-cron-work'), errors, protectedSkips, protectedPaths, opts.logger, targetKey);
      for (const name of DISK_RECLAIMABLE_DIRS) {
        ensureLocalDir(join(home, name), errors);
      }
    }

    const resultBase = {
      targetKey,
      protectedSkipCount: protectedSkips.count,
      protectedSkipBytes: protectedSkips.bytes,
      ...(protectedSkips.truncated ? { protectedSkipBytesTruncated: true } : {}),
    };

    if (errors.length > 0) {
      opts.logger?.warn?.(`[disk-headroom-cleanup] local partial failures`, {
        module: 'disk-headroom',
        targetKey,
        errors,
      });
      logLocalCleanupDone({
        logger: opts.logger,
        mode,
        home,
        targetKey,
        ok: false,
        reason: 'cleanup-error',
        protectedSkips,
      });
      return {
        ...resultBase,
        ok: false,
        reason: 'cleanup-error',
        detail: errors.slice(0, 5).join('; '),
      };
    }

    if (protectedSkips.count > 0) {
      opts.logger?.warn?.(`[disk-headroom-cleanup] local skipped in-use paths`, {
        module: 'disk-headroom',
        targetKey,
        protectedSkips: protectedSkips.paths,
        protectedSkipCount: protectedSkips.count,
        protectedSkipBytes: protectedSkips.bytes,
        protectedSkipBytesTruncated: protectedSkips.truncated,
      });
      logLocalCleanupDone({
        logger: opts.logger,
        mode,
        home,
        targetKey,
        ok: true,
        reason: mode === 'stale-only' ? 'warn-paced' : 'protected-path-in-use',
        protectedSkips,
      });
      return {
        ...resultBase,
        ok: true,
        reason: mode === 'stale-only' ? 'warn-paced' : 'protected-path-in-use',
        detail: protectedSkips.paths.slice(0, 5).join('; '),
      };
    }

    logLocalCleanupDone({
      logger: opts.logger,
      mode,
      home,
      targetKey,
      ok: true,
      reason: mode === 'stale-only' ? 'warn-paced' : 'critical-cleanup',
      protectedSkips,
    });
    return {
      ...resultBase,
      ok: true,
      reason: mode === 'stale-only' ? 'warn-paced' : 'critical-cleanup',
    };
  } finally {
    if (hadNoAsar) {
      processWithNoAsar.noAsar = previousNoAsar;
    } else {
      delete processWithNoAsar.noAsar;
    }
  }
}

/**
 * Eagerly reads `store` down to the tasks belonging to `poolMemberId` (the
 * same key task dispatch joins on — see selectedRemoteTargetId in
 * task-runner-pool.ts). Fetches happen here, outside of
 * computeProtectedLocalPaths/computeProtectedRepoHashes's own fail-safe
 * try/catch, so a real accessor error propagates to the caller instead of
 * being swallowed into an empty (i.e. "protect nothing") result — remote
 * cleanup must fail closed, not fail open onto an unprotected wipe.
 */
function narrowStoreToPoolMemberOrThrow(
  store: DiskHeadroomWorkerStore,
  poolMemberId: string,
): DiskHeadroomWorkerStore {
  const workflows = store.listWorkflows();
  const tasksByWorkflowId = new Map<string, TaskState[]>();
  for (const workflow of workflows) {
    const tasks = store.loadTasks(workflow.id).filter(
      (task) => (task.config as { poolMemberId?: string }).poolMemberId === poolMemberId,
    );
    tasksByWorkflowId.set(workflow.id, tasks);
  }
  return {
    listWorkflows: () => workflows,
    loadTasks: (workflowId) => tasksByWorkflowId.get(workflowId) ?? [],
  };
}

/**
 * This target's short preservation set, as paths relative to
 * `target.remotePath`: `repos/<hash>` for protected repo mirrors and
 * `worktrees/<hash>/<branch>` (etc.) for protected task workspaces. Throws
 * if `store` throws — callers must fail closed on that, not fall back to an
 * unprotected remote wipe.
 */
function computeRemotePreservationPaths(
  store: DiskHeadroomWorkerStore,
  target: RemoteDiskTarget,
): string[] {
  const narrowed = narrowStoreToPoolMemberOrThrow(store, target.name);
  const preserved = new Set<string>();
  for (const hash of computeProtectedRepoHashes(narrowed)) {
    preserved.add(`repos/${hash}`);
  }
  const resolvedHome = resolve(target.remotePath);
  const homePrefix = `${resolvedHome}${sep}`;
  for (const path of computeProtectedLocalPaths(narrowed)) {
    if (!path.startsWith(homePrefix)) continue;
    const relative = path.slice(homePrefix.length);
    if (relative) preserved.add(relative);
  }
  return [...preserved];
}

export async function cleanupRemoteInvokerHome(opts: {
  target: RemoteDiskTarget;
  logger?: Logger;
  store?: DiskHeadroomWorkerStore;
  runRemoteScript?: (target: RemoteDiskTarget, script: string) => Promise<string>;
}): Promise<DiskCleanupResult> {
  const targetKey = `ssh:${opts.target.name} ${opts.target.remotePath}`;
  if (!isSafeRemoteInvokerHomePath(opts.target.remotePath)) {
    return {
      targetKey,
      ok: false,
      reason: 'path-guard',
      detail: opts.target.remotePath,
      protectedSkipCount: 0,
      protectedSkipBytes: 0,
    };
  }

  let preservePaths: string[] = [];
  if (opts.store) {
    try {
      preservePaths = computeRemotePreservationPaths(opts.store, opts.target);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      opts.logger?.error?.(
        `[disk-headroom-cleanup] remote preservation lookup failed ${targetKey}: ${detail}`,
        { module: 'disk-headroom', targetKey },
      );
      return { targetKey, ok: false, reason: 'cleanup-error', detail };
    }
  }

  const script = buildInvokerHomeCleanupScript(opts.target.remotePath, preservePaths);
  const run = opts.runRemoteScript ?? defaultRunRemoteCleanup;
  try {
    opts.logger?.info?.(`[disk-headroom-cleanup] remote begin ${targetKey}`, {
      module: 'disk-headroom',
      targetKey,
    });
    const output = await run(opts.target, script);
    opts.logger?.info?.(`[disk-headroom-cleanup] remote done ${targetKey}`, {
      module: 'disk-headroom',
      targetKey,
      outputTail: output.slice(-400),
    });
    return {
      targetKey,
      ok: true,
      reason: 'critical-cleanup',
      detail: output.slice(-400),
      protectedSkipCount: 0,
      protectedSkipBytes: 0,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    opts.logger?.error?.(`[disk-headroom-cleanup] remote failed ${targetKey}: ${detail}`, {
      module: 'disk-headroom',
      targetKey,
    });
    return {
      targetKey,
      ok: false,
      reason: 'cleanup-error',
      detail,
      protectedSkipCount: 0,
      protectedSkipBytes: 0,
    };
  }
}

function defaultRunRemoteCleanup(target: RemoteDiskTarget, script: string): Promise<string> {
  const sshArgs = buildSshConnectionArgs(target.connection, { batchMode: true });
  return execRemoteCapture({
    sshArgs,
    script,
    phase: `disk-headroom-cleanup:${target.name}`,
  });
}

export class DiskCleanupCooldownTracker {
  private readonly lastCleanupAt = new Map<string, number>();

  constructor(private readonly cooldownMs: number) {}

  canCleanup(targetKey: string, nowMs: number = Date.now()): boolean {
    if (this.cooldownMs <= 0) return true;
    const last = this.lastCleanupAt.get(targetKey);
    if (last === undefined) return true;
    return nowMs - last >= this.cooldownMs;
  }

  markCleaned(targetKey: string, nowMs: number = Date.now()): void {
    this.lastCleanupAt.set(targetKey, nowMs);
  }
}
