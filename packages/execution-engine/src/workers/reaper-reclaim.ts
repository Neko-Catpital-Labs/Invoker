import { execFile } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { hourlySnapshotRetention, pruneHourlySnapshots, type Logger } from '@invoker/contracts';

import { buildSshConnectionArgs } from '../ssh-transport-options.js';
import { bashNormalizeTildePath, execRemoteCapture, shellPosixSingleQuote } from '../ssh-git-exec.js';
import { hasFreshInUseMark, IN_USE_MARK_DIR } from '../workspace-in-use-mark.js';

import type { RemoteDiskTarget } from './disk-headroom-monitor.js';
import {
  computeProtectedLocalPaths,
  expandTildeHome,
  isDeletingOrphanName,
  isSafeInvokerHome,
  isSafeRemoteInvokerHomePath,
  type DiskCleanupResult,
  type DiskHeadroomWorkerStore,
} from './disk-headroom-reclaim.js';

export const DELETING_ORPHAN_MIN_AGE_MINUTES = 30;

export const STALE_MERGE_CLONE_MIN_AGE_HOURS = 48;

export const STALE_DEVELOPMENT_HOME_MIN_AGE_DAYS = 7;

export const AUTOMATION_CHECKOUT_DIRS = [
  'mergify-admin-requeue-work',
  'land-admin-bypass-work',
] as const;

export const AUTOMATION_CHECKOUT_MIN_AGE_HOURS = 48;

export const STALE_WORKTREE_MIN_AGE_HOURS = 48;
export const STALE_WORKTREE_GIT_TIMEOUT_MS = 5 * 60 * 1000;
export const STALE_INVOKER_CLI_TEMP_MIN_AGE_HOURS = 48;

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

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
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
    return {
      targetKey,
      ok: false,
      reason: 'path-guard',
      detail: home,
      protectedSkipCount: 0,
      protectedSkipBytes: 0,
    };
  }
  if (!existsSync(home)) {
    return {
      targetKey,
      ok: true,
      reason: 'reap-orphans',
      detail: 'removed 0',
      protectedSkipCount: 0,
      protectedSkipBytes: 0,
    };
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
    return {
      targetKey,
      ok: false,
      reason: 'cleanup-error',
      detail: errors.slice(0, 5).join('; '),
      protectedSkipCount: 0,
      protectedSkipBytes: 0,
    };
  }
  return {
    targetKey,
    ok: true,
    reason: 'reap-orphans',
    detail: `removed ${removed}`,
    protectedSkipCount: 0,
    protectedSkipBytes: 0,
  };
}

export async function reapRemoteDeletingOrphans(opts: {
  target: RemoteDiskTarget;
  logger?: Logger;
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

  const script = buildDeletingOrphanReapScript(opts.target.remotePath);
  const run = opts.runRemoteScript ?? defaultRunRemoteReap;
  try {
    const output = await run(opts.target, script);
    return {
      targetKey,
      ok: true,
      reason: 'reap-orphans',
      detail: output.slice(-400),
      protectedSkipCount: 0,
      protectedSkipBytes: 0,
    };
  } catch (err) {
    const detail = errorDetail(err);
    opts.logger?.error?.(`[reaper] remote orphan reap failed ${targetKey}: ${detail}`, {
      module: 'reaper',
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

type RunLocalGit = (args: string[], timeoutMs: number) => Promise<void>;

function defaultRunLocalGit(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { timeout: timeoutMs, windowsHide: true }, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

export async function reapLocalStaleWorktrees(opts: {
  invokerHome: string;
  logger?: Logger;
  userHome?: string;
  nowMs?: number;
  runLocalGit?: RunLocalGit;
  gitTimeoutMs?: number;
}): Promise<string[]> {
  const userHome = opts.userHome ?? homedir();
  const home = expandTildeHome(opts.invokerHome, userHome);
  if (!isSafeInvokerHome(home, userHome)) return [];

  const worktreesRoot = join(home, 'worktrees');
  if (!isDirectory(worktreesRoot)) return [];

  const nowMs = opts.nowMs ?? Date.now();
  const minAgeMs = STALE_WORKTREE_MIN_AGE_HOURS * 60 * 60 * 1000;
  const runLocalGit = opts.runLocalGit ?? defaultRunLocalGit;
  const gitTimeoutMs = opts.gitTimeoutMs ?? STALE_WORKTREE_GIT_TIMEOUT_MS;
  const staleByRepoHash = new Map<string, string[]>();

  let repoHashes: string[];
  try {
    repoHashes = readdirSync(worktreesRoot);
  } catch {
    return [];
  }

  for (const repoHash of repoHashes) {
    const repoWorktreeRoot = join(worktreesRoot, repoHash);
    if (!isDirectory(repoWorktreeRoot)) continue;

    let branches: string[];
    try {
      branches = readdirSync(repoWorktreeRoot);
    } catch {
      continue;
    }

    for (const branch of branches) {
      const path = join(repoWorktreeRoot, branch);
      if (!isDirectory(path)) continue;
      const ageMs = entryAgeMs(path, nowMs);
      if (ageMs === null || ageMs < minAgeMs) continue;
      const paths = staleByRepoHash.get(repoHash) ?? [];
      paths.push(path);
      staleByRepoHash.set(repoHash, paths);
    }
  }

  const removed: string[] = [];
  for (const [repoHash, paths] of staleByRepoHash) {
    const repoPath = join(home, 'repos', repoHash);
    for (const path of paths) {
      try {
        await runLocalGit(
          ['-C', repoPath, 'worktree', 'remove', '--force', path],
          gitTimeoutMs,
        );
      } catch (err) {
        opts.logger?.warn?.(`[reaper] git worktree remove failed for ${path}: ${errorDetail(err)}`, {
          module: 'reaper',
        });
        try {
          await rm(path, { recursive: true, force: true });
        } catch (rmErr) {
          opts.logger?.warn?.(`[reaper] failed to remove stale worktree ${path}: ${errorDetail(rmErr)}`, {
            module: 'reaper',
          });
          continue;
        }
      }
      removed.push(path);
      opts.logger?.info?.(`[reaper] removed stale worktree ${path}`, { module: 'reaper' });
    }

    try {
      await runLocalGit(['-C', repoPath, 'worktree', 'prune'], gitTimeoutMs);
    } catch (err) {
      opts.logger?.warn?.(`[reaper] git worktree prune failed for ${repoPath}: ${errorDetail(err)}`, {
        module: 'reaper',
      });
    }
  }
  return removed;
}

export function buildStaleWorktreeReapScript(invokerHome: string, minAgeHours: number): string {
  const homeQ = shellPosixSingleQuote(invokerHome);
  const minAgeMinutes = Math.floor(minAgeHours * 60);
  return `set +e
INVOKER_HOME=${homeQ}
${bashNormalizeTildePath('INVOKER_HOME')}
case "$INVOKER_HOME" in
  ""|"/"|"$HOME"|"~")
    echo "Refusing unsafe INVOKER_HOME: $INVOKER_HOME" >&2
    exit 64
    ;;
esac
REPOS_SEEN=$(mktemp "\${TMPDIR:-/tmp}/invoker-stale-worktrees.XXXXXX") || exit 1
trap 'rm -f "$REPOS_SEEN"' EXIT
if [ -d "$INVOKER_HOME/worktrees" ]; then
  find "$INVOKER_HOME/worktrees" -mindepth 2 -maxdepth 2 -type d -mmin +${minAgeMinutes} \\
    -print0 2>/dev/null | while IFS= read -r -d '' path; do
    rel=\${path#"$INVOKER_HOME/worktrees/"}
    repo_hash=\${rel%%/*}
    case "$repo_hash" in
      ""|"."|".."|*/*)
        continue
        ;;
    esac
    repo="$INVOKER_HOME/repos/$repo_hash"
    if git -C "$repo" worktree remove --force "$path" >/dev/null 2>&1 || rm -rf "$path" >/dev/null 2>&1; then
      if [ ! -e "$path" ]; then
        echo "removed $path"
        printf '%s\\n' "$repo_hash" >> "$REPOS_SEEN"
      fi
    fi
  done
fi
if [ -s "$REPOS_SEEN" ]; then
  sort -u "$REPOS_SEEN" | while IFS= read -r repo_hash; do
    [ -n "$repo_hash" ] || continue
    git -C "$INVOKER_HOME/repos/$repo_hash" worktree prune >/dev/null 2>&1 || true
  done
fi
exit 0
`;
}

export async function reapRemoteStaleWorktrees(opts: {
  target: RemoteDiskTarget;
  logger?: Logger;
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

  const script = buildStaleWorktreeReapScript(
    opts.target.remotePath,
    STALE_WORKTREE_MIN_AGE_HOURS,
  );
  const run = opts.runRemoteScript ?? defaultRunRemoteStaleWorktreeReap;
  try {
    const output = await run(opts.target, script);
    const removed = output
      .split('\n')
      .filter((line) => line.trimStart().startsWith('removed ')).length;
    return {
      targetKey,
      ok: true,
      reason: 'reap-worktrees',
      detail: `removed ${removed}`,
      protectedSkipCount: 0,
      protectedSkipBytes: 0,
    };
  } catch (err) {
    const detail = errorDetail(err);
    opts.logger?.error?.(`[reaper] remote stale worktree reap failed ${targetKey}: ${detail}`, {
      module: 'reaper',
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

function defaultRunRemoteStaleWorktreeReap(
  target: RemoteDiskTarget,
  script: string,
): Promise<string> {
  const sshArgs = buildSshConnectionArgs(target.connection, { batchMode: true });
  return execRemoteCapture({
    sshArgs,
    script,
    phase: `reaper-worktrees:${target.name}`,
  });
}

export async function reapStaleWorktrees(opts: {
  invokerHome: string;
  remoteTargets?: RemoteDiskTarget[];
  logger?: Logger;
  userHome?: string;
  nowMs?: number;
  runRemoteScript?: (target: RemoteDiskTarget, script: string) => Promise<string>;
  runLocalGit?: RunLocalGit;
  gitTimeoutMs?: number;
}): Promise<DiskCleanupResult[]> {
  const targetKey = `local ${opts.invokerHome}`;
  const userHome = opts.userHome ?? homedir();
  const home = expandTildeHome(opts.invokerHome, userHome);
  const localResult: DiskCleanupResult = !isSafeInvokerHome(home, userHome)
    ? {
        targetKey,
        ok: false,
        reason: 'path-guard',
        detail: home,
        protectedSkipCount: 0,
        protectedSkipBytes: 0,
      }
    : {
        targetKey,
        ok: true,
        reason: 'reap-worktrees',
        detail: `removed ${(await reapLocalStaleWorktrees(opts)).length}`,
        protectedSkipCount: 0,
        protectedSkipBytes: 0,
      };

  const results: DiskCleanupResult[] = [localResult];
  for (const target of opts.remoteTargets ?? []) {
    results.push(
      await reapRemoteStaleWorktrees({
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

export interface StaleMergeCloneReapResult {
  ok: boolean;
  removed: string[];
  reason?: string;
}

function readInUseWorkspacePaths(store: DiskHeadroomWorkerStore): Set<string> {
  const workflows = store.listWorkflows();
  const tasksByWorkflowId = new Map(workflows.map((workflow) => [workflow.id, store.loadTasks(workflow.id)]));
  return computeProtectedLocalPaths({
    listWorkflows: () => workflows,
    loadTasks: (workflowId) => tasksByWorkflowId.get(workflowId) ?? [],
  });
}

function overlapsInUsePath(candidate: string, inUse: ReadonlySet<string>): boolean {
  const resolved = resolve(candidate);
  for (const path of inUse) {
    if (resolved === path || path.startsWith(`${resolved}/`) || resolved.startsWith(`${path}/`)) return true;
  }
  return false;
}

export async function reapStaleMergeClones(opts: {
  invokerHome: string;
  taskStore?: DiskHeadroomWorkerStore;
  logger?: Logger;
  userHome?: string;
  nowMs?: number;
}): Promise<StaleMergeCloneReapResult> {
  const userHome = opts.userHome ?? homedir();
  const home = expandTildeHome(opts.invokerHome, userHome);
  if (!isSafeInvokerHome(home, userHome)) return { ok: false, removed: [], reason: 'path-guard' };
  if (!opts.taskStore) return { ok: false, removed: [], reason: 'no-task-store' };

  let inUse: Set<string>;
  try {
    inUse = readInUseWorkspacePaths(opts.taskStore);
  } catch (err) {
    const detail = errorDetail(err);
    opts.logger?.error?.(`[reaper] skipped merge-clone reap, task state unreadable: ${detail}`, { module: 'reaper' });
    return { ok: false, removed: [], reason: `task-store-error: ${detail}` };
  }

  const root = join(home, 'merge-clones');
  if (!isDirectory(root)) return { ok: true, removed: [] };
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch (err) {
    const detail = errorDetail(err);
    opts.logger?.error?.(`[reaper] could not list ${root}: ${detail}`, { module: 'reaper' });
    return { ok: false, removed: [], reason: `cleanup-error: ${detail}` };
  }

  const nowMs = opts.nowMs ?? Date.now();
  const minAgeMs = STALE_MERGE_CLONE_MIN_AGE_HOURS * 60 * 60 * 1000;
  const removed: string[] = [];
  const errors: string[] = [];
  for (const name of entries) {
    const path = join(root, name);
    const ageMs = entryAgeMs(path, nowMs);
    if (ageMs === null || ageMs < minAgeMs) continue;
    if (overlapsInUsePath(path, inUse)) {
      opts.logger?.info?.(`[reaper] kept in-use merge clone ${path}`, { module: 'reaper' });
      continue;
    }
    try {
      await rm(path, { recursive: true, force: true });
      removed.push(path);
      opts.logger?.info?.(`[reaper] removed stale merge clone ${path}`, { module: 'reaper' });
    } catch (err) {
      errors.push(`${path}: ${errorDetail(err)}`);
      opts.logger?.warn?.(`[reaper] failed to remove merge clone ${path}: ${errorDetail(err)}`, { module: 'reaper' });
    }
  }
  if (errors.length > 0) {
    return { ok: false, removed, reason: `cleanup-error: ${errors.slice(0, 3).join('; ')}` };
  }
  return { ok: true, removed };
}

export interface StaleDevelopmentHomeReapResult {
  ok: boolean;
  removed: string[];
  unchecked: string[];
  reason?: string;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

type PathKind = { state: 'directory' } | { state: 'missing' } | { state: 'other' } | { state: 'error'; detail: string };

function pathKind(path: string): PathKind {
  try {
    return statSync(path).isDirectory() ? { state: 'directory' } : { state: 'other' };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' };
    return { state: 'error', detail: `${path}: ${errorDetail(err)}` };
  }
}

function parsePid(raw: string): number | null {
  const value = raw.trim();
  if (!/^[1-9]\d*$/.test(value)) return null;
  const pid = Number(value);
  return Number.isSafeInteger(pid) ? pid : null;
}

type NewestMtime = { ok: true; ms: number } | { ok: false; detail: string };

function newestMtimeMs(dir: string): NewestMtime {
  let newest = 0;
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let stat;
    try {
      stat = lstatSync(current);
    } catch (err) {
      if (current !== dir && (err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return { ok: false, detail: `${current}: ${errorDetail(err)}` };
    }
    newest = Math.max(newest, stat.mtimeMs);
    if (!stat.isDirectory()) continue;
    let names: string[];
    try {
      names = readdirSync(current);
    } catch (err) {
      return { ok: false, detail: `${current}: ${errorDetail(err)}` };
    }
    for (const name of names) pending.push(join(current, name));
  }
  return { ok: true, ms: newest };
}

type LockHolder = { state: 'none' } | { state: 'alive'; pid: number; lock: string } | { state: 'unreadable'; detail: string };

function findLockHolder(devHome: string, isProcessAlive: (pid: number) => boolean): LockHolder {
  let names: string[];
  try {
    names = readdirSync(devHome);
  } catch (err) {
    return { state: 'unreadable', detail: `${devHome}: ${errorDetail(err)}` };
  }
  for (const name of names) {
    if (!name.endsWith('.lock')) continue;
    const kind = pathKind(join(devHome, name));
    if (kind.state === 'error') return { state: 'unreadable', detail: kind.detail };
    if (kind.state !== 'directory') continue;
    const pidPath = join(devHome, name, 'pid');
    if (!existsSync(pidPath)) continue;
    let raw: string;
    try {
      raw = readFileSync(pidPath, 'utf8');
    } catch (err) {
      return { state: 'unreadable', detail: `${pidPath}: ${errorDetail(err)}` };
    }
    const pid = parsePid(raw);
    if (pid === null) return { state: 'unreadable', detail: `${pidPath}: invalid pid` };
    if (isProcessAlive(pid)) return { state: 'alive', pid, lock: name };
  }

  const locksDir = join(devHome, 'locks');
  const locksKind = pathKind(locksDir);
  if (locksKind.state === 'error') return { state: 'unreadable', detail: locksKind.detail };
  if (locksKind.state !== 'directory') return { state: 'none' };
  let lockNames: string[];
  try {
    lockNames = readdirSync(locksDir);
  } catch (err) {
    return { state: 'unreadable', detail: `${locksDir}: ${errorDetail(err)}` };
  }
  for (const lockName of lockNames) {
    if (!lockName.endsWith('.lock')) continue;
    const lockPath = join(locksDir, lockName);
    let pid: unknown;
    try {
      pid = (JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown }).pid;
    } catch (err) {
      return { state: 'unreadable', detail: `${lockPath}: ${errorDetail(err)}` };
    }
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
      return { state: 'unreadable', detail: `${lockPath}: invalid pid` };
    }
    if (isProcessAlive(pid)) return { state: 'alive', pid, lock: `locks/${lockName}` };
  }
  return { state: 'none' };
}

export async function reapStaleDevelopmentHomes(opts: {
  invokerHome: string;
  logger?: Logger;
  userHome?: string;
  nowMs?: number;
  isProcessAlive?: (pid: number) => boolean;
}): Promise<StaleDevelopmentHomeReapResult> {
  const userHome = opts.userHome ?? homedir();
  const home = expandTildeHome(opts.invokerHome, userHome);
  if (!isSafeInvokerHome(home, userHome)) return { ok: false, removed: [], unchecked: [], reason: 'path-guard' };

  const devRoot = join(home, 'dev');
  const rootKind = pathKind(devRoot);
  if (rootKind.state === 'error') {
    opts.logger?.error?.(`[reaper] could not check ${rootKind.detail}`, { module: 'reaper' });
    return { ok: false, removed: [], unchecked: [], reason: `cleanup-error: ${rootKind.detail}` };
  }
  if (rootKind.state !== 'directory') return { ok: true, removed: [], unchecked: [] };
  let entries: string[];
  try {
    entries = readdirSync(devRoot);
  } catch (err) {
    const detail = errorDetail(err);
    opts.logger?.error?.(`[reaper] could not list ${devRoot}: ${detail}`, { module: 'reaper' });
    return { ok: false, removed: [], unchecked: [], reason: `cleanup-error: ${detail}` };
  }

  const nowMs = opts.nowMs ?? Date.now();
  const minAgeMs = STALE_DEVELOPMENT_HOME_MIN_AGE_DAYS * 24 * 60 * 60 * 1000;
  const isProcessAlive = opts.isProcessAlive ?? defaultIsProcessAlive;
  const removed: string[] = [];
  const unchecked: string[] = [];
  const errors: string[] = [];
  for (const name of entries) {
    const devHome = join(devRoot, name);
    const homeKind = pathKind(devHome);
    if (homeKind.state === 'error') {
      unchecked.push(devHome);
      opts.logger?.warn?.(`[reaper] kept dev home, could not check ${homeKind.detail}`, { module: 'reaper' });
      continue;
    }
    if (homeKind.state !== 'directory') continue;
    const newest = newestMtimeMs(devHome);
    if (!newest.ok) {
      unchecked.push(devHome);
      opts.logger?.warn?.(`[reaper] kept dev home, age unreadable: ${newest.detail}`, { module: 'reaper' });
      continue;
    }
    if (nowMs - newest.ms < minAgeMs) continue;

    const holder = findLockHolder(devHome, isProcessAlive);
    if (holder.state === 'unreadable') {
      unchecked.push(devHome);
      opts.logger?.warn?.(`[reaper] kept dev home, lock unreadable: ${holder.detail}`, { module: 'reaper' });
      continue;
    }
    if (holder.state === 'alive') {
      opts.logger?.info?.(`[reaper] kept dev home ${devHome}, ${holder.lock} held by running pid ${holder.pid}`, { module: 'reaper' });
      continue;
    }
    try {
      await rm(devHome, { recursive: true, force: true });
      removed.push(devHome);
      opts.logger?.info?.(`[reaper] removed stale dev home ${devHome}`, { module: 'reaper' });
    } catch (err) {
      errors.push(`${devHome}: ${errorDetail(err)}`);
      opts.logger?.warn?.(`[reaper] failed to remove dev home ${devHome}: ${errorDetail(err)}`, { module: 'reaper' });
    }
  }
  if (errors.length > 0) {
    return { ok: false, removed, unchecked, reason: `cleanup-error: ${errors.slice(0, 3).join('; ')}` };
  }
  return { ok: true, removed, unchecked };
}

type ListedDir = { ok: true; names: string[] } | { ok: false; detail: string };

function listDir(path: string): ListedDir {
  try {
    return { ok: true, names: readdirSync(path) };
  } catch (err) {
    return { ok: false, detail: `${path}: ${errorDetail(err)}` };
  }
}

export async function reapStaleDevelopmentWorktrees(opts: {
  invokerHome: string;
  logger?: Logger;
  userHome?: string;
  nowMs?: number;
  runLocalGit?: RunLocalGit;
  gitTimeoutMs?: number;
}): Promise<StaleDevelopmentHomeReapResult> {
  const userHome = opts.userHome ?? homedir();
  const home = expandTildeHome(opts.invokerHome, userHome);
  if (!isSafeInvokerHome(home, userHome)) return { ok: false, removed: [], unchecked: [], reason: 'path-guard' };

  const devRoot = join(home, 'dev');
  const rootKind = pathKind(devRoot);
  if (rootKind.state === 'error') {
    opts.logger?.error?.(`[reaper] could not check ${rootKind.detail}`, { module: 'reaper' });
    return { ok: false, removed: [], unchecked: [], reason: `cleanup-error: ${rootKind.detail}` };
  }
  if (rootKind.state !== 'directory') return { ok: true, removed: [], unchecked: [] };
  const devHomes = listDir(devRoot);
  if (!devHomes.ok) {
    opts.logger?.error?.(`[reaper] could not list ${devHomes.detail}`, { module: 'reaper' });
    return { ok: false, removed: [], unchecked: [], reason: `cleanup-error: ${devHomes.detail}` };
  }

  const nowMs = opts.nowMs ?? Date.now();
  const minAgeMs = STALE_WORKTREE_MIN_AGE_HOURS * 60 * 60 * 1000;
  const runLocalGit = opts.runLocalGit ?? defaultRunLocalGit;
  const gitTimeoutMs = opts.gitTimeoutMs ?? STALE_WORKTREE_GIT_TIMEOUT_MS;
  const removed: string[] = [];
  const unchecked: string[] = [];
  const errors: string[] = [];
  const keepUnchecked = (path: string, detail: string) => {
    unchecked.push(path);
    opts.logger?.warn?.(`[reaper] kept dev worktree, could not check ${detail}`, { module: 'reaper' });
  };

  for (const devName of devHomes.names) {
    const devHome = join(devRoot, devName);
    const worktreesRoot = join(devHome, 'worktrees');
    const worktreesKind = pathKind(worktreesRoot);
    if (worktreesKind.state === 'error') {
      keepUnchecked(worktreesRoot, worktreesKind.detail);
      continue;
    }
    if (worktreesKind.state !== 'directory') continue;
    const repoHashes = listDir(worktreesRoot);
    if (!repoHashes.ok) {
      keepUnchecked(worktreesRoot, repoHashes.detail);
      continue;
    }

    for (const repoHash of repoHashes.names) {
      const repoWorktreeRoot = join(worktreesRoot, repoHash);
      const repoKind = pathKind(repoWorktreeRoot);
      if (repoKind.state === 'error') {
        keepUnchecked(repoWorktreeRoot, repoKind.detail);
        continue;
      }
      if (repoKind.state !== 'directory') continue;
      try {
        if (hasFreshInUseMark(devHome, repoHash, nowMs)) {
          opts.logger?.info?.(`[reaper] kept dev worktrees ${repoWorktreeRoot}, in-use mark is fresh`, { module: 'reaper' });
          continue;
        }
      } catch (err) {
        keepUnchecked(repoWorktreeRoot, `in-use mark ${join(devHome, IN_USE_MARK_DIR, 'worktrees', repoHash)}: ${errorDetail(err)}`);
        continue;
      }
      const branches = listDir(repoWorktreeRoot);
      if (!branches.ok) {
        keepUnchecked(repoWorktreeRoot, branches.detail);
        continue;
      }

      let removedInRepo = 0;
      for (const branch of branches.names) {
        const path = join(repoWorktreeRoot, branch);
        const kind = pathKind(path);
        if (kind.state === 'error') {
          keepUnchecked(path, kind.detail);
          continue;
        }
        if (kind.state !== 'directory') continue;
        const newest = newestMtimeMs(path);
        if (!newest.ok) {
          keepUnchecked(path, newest.detail);
          continue;
        }
        if (nowMs - newest.ms < minAgeMs) continue;
        try {
          await rm(path, { recursive: true, force: true });
          removed.push(path);
          removedInRepo += 1;
          opts.logger?.info?.(`[reaper] removed stale dev worktree ${path}`, { module: 'reaper' });
        } catch (err) {
          errors.push(`${path}: ${errorDetail(err)}`);
          opts.logger?.warn?.(`[reaper] failed to remove dev worktree ${path}: ${errorDetail(err)}`, { module: 'reaper' });
        }
      }

      const repoPath = join(devHome, 'repos', repoHash);
      if (removedInRepo === 0 || !isDirectory(repoPath)) continue;
      try {
        await runLocalGit(['-C', repoPath, 'worktree', 'prune'], gitTimeoutMs);
      } catch (err) {
        opts.logger?.warn?.(`[reaper] git worktree prune failed for ${repoPath}: ${errorDetail(err)}`, { module: 'reaper' });
      }
    }
  }
  if (errors.length > 0) {
    return { ok: false, removed, unchecked, reason: `cleanup-error: ${errors.slice(0, 3).join('; ')}` };
  }
  return { ok: true, removed, unchecked };
}

export async function reapStaleInvokerCliTempDirs(opts: {
  tempRoot?: string;
  userHome?: string;
  nowMs?: number;
  minAgeHours?: number;
  logger?: Logger;
} = {}): Promise<string[]> {
  const rawTempRoot = opts.tempRoot ?? tmpdir();
  if (!rawTempRoot.trim()) return [];
  const tempRoot = resolve(rawTempRoot);
  const userHome = resolve(opts.userHome ?? homedir());
  if (tempRoot === '/' || tempRoot === userHome) return [];

  let entries: string[];
  try {
    entries = readdirSync(tempRoot);
  } catch {
    return [];
  }

  const nowMs = opts.nowMs ?? Date.now();
  const minAgeMs = (opts.minAgeHours ?? STALE_INVOKER_CLI_TEMP_MIN_AGE_HOURS) * 60 * 60 * 1000;
  const candidates = entries.flatMap((name) => {
    if (!name.startsWith('invoker-cli-')) return [];
    const path = join(tempRoot, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || nowMs - stat.mtimeMs < minAgeMs) return [];
      return [{ path, mtimeMs: stat.mtimeMs }];
    } catch {
      return [];
    }
  }).sort((a, b) => a.mtimeMs - b.mtimeMs);

  const removed: string[] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < candidates.length) {
      const candidate = candidates[cursor++];
      if (!candidate) return;
      try {
        await rm(candidate.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        removed.push(candidate.path);
        opts.logger?.info?.(`[reaper] removed stale CLI temp directory ${candidate.path}`, { module: 'reaper' });
      } catch (err) {
        opts.logger?.warn?.(`[reaper] failed to remove stale CLI temp directory ${candidate.path}: ${errorDetail(err)}`, {
          module: 'reaper',
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, worker));
  return removed.sort();
}

export function enforceHourlySnapshotRetention(
  invokerHome: string,
  userHome: string = homedir(),
): number {
  const home = expandTildeHome(invokerHome, userHome);
  return pruneHourlySnapshots(join(home, 'db-backups'), hourlySnapshotRetention());
}
