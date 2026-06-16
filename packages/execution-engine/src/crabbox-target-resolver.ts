import { spawn } from 'node:child_process';
import type { CrabboxRemoteLeaseMetadata } from '@invoker/workflow-core';

/**
 * Crabbox target resolver.
 *
 * Crabbox owns machine supply: it warms up (creates or finds) a box and reports
 * a ready SSH endpoint. Invoker owns the SSH executor. This resolver bridges the
 * two: it drives the Crabbox CLI to warm up a box, waits for it to report a
 * reachable SSH endpoint, and returns a static SSH target plus durable lease
 * metadata so the SshExecutor can connect and cleanup can later tear the box
 * down.
 *
 * The resolver never embeds long-lived Crabbox process handling — it shells out
 * for warmup + status once, then hands back a plain endpoint.
 */

/**
 * Subset of the Crabbox remote-target config the resolver needs to build CLI
 * invocations. Mirrors `CrabboxRemoteTargetConfig` in the app config without
 * coupling the execution engine to the app package.
 */
export interface CrabboxResolverConfig {
  /** Command (path or executable name) used to drive the Crabbox CLI. */
  readonly crabboxCommand: string;
  /** Crabbox provider/backend to request the box from. */
  readonly provider: string;
  /** Box class/size to request. */
  readonly class: string;
  /** Lease time-to-live (e.g. "1h" or seconds). */
  readonly ttl: string | number;
  /** Idle timeout before the box is reaped (e.g. "20m" or seconds). */
  readonly idleTimeout: string | number;
  /** Network the box should be attached to. */
  readonly network: string;
  /** Target machine/image identifier to lease. */
  readonly target: string;
  /** Stop policy once the task completes, carried into lease metadata. */
  readonly stopAfter?: string | number;
  /** When true, leave the box running after a failed task for inspection. */
  readonly keepOnFailure?: boolean;
  /** Extra args appended to the warmup invocation. */
  readonly warmupArgs?: readonly string[];
  /** Extra args appended to the status invocation. */
  readonly statusArgs?: readonly string[];
  /** Extra args appended to the stop/cleanup invocation. */
  readonly stopArgs?: readonly string[];
}

/** Result of running a Crabbox CLI command. */
export interface CommandRunnerResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Injectable command runner. The default uses `node:child_process` spawn; tests
 * inject a stub that returns canned warmup/status output.
 */
export type CommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<CommandRunnerResult>;

/** Static SSH endpoint resolved from a Crabbox lease, ready for SshExecutor. */
export interface ResolvedSshTarget {
  readonly host: string;
  readonly user: string;
  /** Path to the SSH identity file (private key). */
  readonly sshKeyPath: string;
  /** SSH port. Omitted when Crabbox does not report one (defaults to 22). */
  readonly port?: number;
}

/** A resolved SSH target plus the durable lease metadata that produced it. */
export interface CrabboxResolvedTarget {
  readonly target: ResolvedSshTarget;
  readonly remoteLeaseMetadata: CrabboxRemoteLeaseMetadata;
}

/**
 * Crabbox `status --json` shape. Field names match the Crabbox source so the
 * resolver can read the report verbatim.
 */
interface CrabboxStatusReport {
  id?: string;
  slug?: string;
  provider?: string;
  status?: string;
  expiresAt?: string;
  sshHost?: string;
  sshUser?: string;
  sshPort?: number | string;
  sshKey?: string;
}

/** Default command runner backed by `node:child_process` spawn. */
const spawnCommandRunner: CommandRunner = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });

/** Build the Crabbox warmup invocation args from config. */
export function buildWarmupArgs(config: CrabboxResolverConfig): string[] {
  return [
    'warmup',
    '--provider',
    config.provider,
    '--class',
    config.class,
    '--ttl',
    String(config.ttl),
    '--idle-timeout',
    String(config.idleTimeout),
    '--network',
    config.network,
    '--target',
    config.target,
    ...(config.warmupArgs ?? []),
  ];
}

/** Build the Crabbox status invocation args for a resolved lease/slug id. */
export function buildStatusArgs(
  config: CrabboxResolverConfig,
  id: string,
): string[] {
  return [
    'status',
    '--id',
    id,
    '--json',
    '--wait',
    ...(config.statusArgs ?? []),
  ];
}

/** Build the Crabbox stop/cleanup invocation args for a lease id. */
export function buildStopArgs(
  config: CrabboxResolverConfig,
  leaseId: string,
): string[] {
  return ['stop', leaseId, ...(config.stopArgs ?? [])];
}

/**
 * Stop (tear down) a leased Crabbox box via `crabbox stop <leaseId>`.
 *
 * @throws if the stop command exits non-zero so callers can log the failure
 * without leaving the box silently leaked.
 */
export async function stopCrabboxLease(
  config: CrabboxResolverConfig,
  leaseId: string,
  runner: CommandRunner = spawnCommandRunner,
): Promise<CommandRunnerResult> {
  const result = await runner(config.crabboxCommand, buildStopArgs(config, leaseId));
  if (result.exitCode !== 0) {
    throw new Error(
      `Crabbox stop failed for lease "${leaseId}" (exit ${result.exitCode}): ${
        result.stderr.trim() || result.stdout.trim() || 'no output'
      }`,
    );
  }
  return result;
}

/**
 * Cleanup policy applied to a Crabbox lease once its SSH task completes.
 *
 * - `success` (default): stop the box only after a successful task; a failed
 *   task is governed by {@link CrabboxResolverConfig.keepOnFailure}.
 * - `always`: stop the box regardless of task outcome.
 * - `never`: never actively stop; leave the box for the Crabbox idle reaper.
 *
 * Any other value (e.g. `idle`) is treated as `never` — the caller is opting
 * into Crabbox's own idle timeout rather than an active stop.
 */
export type CrabboxStopAfter = 'success' | 'always' | 'never';

function normalizeStopAfter(value: string | number | undefined): CrabboxStopAfter {
  if (value === undefined) return 'success';
  const v = String(value).toLowerCase();
  if (v === 'always') return 'always';
  if (v === 'never') return 'never';
  if (v === 'success') return 'success';
  // Unknown/idle policies defer to Crabbox idle reaping rather than active stop.
  return 'never';
}

/** Outcome of a cleanup decision for a completed Crabbox-backed task. */
export interface CrabboxCleanupDecision {
  /** When true, run `crabbox stop <leaseId>` to tear the box down now. */
  readonly stop: boolean;
  /** When true, the box stays up after a failure and debug commands should be surfaced. */
  readonly keepForDebug: boolean;
}

/**
 * Decide whether a completed task's Crabbox box should be stopped.
 *
 * Defaults: `stopAfter = success`, `keepOnFailure = true` — boxes do not leak
 * after success, but a failed task keeps its box for inspection by default.
 */
export function decideCrabboxCleanup(params: {
  stopAfter?: string | number;
  keepOnFailure?: boolean;
  succeeded: boolean;
}): CrabboxCleanupDecision {
  const stopAfter = normalizeStopAfter(params.stopAfter);
  const keepOnFailure = params.keepOnFailure ?? true;

  let stop: boolean;
  if (stopAfter === 'never') {
    stop = false;
  } else if (stopAfter === 'always') {
    stop = true;
  } else {
    // stopAfter === 'success'
    stop = params.succeeded ? true : !keepOnFailure;
  }

  return { stop, keepForDebug: !stop && !params.succeeded };
}

/**
 * Parse JSON from CLI stdout. Crabbox emits a single JSON object with `--json`,
 * but warmup may interleave human-readable lines, so fall back to the last line
 * that parses as an object.
 */
function parseJsonObject(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const tryParse = (text: string): Record<string, unknown> | null => {
    try {
      const value = JSON.parse(text);
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };
  const whole = tryParse(trimmed);
  if (whole) return whole;
  const lines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const parsed = tryParse(lines[i]);
    if (parsed) return parsed;
  }
  return null;
}

function coercePort(value: number | string | undefined): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

/**
 * Resolve a Crabbox-backed remote target into a ready SSH endpoint.
 *
 * 1. Warm up a box (create or find) via the Crabbox CLI.
 * 2. Poll `status --json --wait` until the box reports a reachable endpoint.
 * 3. Return a static SSH target plus durable lease metadata.
 *
 * @throws if a CLI step exits non-zero, status cannot be parsed, or the report
 * is missing `sshHost`, `sshUser`, or `sshKey`.
 */
export async function resolveCrabboxTarget(
  config: CrabboxResolverConfig,
  runner: CommandRunner = spawnCommandRunner,
): Promise<CrabboxResolvedTarget> {
  const warmup = await runner(config.crabboxCommand, buildWarmupArgs(config));
  if (warmup.exitCode !== 0) {
    throw new Error(
      `Crabbox warmup failed for target "${config.target}" (exit ${warmup.exitCode}): ${
        warmup.stderr.trim() || warmup.stdout.trim() || 'no output'
      }`,
    );
  }

  // Prefer a lease id/slug reported by warmup; otherwise fall back to the
  // configured target identifier for the status lookup.
  const warmupReport = parseJsonObject(warmup.stdout);
  const warmupId =
    (typeof warmupReport?.id === 'string' && warmupReport.id) ||
    (typeof warmupReport?.slug === 'string' && warmupReport.slug) ||
    config.target;

  const status = await runner(config.crabboxCommand, buildStatusArgs(config, warmupId));
  if (status.exitCode !== 0) {
    throw new Error(
      `Crabbox status failed for target "${config.target}" (exit ${status.exitCode}): ${
        status.stderr.trim() || status.stdout.trim() || 'no output'
      }`,
    );
  }

  const report = parseJsonObject(status.stdout) as CrabboxStatusReport | null;
  if (!report) {
    throw new Error(
      `Crabbox status returned no parseable JSON for target "${config.target}". Raw output: ${
        status.stdout.trim() || '(empty)'
      }`,
    );
  }

  const leaseId = report.id ?? report.slug ?? warmupId;
  const missing: string[] = [];
  if (!report.sshHost) missing.push('sshHost');
  if (!report.sshUser) missing.push('sshUser');
  if (!report.sshKey) missing.push('sshKey');
  if (missing.length > 0) {
    throw new Error(
      `Crabbox status for target "${config.target}" (lease ${leaseId}) did not report ${missing.join(
        ', ',
      )}; cannot build an SSH endpoint. Check the Crabbox provider lease and try again.`,
    );
  }

  const port = coercePort(report.sshPort);
  const target: ResolvedSshTarget = {
    host: report.sshHost as string,
    user: report.sshUser as string,
    sshKeyPath: report.sshKey as string,
    ...(port !== undefined ? { port } : {}),
  };

  const remoteLeaseMetadata: CrabboxRemoteLeaseMetadata = {
    provider: 'crabbox',
    leaseId,
    ...(report.slug ? { slug: report.slug } : {}),
    targetId: config.target,
    sshHost: target.host,
    sshUser: target.user,
    ...(port !== undefined ? { sshPort: port } : {}),
    sshKeyPath: target.sshKeyPath,
    ...(report.expiresAt ? { expiresAt: report.expiresAt } : {}),
    ...(config.stopAfter !== undefined ? { stopAfter: String(config.stopAfter) } : {}),
    ...(config.keepOnFailure !== undefined ? { keepOnFailure: config.keepOnFailure } : {}),
  };

  return { target, remoteLeaseMetadata };
}
