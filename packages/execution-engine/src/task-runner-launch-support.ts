/**
 * Shared launch/lease timing helpers for the task runner.
 *
 * Isolating the timeout/heartbeat/SSH-retry constants here lets the phase
 * modules share identical launch semantics without importing task-runner.ts
 * (which would create a cycle).
 */

import { ATTEMPT_LEASE_MS } from '@invoker/contracts';

/** Keeps launch metadata fresh while `executor.start()` is awaited (SSH remote setup/provision can take minutes). */
export const PRE_START_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_EXECUTOR_START_TIMEOUT_MS = 10 * 60 * 1000;

export type StartupFailureMetadata = {
  workspacePath?: string;
  branch?: string;
  agentSessionId?: string;
  containerId?: string;
};

export function isRetryableSshStartupTransportError(err: unknown): boolean {
  const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
  const lower = message.toLowerCase();
  return lower.includes('exit=255')
    || lower.includes('ssh transport failed')
    || lower.includes('connection timed out')
    || lower.includes('operation timed out')
    || lower.includes('connection reset')
    || lower.includes('broken pipe')
    || lower.includes('banner exchange')
    || lower.includes('kex_exchange_identification')
    || lower.includes('remote session terminated unexpectedly');
}

export function nextLeaseExpiry(from: Date): Date {
  return new Date(from.getTime() + ATTEMPT_LEASE_MS);
}

export function getExecutorStartTimeoutMs(): number {
  const raw = process.env.INVOKER_EXECUTOR_START_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_EXECUTOR_START_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_EXECUTOR_START_TIMEOUT_MS;
  return parsed;
}
