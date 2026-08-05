/**
 * Disk-headroom monitor: the I/O + logging shell around the pure evaluation in
 * ./disk-headroom.ts.
 */

import { execFile } from 'node:child_process';

import type { Logger } from '@invoker/contracts';

import { buildSshConnectionArgs, type SshTargetConnection } from '../ssh-transport-options.js';
import { bashNormalizeTildePath, execRemoteCapture, shellPosixSingleQuote } from '../ssh-git-exec.js';

import {
  evaluateDiskHeadroom,
  parseDfOutput,
  type DiskHeadroomEvaluation,
  type DiskHeadroomThresholds,
} from './disk-headroom.js';

const MODULE = 'disk-headroom';
const DF_ARGS = ['-P', '-k'];
const LOCAL_DF_TIMEOUT_MS = 10_000;

export interface RemoteDiskTarget {
  name: string;
  connection: SshTargetConnection;
  remotePath: string;
}

export type ActivityLogLevel = 'info' | 'warn' | 'error';

export interface DiskHeadroomMonitorDeps {
  logger: Logger;
  thresholds: DiskHeadroomThresholds;
  localPath: string;
  remoteTargets: RemoteDiskTarget[];

  runLocalDf?: (path: string) => Promise<string>;
  runRemoteDf?: (target: RemoteDiskTarget) => Promise<string>;

  writeActivityLog?: (level: ActivityLogLevel, message: string) => void;
}

function defaultRunLocalDf(path: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();

  execFile('df', [...DF_ARGS, path], { timeout: LOCAL_DF_TIMEOUT_MS }, (err, stdout, stderr) => {
    if (err) {
      const msg = stderr ? `${err.message}: ${stderr}` : err.message;
      reject(new Error(msg));
      return;
    }
    resolve(String(stdout));
  });

  return promise;
}

/**
 * Build the remote `df` script. Expands a leading `~` to `$HOME` on the remote
 * (config paths like `~/.invoker`) before df'ing the single-quoted path.
 */
export function buildRemoteDfScript(path: string): string {
  const wtQ = shellPosixSingleQuote(path);
  return `set -euo pipefail
WT=${wtQ}
${bashNormalizeTildePath('WT')}
df -P -k "$WT"
`;
}

function defaultRunRemoteDf(target: RemoteDiskTarget): Promise<string> {
  const sshArgs = buildSshConnectionArgs(target.connection, { batchMode: true });
  return execRemoteCapture({
    sshArgs,
    script: buildRemoteDfScript(target.remotePath),
    phase: `disk-headroom:${target.name}`,
  });
}

function auditLog(
  deps: DiskHeadroomMonitorDeps,
  level: ActivityLogLevel,
  message: string,
): void {
  if (!deps.writeActivityLog) return;
  try {
    deps.writeActivityLog(level, message);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    deps.logger.debug?.('[disk-headroom] activity log write failed', {
      module: MODULE,
      level,
      reason,
    });
  }
}

function emit(deps: DiskHeadroomMonitorDeps, result: DiskHeadroomEvaluation): void {
  if (result.level === 'unknown') {
    deps.logger.warn(`[disk-headroom] unknown: ${result.label} (${result.error ?? 'check failed'})`, {
      module: MODULE,
      label: result.label,
      error: result.error,
    });
    return;
  }

  const fields = {
    module: MODULE,
    label: result.label,
    usedPercent: result.usage.usedPercent,
    filesystem: result.usage.filesystem,
    mountedOn: result.usage.mountedOn,
    warnPercent: result.thresholds.warnPercent,
    criticalPercent: result.thresholds.criticalPercent,
  };

  if (result.level === 'ok') {
    deps.logger.debug?.('[disk-headroom] ok', fields);
    return;
  }

  const msg = `[disk-headroom] ${result.level}: ${result.label} (${result.usage.usedPercent}% used)`;
  if (result.level === 'warn') {
    deps.logger.warn(msg, fields);
    auditLog(deps, 'warn', msg);
    return;
  }

  deps.logger.error(msg, fields);
  auditLog(deps, 'error', msg);
}

async function checkOne(
  deps: DiskHeadroomMonitorDeps,
  label: string,
  runDf: () => Promise<string>,
): Promise<DiskHeadroomEvaluation> {
  let stdout = '';
  try {
    stdout = await runDf();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    deps.logger.error(`[disk-headroom] df failed for ${label}: ${reason}`, { module: MODULE, label });
    const result: DiskHeadroomEvaluation = { label, level: 'unknown', thresholds: deps.thresholds, error: reason };
    emit(deps, result);
    return result;
  }

  const usage = parseDfOutput(stdout);
  if (!usage) {
    const reason = 'unparseable df output';
    deps.logger.error(`[disk-headroom] ${reason} for ${label}`, { module: MODULE, label });
    const result: DiskHeadroomEvaluation = { label, level: 'unknown', thresholds: deps.thresholds, error: reason };
    emit(deps, result);
    return result;
  }

  const result = evaluateDiskHeadroom(usage, deps.thresholds, label);
  emit(deps, result);
  return result;
}

/**
 * Run one disk-headroom pass: the local disk, then every remote target in
 * parallel. Every target always contributes exactly one entry — a target
 * whose check couldn't complete (df failed, unparseable output) is included
 * with level 'unknown' rather than being silently omitted, so a target that
 * can't be verified never goes unnoticed. Never throws.
 */
export async function runDiskHeadroomCheck(
  deps: DiskHeadroomMonitorDeps,
): Promise<DiskHeadroomEvaluation[]> {
  const runLocal = deps.runLocalDf ?? defaultRunLocalDf;
  const runRemote = deps.runRemoteDf ?? defaultRunRemoteDf;

  const localLabel = `local ${deps.localPath}`;
  const local = await checkOne(deps, localLabel, () => runLocal(deps.localPath));

  const remotes = await Promise.all(
    deps.remoteTargets.map(async (target) => {
      const label = `ssh:${target.name} ${target.remotePath}`;
      return checkOne(deps, label, () => runRemote(target));
    }),
  );

  return [local, ...remotes];
}

export interface DiskHeadroomMonitorHandle {
  stop: () => void;
}

/**
 * Start the periodic monitor. Runs an immediate check (so a box that starts
 * already-full alerts at once), then repeats on `intervalMs`. The interval is
 * `unref`'d so it never keeps the process alive on its own.
 */
export function startDiskHeadroomMonitor(
  deps: DiskHeadroomMonitorDeps,
  intervalMs: number,
): DiskHeadroomMonitorHandle {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    await runDiskHeadroomCheck(deps);
  };

  void tick();
  const handle = setInterval(() => void tick(), intervalMs);
  handle.unref?.();

  return {
    stop: () => {
      stopped = true;
      clearInterval(handle);
    },
  };
}
