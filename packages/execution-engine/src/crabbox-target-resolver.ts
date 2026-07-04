import { spawn } from 'node:child_process';
import type { CrabboxRemoteLeaseMetadata } from '@invoker/workflow-core';

/**
 * Resolve a Crabbox-leased machine into a ready-to-use SSH endpoint.
 *
 * Crabbox owns machine supply: a warmup call creates or finds the leased
 * machine, then a status call (with `--wait`) blocks until the lease is
 * reachable and reports its SSH coordinates. This resolver runs those two
 * Crabbox subcommands and turns the result into a static SSH target plus the
 * durable lease metadata Invoker persists for cleanup and terminal restore.
 *
 * It does NOT create an SshExecutor or run any task; callers feed the returned
 * target into the normal SSH execution path. Crabbox stays a machine supplier;
 * Invoker stays the workflow and SSH executor owner.
 */

/** Result of running a single Crabbox CLI invocation. */
export interface CrabboxCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Runs one Crabbox CLI invocation. Injected so tests can drive the resolver
 * without spawning a real process. Defaults to {@link spawnCrabboxCommand}.
 */
export type CrabboxCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<CrabboxCommandResult>;

/**
 * Crabbox lease inputs the resolver needs to warm up and inspect a target.
 *
 * Mirrors the configured `type: 'crabbox'` remote target, but is declared
 * locally so execution-engine does not depend on the app config package.
 */
export interface CrabboxResolverTargetConfig {
  /** Config key of the remote target. Named in errors and lease metadata. */
  readonly id: string;
  /** CLI entrypoint that creates/inspects Crabbox leases. */
  readonly crabboxCommand: string;
  /** Crabbox provider to lease from. */
  readonly provider: string;
  /** Machine class/size to lease. */
  readonly class: string;
  /** Lease time-to-live (e.g. '30m'). */
  readonly ttl: string;
  /** Idle timeout before the lease auto-stops (e.g. '10m'). */
  readonly idleTimeout: string;
  /** Network to attach the leased machine to. */
  readonly network: string;
  /** Crabbox target selector for the lease. */
  readonly target: string;
  /** When to stop the lease after the task settles (e.g. 'completed', 'never'). */
  readonly stopAfter: string;
  /** Keep the lease alive on failure for debugging instead of stopping it. */
  readonly keepOnFailure: boolean;
  /** SSH port to fall back to when the lease status omits one. Default: 22. */
  readonly port?: number;
  /** Optional extra args appended to the warmup subcommand. */
  readonly warmupArgs?: readonly string[];
  /** Optional extra args appended to the status subcommand. */
  readonly statusArgs?: readonly string[];
  /** Optional extra args appended to the stop subcommand. */
  readonly stopArgs?: readonly string[];
}

/**
 * Inputs needed to stop (clean up) a Crabbox lease. A subset of
 * {@link CrabboxResolverTargetConfig}: stopping only needs the CLI entrypoint,
 * the target id (for error messages), and any configured stop args.
 */
export interface CrabboxStopConfig {
  /** Config key of the remote target. Named in errors. */
  readonly id: string;
  /** CLI entrypoint that stops Crabbox leases. */
  readonly crabboxCommand: string;
  /** Optional extra args appended to the stop subcommand. */
  readonly stopArgs?: readonly string[];
}

/**
 * Inputs needed to refresh (re-inspect) an existing Crabbox lease for terminal
 * restore. Unlike {@link resolve}, this never warms up a new machine: it only
 * runs a status call against a lease id/slug persisted earlier, so it needs
 * just the CLI entrypoint, the target id (for errors), any status args, and a
 * fallback SSH port.
 */
export interface CrabboxRefreshConfig {
  /** Config key of the remote target. Named in errors. */
  readonly id: string;
  /** CLI entrypoint that inspects Crabbox leases. */
  readonly crabboxCommand: string;
  /** Optional extra args appended to the status subcommand. */
  readonly statusArgs?: readonly string[];
  /** SSH port to fall back to when the lease status omits one. Default: 22. */
  readonly port?: number;
}

/** When to stop a Crabbox lease relative to the task's final status. */
export type CrabboxStopAfter = 'success' | 'failure' | 'always' | 'never';

/** Crabbox should not leak machines by default: stop on success. */
export const DEFAULT_CRABBOX_STOP_AFTER: CrabboxStopAfter = 'success';
/** Failed tasks keep their machine by default so they can be debugged. */
export const DEFAULT_CRABBOX_KEEP_ON_FAILURE = true;

/** Normalized cleanup policy for a Crabbox lease. */
export interface CrabboxCleanupPolicy {
  readonly stopAfter: CrabboxStopAfter;
  readonly keepOnFailure: boolean;
}

/**
 * Apply default Crabbox cleanup policy to raw (possibly missing/legacy) config.
 *
 * Defaults: `stopAfter` → 'success' (don't leak machines), `keepOnFailure` →
 * true (preserve failed machines for debugging). The legacy `'completed'`
 * value is treated as `'success'`.
 */
export function resolveCrabboxCleanupPolicy(
  stopAfter: string | undefined,
  keepOnFailure: boolean | undefined,
): CrabboxCleanupPolicy {
  return {
    stopAfter: normalizeStopAfter(stopAfter),
    keepOnFailure: keepOnFailure ?? DEFAULT_CRABBOX_KEEP_ON_FAILURE,
  };
}

function normalizeStopAfter(value: string | undefined): CrabboxStopAfter {
  switch (value) {
    case 'success':
    case 'failure':
    case 'always':
    case 'never':
      return value;
    case 'completed':
      // Legacy alias from earlier config: stop once the task completes ok.
      return 'success';
    default:
      return DEFAULT_CRABBOX_STOP_AFTER;
  }
}

/**
 * Decide whether to stop a Crabbox lease given its policy and the task's
 * outcome. `keepOnFailure` wins on failure (debug-preserving), so a failed
 * task with `keepOnFailure` is never stopped regardless of `stopAfter`.
 */
export function shouldStopCrabboxLease(
  policy: CrabboxCleanupPolicy,
  succeeded: boolean,
): boolean {
  if (!succeeded && policy.keepOnFailure) return false;
  switch (policy.stopAfter) {
    case 'always':
      return true;
    case 'never':
      return false;
    case 'success':
      return succeeded;
    case 'failure':
      return !succeeded;
  }
}

/** A fixed SSH host the SSH executor can connect to directly. */
export interface ResolvedSshTarget {
  readonly host: string;
  readonly user: string;
  /** Path to the SSH identity file (private key). */
  readonly sshKeyPath: string;
  readonly port: number;
}

/** A resolved Crabbox lease: a ready SSH target plus durable lease metadata. */
export interface ResolvedCrabboxTarget {
  readonly sshTarget: ResolvedSshTarget;
  readonly remoteLeaseMetadata: CrabboxRemoteLeaseMetadata;
}

/** Subset of Crabbox `status --json` fields the resolver reads. */
interface CrabboxStatusJson {
  id?: unknown;
  slug?: unknown;
  provider?: unknown;
  status?: unknown;
  expiresAt?: unknown;
  sshHost?: unknown;
  sshUser?: unknown;
  sshPort?: unknown;
  sshKey?: unknown;
}

const DEFAULT_SSH_PORT = 22;

/** Lease states that are still SSH-reachable and safe to restore a terminal to. */
const CRABBOX_READY_STATES = new Set(['ready', 'running', 'active']);
/** Lease states meaning the machine is gone and cannot be restored. */
const CRABBOX_DEAD_STATES = new Set([
  'expired',
  'stopped',
  'terminated',
  'deleted',
  'gone',
  'released',
]);

/** Default runner: spawn the Crabbox CLI and collect its output. */
export function spawnCrabboxCommand(
  command: string,
  args: readonly string[],
): Promise<CrabboxCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args as string[], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}

/**
 * Build the warmup args that create or find the leased machine.
 *
 * Includes only the lease shape (provider/class/ttl/idle/network/target) plus
 * any caller-supplied warmupArgs — status flags belong on the status call.
 */
export function buildCrabboxWarmupArgs(
  config: CrabboxResolverTargetConfig,
): string[] {
  return [
    'warmup',
    '--provider',
    config.provider,
    '--class',
    config.class,
    '--ttl',
    config.ttl,
    '--idle-timeout',
    config.idleTimeout,
    '--network',
    config.network,
    '--target',
    config.target,
    ...(config.warmupArgs ?? []),
  ];
}

/**
 * Build the status args that report a lease's SSH coordinates as JSON.
 * `leaseRef` is the id or slug returned by warmup. By default the call blocks
 * (`--wait`) until the lease is reachable, which is what initial resolution
 * wants. Terminal restore passes `{ wait: false }` so a dead or not-ready lease
 * is reported immediately instead of blocking the terminal open.
 */
export function buildCrabboxStatusArgs(
  config: { readonly statusArgs?: readonly string[] },
  leaseRef: string,
  opts: { readonly wait?: boolean } = {},
): string[] {
  const wait = opts.wait ?? true;
  return [
    'status',
    '--id',
    leaseRef,
    '--json',
    ...(wait ? ['--wait'] : []),
    ...(config.statusArgs ?? []),
  ];
}

/**
 * Build the stop args that tear down a lease: `stop <leaseId>` plus any
 * caller-supplied stopArgs.
 */
export function buildCrabboxStopArgs(
  config: CrabboxStopConfig,
  leaseId: string,
): string[] {
  return ['stop', leaseId, ...(config.stopArgs ?? [])];
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Resolves Crabbox remote targets into ready SSH endpoints.
 *
 * The command runner is injectable so tests (and alternate transports) can
 * supply Crabbox output without spawning a process.
 */
export class CrabboxTargetResolver {
  private readonly run: CrabboxCommandRunner;

  constructor(run: CrabboxCommandRunner = spawnCrabboxCommand) {
    this.run = run;
  }

  async resolve(
    config: CrabboxResolverTargetConfig,
  ): Promise<ResolvedCrabboxTarget> {
    const warmup = await this.run(
      config.crabboxCommand,
      buildCrabboxWarmupArgs(config),
    );
    if (warmup.exitCode !== 0) {
      throw new Error(
        `Crabbox warmup failed for remote target "${config.id}" (exit ${warmup.exitCode}): ${warmup.stderr.trim() || warmup.stdout.trim()}`,
      );
    }
    const leaseRef = this.parseLeaseRef(config, warmup);

    const status = await this.run(
      config.crabboxCommand,
      buildCrabboxStatusArgs(config, leaseRef),
    );
    if (status.exitCode !== 0) {
      throw new Error(
        `Crabbox status failed for remote target "${config.id}" (exit ${status.exitCode}): ${status.stderr.trim() || status.stdout.trim()}`,
      );
    }
    return this.buildResolvedTarget(config, status, leaseRef);
  }

  /**
   * Stop (release) a Crabbox lease via `crabbox stop <leaseId>`. Throws an
   * actionable error when the stop command exits non-zero so callers can log
   * a cleanup failure without re-deriving the lease.
   */
  async stop(config: CrabboxStopConfig, leaseId: string): Promise<void> {
    const result = await this.run(
      config.crabboxCommand,
      buildCrabboxStopArgs(config, leaseId),
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Crabbox stop failed for lease "${leaseId}" on remote target "${config.id}" ` +
          `(exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
  }

  /**
   * Re-inspect an already-leased machine and return a fresh SSH endpoint,
   * without warming up a new one. Used to restore a terminal after restart:
   * the lease id/slug was persisted, so a single status call (no `--wait`)
   * gives the current SSH coordinates.
   *
   * Throws an actionable error — caught by the terminal opener and surfaced as
   * a refusal — when the lease is missing/unreachable, expired or stopped, not
   * yet ready, or no longer reports the SSH fields needed to connect.
   */
  async refreshLease(
    config: CrabboxRefreshConfig,
    leaseRef: string,
  ): Promise<ResolvedSshTarget> {
    const status = await this.run(
      config.crabboxCommand,
      buildCrabboxStatusArgs(config, leaseRef, { wait: false }),
    );
    if (status.exitCode !== 0) {
      throw new Error(
        `Crabbox lease "${leaseRef}" for remote target "${config.id}" is missing or unreachable ` +
          `(exit ${status.exitCode}): ${status.stderr.trim() || status.stdout.trim() || 'no output'}.`,
      );
    }

    const json = tryParseJson(status.stdout.trim());
    if (!json) {
      throw new Error(
        `Crabbox status for lease "${leaseRef}" on remote target "${config.id}" did not return valid JSON.`,
      );
    }

    const state = asNonEmptyString(json.status)?.toLowerCase();
    if (state && CRABBOX_DEAD_STATES.has(state)) {
      throw new Error(
        `Crabbox lease "${leaseRef}" for remote target "${config.id}" has expired or been stopped (status: ${state}).`,
      );
    }
    if (state && !CRABBOX_READY_STATES.has(state)) {
      throw new Error(
        `Crabbox lease "${leaseRef}" for remote target "${config.id}" is not ready (status: ${state}).`,
      );
    }

    const sshHost = asNonEmptyString(json.sshHost);
    const sshUser = asNonEmptyString(json.sshUser);
    const sshKeyPath = asNonEmptyString(json.sshKey);
    const missing: string[] = [];
    if (!sshHost) missing.push('sshHost');
    if (!sshUser) missing.push('sshUser');
    if (!sshKeyPath) missing.push('sshKey');
    if (missing.length > 0) {
      throw new Error(
        `Crabbox lease "${leaseRef}" for remote target "${config.id}" is missing required SSH field(s): ${missing.join(', ')}. ` +
          `Cannot rebuild an SSH endpoint for this lease.`,
      );
    }

    const sshPort =
      typeof json.sshPort === 'number' && Number.isFinite(json.sshPort)
        ? json.sshPort
        : (config.port ?? DEFAULT_SSH_PORT);

    return {
      host: sshHost as string,
      user: sshUser as string,
      sshKeyPath: sshKeyPath as string,
      port: sshPort,
    };
  }

  /** Read the lease id (or slug) that warmup printed for the status call. */
  private parseLeaseRef(
    config: CrabboxResolverTargetConfig,
    warmup: CrabboxCommandResult,
  ): string {
    const text = warmup.stdout.trim();
    const parsed = tryParseJson(text);
    if (parsed) {
      const ref = asNonEmptyString(parsed.id) ?? asNonEmptyString(parsed.slug);
      if (ref) return ref;
    } else if (text.length > 0) {
      // Tolerate a plain id/slug printed on stdout.
      return text;
    }
    throw new Error(
      `Crabbox warmup for remote target "${config.id}" did not return a lease id or slug.`,
    );
  }

  private buildResolvedTarget(
    config: CrabboxResolverTargetConfig,
    status: CrabboxCommandResult,
    leaseRef: string,
  ): ResolvedCrabboxTarget {
    const json = tryParseJson(status.stdout.trim());
    if (!json) {
      throw new Error(
        `Crabbox status for remote target "${config.id}" did not return valid JSON.`,
      );
    }

    const sshHost = asNonEmptyString(json.sshHost);
    const sshUser = asNonEmptyString(json.sshUser);
    const sshKeyPath = asNonEmptyString(json.sshKey);
    const missing: string[] = [];
    if (!sshHost) missing.push('sshHost');
    if (!sshUser) missing.push('sshUser');
    if (!sshKeyPath) missing.push('sshKey');
    if (missing.length > 0) {
      throw new Error(
        `Crabbox status for remote target "${config.id}" is missing required SSH field(s): ${missing.join(', ')}. ` +
          `Cannot build an SSH endpoint for this lease.`,
      );
    }

    const sshPort =
      typeof json.sshPort === 'number' && Number.isFinite(json.sshPort)
        ? json.sshPort
        : (config.port ?? DEFAULT_SSH_PORT);
    const leaseId = asNonEmptyString(json.id) ?? leaseRef;
    const slug = asNonEmptyString(json.slug) ?? leaseId;
    const expiresAt = asNonEmptyString(json.expiresAt) ?? '';

    return {
      sshTarget: {
        host: sshHost as string,
        user: sshUser as string,
        sshKeyPath: sshKeyPath as string,
        port: sshPort,
      },
      remoteLeaseMetadata: {
        provider: 'crabbox',
        leaseId,
        slug,
        targetId: config.id,
        sshHost: sshHost as string,
        sshUser: sshUser as string,
        sshPort,
        sshKeyPath: sshKeyPath as string,
        expiresAt,
        stopAfter: config.stopAfter,
        keepOnFailure: config.keepOnFailure,
      },
    };
  }
}

function tryParseJson(text: string): CrabboxStatusJson | null {
  if (!text.startsWith('{') && !text.startsWith('[')) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? (value as CrabboxStatusJson) : null;
  } catch {
    return null;
  }
}
