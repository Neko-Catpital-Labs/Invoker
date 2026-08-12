import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { rm as rmAsync } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { hourlySnapshotRetention, pruneHourlySnapshots, type Logger } from '@invoker/contracts';

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

export const STALE_WORKTREE_MIN_AGE_HOURS = 48;
export const STALE_INVOKER_CLI_TEMP_MIN_AGE_HOURS = 48;

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

export function reapLocalStaleWorktrees(opts: {
  invokerHome: string;
  logger?: Logger;
  userHome?: string;
  nowMs?: number;
}): string[] {
  const userHome = opts.userHome ?? homedir();
  const home = expandTildeHome(opts.invokerHome, userHome);
  if (!isSafeInvokerHome(home, userHome)) return [];

  const worktreesRoot = join(home, 'worktrees');
  if (!isDirectory(worktreesRoot)) return [];

  const nowMs = opts.nowMs ?? Date.now();
  const minAgeMs = STALE_WORKTREE_MIN_AGE_HOURS * 60 * 60 * 1000;
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
        execFileSync('git', ['-C', repoPath, 'worktree', 'remove', '--force', path], {
          stdio: 'ignore',
        });
      } catch (err) {
        opts.logger?.warn?.(`[reaper] git worktree remove failed for ${path}: ${errorDetail(err)}`, {
          module: 'reaper',
        });
        try {
          rmSync(path, { recursive: true, force: true });
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
      execFileSync('git', ['-C', repoPath, 'worktree', 'prune'], { stdio: 'ignore' });
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
        detail: `removed ${reapLocalStaleWorktrees(opts).length}`,
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
        await rmAsync(candidate.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
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
