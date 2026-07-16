/**
 * Critical-disk remediation for the disk-headroom worker.
 *
 * Wipes reclaimable Invoker-managed dirs under the Invoker home only.
 * Never touches invoker.db / config.json / the home root / paths outside the home.
 */

import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Logger } from '@invoker/contracts';

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

/** Leave temp entries newer than this alone — an active run may still hold them. */
export const TMP_SCRATCH_MIN_AGE_MINUTES = 60;

export interface DiskCleanupResult {
  targetKey: string;
  ok: boolean;
  reason: string;
  detail?: string;
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

function isDeletingOrphanName(name: string): boolean {
  return name.includes('.deleting.');
}

/**
 * Remote bash that frees Invoker-managed disk under `$INVOKER_HOME`.
 * Kills only provision grinders (pnpm install / electron unzip), not every
 * process whose argv mentions the home (that can kill the SSH session).
 * Deletes synchronously so SSH timeout cannot leave fire-and-forget orphans.
 */
export function buildInvokerHomeCleanupScript(invokerHome: string): string {
  const homeQ = shellPosixSingleQuote(invokerHome);
  const removeCalls = DISK_RECLAIMABLE_DIRS
    .map((name) => `remove_path "$INVOKER_HOME/${name}"`)
    .join('\n');
  const mkdirArgs = DISK_RECLAIMABLE_DIRS
    .map((name) => `"$INVOKER_HOME/${name}"`)
    .join(' ');
  const tmpGlobList = TMP_SCRATCH_GLOBS.join(' ');
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
${removeCalls}
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
for pat in ${tmpGlobList}; do
  for entry in "$TMP_CLEAN"/$pat; do
    reap_tmp "$entry"
  done
done
find "$TMP_CLEAN" -mindepth 1 -maxdepth 1 -mmin +${TMP_SCRATCH_MIN_AGE_MINUTES} \\
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

function removeLocalDir(path: string, errors: string[]): void {
  if (!existsSync(path)) return;
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (err) {
    errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function ensureLocalDir(path: string, errors: string[]): void {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  } catch (err) {
    errors.push(`mkdir ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function sweepLocalDeletingOrphans(home: string, errors: string[]): void {
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
    removeLocalDir(join(home, name), errors);
  }
}

export async function cleanupLocalInvokerHome(opts: {
  invokerHome: string;
  targetKey?: string;
  logger?: Logger;
  userHome?: string;
}): Promise<DiskCleanupResult> {
  const targetKey = opts.targetKey ?? `local ${opts.invokerHome}`;
  const userHome = opts.userHome ?? homedir();
  const home = expandTildeHome(opts.invokerHome, userHome);
  if (!isSafeInvokerHome(home, userHome)) {
    return { targetKey, ok: false, reason: 'path-guard', detail: home };
  }

  opts.logger?.info?.(`[disk-headroom-cleanup] local begin home=${home}`, {
    module: 'disk-headroom',
    targetKey,
  });

  const errors: string[] = [];
  sweepLocalDeletingOrphans(home, errors);
  for (const name of DISK_RECLAIMABLE_DIRS) {
    removeLocalDir(join(home, name), errors);
  }
  for (const name of DISK_RECLAIMABLE_DIRS) {
    ensureLocalDir(join(home, name), errors);
  }

  if (errors.length > 0) {
    opts.logger?.warn?.(`[disk-headroom-cleanup] local partial failures`, {
      module: 'disk-headroom',
      targetKey,
      errors,
    });
    return {
      targetKey,
      ok: false,
      reason: 'cleanup-error',
      detail: errors.slice(0, 5).join('; '),
    };
  }

  opts.logger?.info?.(`[disk-headroom-cleanup] local done home=${home}`, {
    module: 'disk-headroom',
    targetKey,
  });
  return { targetKey, ok: true, reason: 'critical-cleanup' };
}

export async function cleanupRemoteInvokerHome(opts: {
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
    };
  }

  const script = buildInvokerHomeCleanupScript(opts.target.remotePath);
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
    return { targetKey, ok: true, reason: 'critical-cleanup', detail: output.slice(-400) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    opts.logger?.error?.(`[disk-headroom-cleanup] remote failed ${targetKey}: ${detail}`, {
      module: 'disk-headroom',
      targetKey,
    });
    return { targetKey, ok: false, reason: 'cleanup-error', detail };
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
