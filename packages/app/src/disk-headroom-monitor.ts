/**
 * Disk-headroom monitor: the I/O + logging shell around the pure evaluation in
 * `disk-headroom.ts`.
 *
 * This module never blocks scheduling or fails tasks. It exists to surface
 * early warnings (e.g. 85% used) before a box reaches 100% and everything
 * wedges.
 */

import { execFile } from 'node:child_process';

import type { Logger } from '@invoker/contracts';
import {
  bashNormalizeTildePath,
  buildSshConnectionArgs,
  execRemoteCapture,
  shellPosixSingleQuote,
  type SshTargetConnection,
} from '@invoker/execution-engine';

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

  writeActivityLog?: (source: string, level: ActivityLogLevel, message: string) => void;
}

function defaultRunLocalDf(path: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();

  execFile('df', [...DF_ARGS, path], { timeout: LOCAL_DF_TIMEOUT_MS }, (err, stdout, stderr) => {
    if (err) {
      const suffix = stderr?.trim() ? `; stderr=${stderr.trim()}` : '';
      reject(new Error(`df failed for ${path}: ${err.message}${suffix}`));
      return;
    }

    resolve(stdout);
  });

  return promise;
}

/**
 * Build the remote `df` script. Expands a leading `~` to `$HOME` on the remote
 * (config paths like `~/.invoker`) before df'ing the single-quoted path.
 */
export function buildRemoteDfScript(path: string): string {
  const quoted = shellPosixSingleQuote(path);

  return [
    'set -euo pipefail',
    `WT=${quoted}`,
    bashNormalizeTildePath('WT'),
    'df -P -k "$WT"',
  ].join('\n');
}

function defaultRunRemoteDf(target: RemoteDiskTarget): Promise<string> {
  const sshArgs = buildSshConnectionArgs(target.connection, { batchMode: true });
  const script = buildRemoteDfScript(target.remotePath);
  return execRemoteCapture({ sshArgs, script, phase: `disk-headroom:${target.name}` });
}

function auditLog(
  deps: DiskHeadroomMonitorDeps,
  level: ActivityLogLevel,
  message: string,
): void {
  if (!deps.writeActivityLog) return;

  try {
    deps.writeActivityLog(MODULE, level, message);
  } catch (err) {
    deps.logger.debug('Disk headroom: audit sink failed', {
      module: MODULE,
      error: String(err),
    });
  }
}

function emit(deps: DiskHeadroomMonitorDeps, result: DiskHeadroomEvaluation): void {
  const fields = {
    module: MODULE,
    label: result.label,
    usedPercent: result.usage.usedPercent,
    filesystem: result.usage.filesystem,
    mountedOn: result.usage.mountedOn,
    warnPercent: result.thresholds.warnPercent,
    criticalPercent: result.thresholds.criticalPercent,
  };

  if (result.level === 'critical') {
    deps.logger.error(result.message, fields);
    auditLog(deps, 'error', result.message);
    return;
  }

  if (result.level === 'warn') {
    deps.logger.warn(result.message, fields);
    auditLog(deps, 'warn', result.message);
    return;
  }

  deps.logger.debug(result.message, fields);
}

async function checkOne(
  deps: DiskHeadroomMonitorDeps,
  label: string,
  runDf: () => Promise<string>,
): Promise<DiskHeadroomEvaluation | null> {
  let output: string;

  try {
    output = await runDf();
  } catch (err) {
    deps.logger.error('Disk headroom: df failed', {
      module: MODULE,
      label,
      error: String(err),
    });
    return null;
  }

  const usage = parseDfOutput(output);
  if (!usage) {
    deps.logger.error('Disk headroom: failed to parse df output', {
      module: MODULE,
      label,
      output,
    });
    return null;
  }

  const result = evaluateDiskHeadroom(usage, deps.thresholds, label);
  emit(deps, result);
  return result;
}

/**
 * Run one disk-headroom pass: the local disk, then every remote target in
 * parallel. Returns the evaluations that succeeded (parse/df failures are
 * logged and omitted). Never throws.
 */
export async function runDiskHeadroomCheck(
  deps: DiskHeadroomMonitorDeps,
): Promise<DiskHeadroomEvaluation[]> {
  const runLocal = deps.runLocalDf ?? defaultRunLocalDf;
  const runRemote = deps.runRemoteDf ?? defaultRunRemoteDf;

  const localLabel = `local ${deps.localPath}`;
  const local = await checkOne(deps, localLabel, () => runLocal(deps.localPath));

  const remote = await Promise.all(
    deps.remoteTargets.map((t) => {
      const label = `remote ${t.name} ${t.remotePath}`;
      return checkOne(deps, label, () => runRemote(t));
    }),
  );

  return [local, ...remote].filter((x): x is DiskHeadroomEvaluation => Boolean(x));
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
  void runDiskHeadroomCheck(deps);

  const timer = setInterval(() => {
    void runDiskHeadroomCheck(deps);
  }, intervalMs);

  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
  };
}
