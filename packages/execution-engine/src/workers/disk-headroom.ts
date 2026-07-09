/**
 * Pure disk-headroom evaluation.
 *
 * This module is intentionally dependency-free so workers and tests can reuse it
 * without pulling in any I/O concerns.
 */

export interface DiskUsage {
  filesystem: string;
  blocks1024: number;
  usedBlocks1024: number;
  availableBlocks1024: number;
  usedPercent: number;
  mountedOn: string;
}

export type DiskHeadroomLevel = 'ok' | 'warn' | 'critical';

export interface DiskHeadroomThresholds {
  warnPercent: number;
  criticalPercent: number;
}

export interface DiskHeadroomEvaluation {
  label: string;
  level: DiskHeadroomLevel;
  usage: DiskUsage;
  thresholds: DiskHeadroomThresholds;
}

function parsePositiveInt(raw: string): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  return n;
}

function parsePercent(raw: string): number | null {
  if (!raw) return null;
  const m = /^(\d+)%$/.exec(raw.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  if (!Number.isFinite(n)) return null;
  return n;
}

/**
 * Parse the data row of `df -P -k <path>`. The `-P` flag guarantees one line
 * per filesystem. A mount point may contain spaces; everything after the 5th
 * column is rejoined into the mount path.
 */
export function parseDfOutput(output: string): DiskUsage | null {
  const lines = String(output)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;

  // `df -P` is stable: first line header, next line data.
  // Still tolerate wrappers adding trailing blank lines by taking last row.
  const row = lines[lines.length - 1]!;
  if (/^filesystem/i.test(row)) return null;

  const parts = row.split(/\s+/);
  if (parts.length < 6) return null;

  const filesystem = parts[0]!;
  const blocks1024 = parsePositiveInt(parts[1]!);
  const usedBlocks1024 = parsePositiveInt(parts[2]!);
  const availableBlocks1024 = parsePositiveInt(parts[3]!);
  const usedPercent = parsePercent(parts[4]!);
  const mountedOn = parts.slice(5).join(' ');

  if (
    !filesystem
    || blocks1024 === null
    || usedBlocks1024 === null
    || availableBlocks1024 === null
    || usedPercent === null
    || !mountedOn
  ) {
    return null;
  }

  return {
    filesystem,
    blocks1024,
    usedBlocks1024,
    availableBlocks1024,
    usedPercent,
    mountedOn,
  };
}

export function evaluateDiskHeadroom(
  usage: DiskUsage,
  thresholds: DiskHeadroomThresholds,
  label: string,
): DiskHeadroomEvaluation {
  const level: DiskHeadroomLevel = usage.usedPercent >= thresholds.criticalPercent
    ? 'critical'
    : usage.usedPercent >= thresholds.warnPercent
      ? 'warn'
      : 'ok';
  return { label, level, usage, thresholds };
}

export const DEFAULT_DISK_WARN_PERCENT = 85;
export const DEFAULT_DISK_CRITICAL_PERCENT = 95;
export const DEFAULT_DISK_CHECK_INTERVAL_MS = 5 * 60 * 1000;

function readPercent(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return fallback;
  return n;
}

/**
 * Resolve warn/critical thresholds from env (`INVOKER_DISK_WARN_PERCENT`,
 * `INVOKER_DISK_CRITICAL_PERCENT`), defaulting to 85/95. `criticalPercent` is
 * clamped to be >= `warnPercent` so the two tiers can never invert.
 */
export function resolveDiskHeadroomThresholds(
  env: NodeJS.ProcessEnv = process.env,
): DiskHeadroomThresholds {
  const warnPercent = readPercent(env.INVOKER_DISK_WARN_PERCENT, DEFAULT_DISK_WARN_PERCENT);
  const criticalRaw = readPercent(env.INVOKER_DISK_CRITICAL_PERCENT, DEFAULT_DISK_CRITICAL_PERCENT);
  const criticalPercent = Math.max(warnPercent, criticalRaw);
  return { warnPercent, criticalPercent };
}

/** Resolve the check interval (ms) from `INVOKER_DISK_CHECK_INTERVAL_MS`, default 5 min. */
export function resolveDiskCheckIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.INVOKER_DISK_CHECK_INTERVAL_MS;
  if (!raw) return DEFAULT_DISK_CHECK_INTERVAL_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DISK_CHECK_INTERVAL_MS;
  return n;
}
