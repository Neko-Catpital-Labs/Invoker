/**
 * Critical-disk remediation for the disk-headroom worker.
 *
 * Wipes reclaimable Invoker-managed dirs (runtime/repos/worktrees) plus common
 * provision caches. Never touches invoker.db / config.json / the home root.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Logger } from '@invoker/contracts';

import { buildSshConnectionArgs } from '../ssh-transport-options.js';
import { bashNormalizeTildePath, execRemoteCapture, shellPosixSingleQuote } from '../ssh-git-exec.js';

import type { RemoteDiskTarget } from './disk-headroom-monitor.js';

export const DEFAULT_DISK_CLEANUP_COOLDOWN_MS = 30 * 60 * 1000;

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

/**
 * Remote bash that frees Invoker-managed disk under `$INVOKER_HOME`.
 * Kills only provision grinders (pnpm install / electron unzip), not every
 * process whose argv mentions the home (that can kill the SSH session).
 */
export function buildInvokerHomeCleanupScript(invokerHome: string): string {
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
echo "[disk-headroom-cleanup] begin home=$INVOKER_HOME"
df -h / | tail -1
# Provision grinders only — do not pkill -f INVOKER_HOME (kills this SSH session).
pkill -9 -f 'pnpm install --frozen-lockfile' >/dev/null 2>&1
pkill -9 -f 'pnpm install' >/dev/null 2>&1
pkill -9 -f 'electron-v[0-9].*-linux-x64.zip' >/dev/null 2>&1
pkill -9 -f 'node_modules/.pnpm/electron@' >/dev/null 2>&1
sleep 1
remove_path() {
  local path="$1"
  if [ -e "$path" ]; then
    mv "$path" "\${path}.deleting.$$" 2>/dev/null || true
    nohup rm -rf "\${path}.deleting.$$" >/dev/null 2>&1 &
    rm -rf "$path" 2>/dev/null || true
  fi
}
remove_path "$INVOKER_HOME/runtime"
remove_path "$INVOKER_HOME/repos"
remove_path "$INVOKER_HOME/worktrees"
remove_path "$INVOKER_HOME/merge-clones"
rm -rf "$INVOKER_HOME"/*.deleting.* >/dev/null 2>&1
# Common provision caches (best effort).
rm -rf "$HOME/.cache/electron" "$HOME/.local/share/pnpm" "$HOME/.pnpm-store" >/dev/null 2>&1
mkdir -p "$INVOKER_HOME/runtime" "$INVOKER_HOME/repos" "$INVOKER_HOME/worktrees"
chmod 700 "$INVOKER_HOME/runtime" "$INVOKER_HOME/repos" "$INVOKER_HOME/worktrees"
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
  for (const name of ['runtime', 'repos', 'worktrees', 'merge-clones'] as const) {
    removeLocalDir(join(home, name), errors);
  }
  for (const name of ['runtime', 'repos', 'worktrees'] as const) {
    ensureLocalDir(join(home, name), errors);
  }
  for (const cache of [
    join(userHome, '.cache', 'electron'),
    join(userHome, '.local', 'share', 'pnpm'),
    join(userHome, '.pnpm-store'),
  ]) {
    removeLocalDir(cache, errors);
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
