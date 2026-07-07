/**
 * Pure disk-headroom evaluation.
 *
 * Parses `df -P -k <path>` output and classifies filesystem usage against
 * warn/critical thresholds. No I/O here — the caller runs `df` (locally via
 * child_process or remotely over SSH) and feeds the text in, which keeps the
 * classification logic trivially unit-testable.
 *
 * This is observability only: it never blocks scheduling or fails tasks. Its
 * value is warning at ~85% used, while the disk (and the DB the alert is
 * written to) still works, instead of discovering a 100%-full box after tasks
 * have already wedged.
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
  message: string;
}

/**
 * Parse the data row of `df -P -k <path>`. The `-P` flag guarantees one line
 * per filesystem. A mount point may contain spaces; everything after the 5th
 * column is rejoined into the mount path.
 */
export function parseDfOutput(output: string): DiskUsage | null {
  const lines = output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < 2) return null;

  // `df -P -k <path>` should emit one header line + one data line.
  // Use the last non-empty line as the data row and ignore the header.
  const dataLine = lines[lines.length - 1];
  if (!dataLine) return null;
  if (/^Filesystem/i.test(dataLine)) return null;

  const parts = dataLine.split(/\s+/);
  if (parts.length < 6) return null;

  const filesystem = parts[0] ?? '';
  const blocks1024 = Number.parseInt(parts[1] ?? '', 10);
  const usedBlocks1024 = Number.parseInt(parts[2] ?? '', 10);
  const availableBlocks1024 = Number.parseInt(parts[3] ?? '', 10);
  const rawPercent = (parts[4] ?? '').replace(/%$/, '');
  const usedPercent = Number.parseInt(rawPercent, 10);
  const mountedOn = parts.slice(5).join(' ');

  if (!filesystem) return null;
  if (![blocks1024, usedBlocks1024, availableBlocks1024, usedPercent].every((n) => Number.isFinite(n))) return null;
  if (usedPercent < 0 || usedPercent > 100) return null;

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
  const warnPercent = thresholds.warnPercent;
  const criticalPercent = thresholds.criticalPercent;

  const level: DiskHeadroomLevel =
    usage.usedPercent >= criticalPercent
      ? 'critical'
      : usage.usedPercent >= warnPercent
        ? 'warn'
        : 'ok';

  const totalGb = Math.max(0, usage.blocks1024) / (1024 * 1024);
  const usedGb = Math.max(0, usage.usedBlocks1024) / (1024 * 1024);
  const availGb = Math.max(0, usage.availableBlocks1024) / (1024 * 1024);

  const message =
    level === 'ok'
      ? `${label}: ${usage.usedPercent}% used`
      : `${label}: ${usage.usedPercent}% used (used=${usedGb.toFixed(1)}GB avail=${availGb.toFixed(1)}GB total=${totalGb.toFixed(1)}GB, warn>=${warnPercent}% critical>=${criticalPercent}%)`;

  return { label, level, usage, thresholds: { warnPercent, criticalPercent }, message };
}

export const DEFAULT_DISK_WARN_PERCENT = 85;
export const DEFAULT_DISK_CRITICAL_PERCENT = 95;
export const DEFAULT_DISK_CHECK_INTERVAL_MS = 5 * 60 * 1000;

function readPercent(raw: string | undefined, fallback: number): number {
  const text = raw?.trim();
  if (!text) return fallback;
  const parsed = Number.parseInt(text, 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 0 || parsed > 100) return fallback;
  return parsed;
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
  const configuredCritical = readPercent(env.INVOKER_DISK_CRITICAL_PERCENT, DEFAULT_DISK_CRITICAL_PERCENT);
  const criticalPercent = Math.max(configuredCritical, warnPercent);
  return { warnPercent, criticalPercent };
}

/** Resolve the check interval (ms) from `INVOKER_DISK_CHECK_INTERVAL_MS`, default 5 min. */
export function resolveDiskCheckIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.INVOKER_DISK_CHECK_INTERVAL_MS?.trim();
  if (!raw) return DEFAULT_DISK_CHECK_INTERVAL_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DISK_CHECK_INTERVAL_MS;
  return parsed;
}
