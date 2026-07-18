/**
 * Shared launch/lease timing helpers for the task-runner execution phases.
 *
 * Extracted from `task-runner.ts` so the prepare/dispatch/finalize phase
 * modules and the runner itself can share identical timeout, heartbeat, and
 * SSH-retry semantics without a circular import.
 */

import { ATTEMPT_LEASE_MS } from '@invoker/contracts';
import type { TaskState } from '@invoker/workflow-core';

/** Keeps launch metadata fresh while `executor.start()` is awaited (SSH remote setup/provision can take minutes). */
export const PRE_START_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_EXECUTOR_START_TIMEOUT_MS = 10 * 60 * 1000;

/** Subset of an executor-start rejection that may carry partial workspace/branch metadata. */
export type StartupFailureMetadata = {
  workspacePath?: string;
  branch?: string;
  agentSessionId?: string;
  containerId?: string;
  stdout?: unknown;
  stderr?: unknown;
};

const STARTUP_DIAGNOSTIC_DETAIL_CHARS = 4_000;

function truncateStartupDiagnosticValue(value: string): string {
  if (value.length <= STARTUP_DIAGNOSTIC_DETAIL_CHARS) return value;
  return `...${value.slice(value.length - STARTUP_DIAGNOSTIC_DETAIL_CHARS)}`;
}

function stringifyStartupDiagnosticValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

export function formatStartupFailureDiagnostic(
  task: TaskState,
  executorType: string,
  err: unknown,
): string {
  const meta = err as StartupFailureMetadata;
  const message = err instanceof Error ? err.message : String(err);
  const stderr = stringifyStartupDiagnosticValue(meta.stderr);
  const stdout = stringifyStartupDiagnosticValue(meta.stdout);
  const parts = [
    '\n[Startup Failure Diagnostic]',
    `status=${task.status}`,
    `executor=${executorType}`,
    `message=${message}`,
  ];
  if (stderr) {
    parts.push(`--- startup stderr ---\n${truncateStartupDiagnosticValue(stderr)}`);
  }
  if (stdout) {
    parts.push(`--- startup stdout ---\n${truncateStartupDiagnosticValue(stdout)}`);
  }
  parts.push('--- end startup failure diagnostic ---\n');
  return parts.join('\n');
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

export const POOL_MEMBER_COOLDOWN_BASE_MS = 30_000;
export const POOL_MEMBER_COOLDOWN_MAX_MS = 5 * 60_000;

export function computePoolMemberCooldownMs(consecutiveFailures: number): number {
  const n = Math.max(1, Math.floor(consecutiveFailures));
  const raw = POOL_MEMBER_COOLDOWN_BASE_MS * 2 ** (n - 1);
  return Math.min(raw, POOL_MEMBER_COOLDOWN_MAX_MS);
}

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
