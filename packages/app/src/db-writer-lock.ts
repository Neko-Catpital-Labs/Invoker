/**
 * DB Writer Lock — prevents concurrent writable access to the SQLite database file.
 *
 * Enabled by default. Bypass with INVOKER_UNSAFE_DISABLE_DB_WRITER_LOCK=1 (test/dev only).
 *
 * Uses mkdir-based locking (atomic on POSIX) with a PID sentinel file for diagnostics.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

const ENV_BYPASS = 'INVOKER_UNSAFE_DISABLE_DB_WRITER_LOCK';
const ENV_DIAGNOSTIC_REPORT_DIRS = 'INVOKER_DIAGNOSTIC_REPORT_DIRS';
const DIAGNOSTIC_REPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface PreviousOwnerCrashDiagnostic {
  pid: number;
  reportPath: string;
  captureTime?: string;
  procLaunch?: string;
  procName?: string;
  exceptionType?: string;
  exceptionSignal?: string;
  exceptionSubtype?: string;
  terminationNamespace?: string;
  terminationIndicator?: string;
  terminationCode?: number;
  ktriageInfo?: string;
}

export interface ReclaimedDeadOwnerInfo {
  pid: number;
  diagnostic: PreviousOwnerCrashDiagnostic | null;
}

export interface DbWriterLockResult {
  /** True when the lock was acquired (or bypassed). */
  acquired: true;
  /** True when the lock was bypassed via env var. */
  bypassed: boolean;
  /** Previous dead owner details when this acquisition reclaimed a stale lock. */
  reclaimedDeadOwner: ReclaimedDeadOwnerInfo | null;
  /** Release the lock. No-op if bypassed. */
  release: () => void;
}

function diagnosticReportDirs(): string[] {
  const configured = process.env[ENV_DIAGNOSTIC_REPORT_DIRS];
  if (configured) {
    return configured.split(delimiter).map((dir) => dir.trim()).filter(Boolean);
  }
  if (process.platform !== 'darwin') return [];
  return [
    join(homedir(), 'Library', 'Logs', 'DiagnosticReports'),
    '/Library/Logs/DiagnosticReports',
  ];
}

function compactDiagnosticText(value: unknown, maxLength = 240): string | undefined {
  if (typeof value !== 'string') return undefined;
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return undefined;
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}

function parseDiagnosticReport(reportPath: string, pid: number): PreviousOwnerCrashDiagnostic | null {
  try {
    const raw = readFileSync(reportPath, 'utf8');
    const bodyStart = raw.indexOf('\n{');
    const jsonText = bodyStart >= 0 ? raw.slice(bodyStart + 1) : raw;
    const report = JSON.parse(jsonText) as {
      pid?: unknown;
      captureTime?: unknown;
      procLaunch?: unknown;
      procName?: unknown;
      exception?: {
        type?: unknown;
        signal?: unknown;
        subtype?: unknown;
      };
      termination?: {
        namespace?: unknown;
        indicator?: unknown;
        code?: unknown;
      };
      ktriageinfo?: unknown;
    };
    if (Number(report.pid) !== pid) return null;
    return {
      pid,
      reportPath,
      captureTime: typeof report.captureTime === 'string' ? report.captureTime : undefined,
      procLaunch: typeof report.procLaunch === 'string' ? report.procLaunch : undefined,
      procName: typeof report.procName === 'string' ? report.procName : undefined,
      exceptionType: typeof report.exception?.type === 'string' ? report.exception.type : undefined,
      exceptionSignal: typeof report.exception?.signal === 'string' ? report.exception.signal : undefined,
      exceptionSubtype: compactDiagnosticText(report.exception?.subtype),
      terminationNamespace: typeof report.termination?.namespace === 'string' ? report.termination.namespace : undefined,
      terminationIndicator: typeof report.termination?.indicator === 'string' ? report.termination.indicator : undefined,
      terminationCode: typeof report.termination?.code === 'number' ? report.termination.code : undefined,
      ktriageInfo: compactDiagnosticText(report.ktriageinfo),
    };
  } catch {
    return null;
  }
}

export function findPreviousOwnerCrashDiagnostic(
  pid: number,
  options: { searchDirs?: string[]; nowMs?: number; maxAgeMs?: number } = {},
): PreviousOwnerCrashDiagnostic | null {
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DIAGNOSTIC_REPORT_MAX_AGE_MS;
  const minMtimeMs = nowMs - maxAgeMs;
  const candidates: Array<{ path: string; mtimeMs: number }> = [];

  for (const dir of options.searchDirs ?? diagnosticReportDirs()) {
    try {
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (!/\.(ips|crash)$/i.test(name)) continue;
        if (!/electron|invoker/i.test(name)) continue;
        const reportPath = join(dir, name);
        const stat = statSync(reportPath);
        if (!stat.isFile() || stat.mtimeMs < minMtimeMs) continue;
        candidates.push({ path: reportPath, mtimeMs: stat.mtimeMs });
      }
    } catch {
      // Best effort: diagnostics must never block lock acquisition.
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const candidate of candidates.slice(0, 200)) {
    const diagnostic = parseDiagnosticReport(candidate.path, pid);
    if (diagnostic) return diagnostic;
  }
  return null;
}

export function formatPreviousOwnerCrashDiagnostic(diagnostic: PreviousOwnerCrashDiagnostic): string {
  const parts = [
    `previous owner crash diagnostic report=${diagnostic.reportPath}`,
    diagnostic.captureTime ? `captureTime="${diagnostic.captureTime}"` : undefined,
    diagnostic.procLaunch ? `procLaunch="${diagnostic.procLaunch}"` : undefined,
    diagnostic.exceptionType ? `exception=${diagnostic.exceptionType}` : undefined,
    diagnostic.exceptionSignal ? `signal=${diagnostic.exceptionSignal}` : undefined,
    diagnostic.exceptionSubtype ? `subtype="${diagnostic.exceptionSubtype}"` : undefined,
    diagnostic.terminationNamespace || diagnostic.terminationIndicator
      ? `termination=${diagnostic.terminationNamespace ?? '<unknown>'}/${diagnostic.terminationIndicator ?? '<unknown>'}`
      : undefined,
    diagnostic.terminationCode !== undefined ? `terminationCode=${diagnostic.terminationCode}` : undefined,
    diagnostic.ktriageInfo ? `ktriage="${diagnostic.ktriageInfo}"` : undefined,
  ].filter(Boolean);
  return parts.join(' ');
}

/**
 * Acquire an exclusive writer lock for the given database path.
 *
 * @param dbPath — path to the SQLite database file (e.g. `invoker.db`).
 * @returns lock handle with a `release()` method.
 * @throws if another process already holds the lock.
 */
export function acquireDbWriterLock(
  dbPath: string,
  callerContext?: string,
  reclaimedDeadOwner: ReclaimedDeadOwnerInfo | null = null,
): DbWriterLockResult {
  const bypassed = process.env[ENV_BYPASS] === '1';
  const lockDir = `${dbPath}.lock`;
  const callerTag = callerContext ? ` caller=${callerContext}` : '';

  if (bypassed) {
    return { acquired: true, bypassed: true, reclaimedDeadOwner: null, release: () => {} };
  }

  try {
    mkdirSync(lockDir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      // Check if the holding process is still alive (stale lock detection).
      const pidFile = `${lockDir}/pid`;
      let holder = 'unknown';
      if (existsSync(pidFile)) {
        try {
          holder = readFileSync(pidFile, 'utf-8').trim();
          const holderPid = parseInt(holder, 10);
          if (!isNaN(holderPid)) {
            try {
              process.kill(holderPid, 0); // signal 0 = check if alive
            } catch {
              // Holding process is dead — stale lock from a crash.
              const diagnostic = findPreviousOwnerCrashDiagnostic(holderPid);
              const diagnosticSuffix = diagnostic
                ? `; ${formatPreviousOwnerCrashDiagnostic(diagnostic)}`
                : '; no matching owner crash report found';
              console.warn(`[db-writer-lock] Stale lock from dead PID ${holderPid}, reclaiming${callerTag}${diagnosticSuffix}`);
              rmSync(lockDir, { recursive: true, force: true });
              return acquireDbWriterLock(dbPath, callerContext, { pid: holderPid, diagnostic });
            }
          }
        } catch { /* best effort */ }
      }
      throw new Error(
        `[db-writer-lock] Cannot acquire writer lock for ${dbPath} — ` +
        `already held by PID ${holder}. ` +
        `requested by${callerTag || ' <unknown>'}. ` +
        `If the previous process crashed, remove ${lockDir} manually.`,
      );
    }
    throw err;
  }

  // Write PID for diagnostics
  try {
    writeFileSync(`${lockDir}/pid`, String(process.pid));
  } catch { /* non-fatal — lock is already held via mkdir */ }

  console.log(`[db-writer-lock] Acquired exclusive writer lock (PID ${process.pid})${callerTag}`);

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      rmSync(lockDir, { recursive: true, force: true });
    } catch { /* best effort on shutdown */ }
  };

  return { acquired: true, bypassed: false, reclaimedDeadOwner, release };
}
