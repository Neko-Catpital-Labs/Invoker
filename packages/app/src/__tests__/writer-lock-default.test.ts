import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireDbWriterLock, findPreviousOwnerCrashDiagnostic } from '../db-writer-lock.js';

/**
 * Regression test: the DB writer lock must be engaged by default
 * when INVOKER_UNSAFE_DISABLE_DB_WRITER_LOCK is not set.
 */
describe('writer lock default-on', () => {
  let tmpDir: string;
  let dbPath: string;
  let previousDiagnosticDirs: string | undefined;

  beforeEach(() => {
    // Ensure the bypass env var is unset so we test the true default.
    delete process.env.INVOKER_UNSAFE_DISABLE_DB_WRITER_LOCK;
    previousDiagnosticDirs = process.env.INVOKER_DIAGNOSTIC_REPORT_DIRS;

    tmpDir = mkdtempSync(join(tmpdir(), 'writer-lock-default-test-'));
    dbPath = join(tmpDir, 'test.db');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousDiagnosticDirs === undefined) {
      delete process.env.INVOKER_DIAGNOSTIC_REPORT_DIRS;
    } else {
      process.env.INVOKER_DIAGNOSTIC_REPORT_DIRS = previousDiagnosticDirs;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('acquires the lock (not bypassed) when env var is unset', () => {
    const result = acquireDbWriterLock(dbPath);

    try {
      expect(result.acquired).toBe(true);
      expect(result.bypassed).toBe(false);
      expect(result.reclaimedDeadOwner).toBeNull();
    } finally {
      result.release();
    }
  });

  it('creates the lock directory on disk', () => {
    const lockDir = `${dbPath}.lock`;
    const result = acquireDbWriterLock(dbPath);

    try {
      expect(existsSync(lockDir)).toBe(true);
    } finally {
      result.release();
    }
  });

  it('removes the lock directory after release', () => {
    const lockDir = `${dbPath}.lock`;
    const result = acquireDbWriterLock(dbPath);
    result.release();

    expect(existsSync(lockDir)).toBe(false);
  });

  it('prevents a second lock acquisition while the first is held', () => {
    const first = acquireDbWriterLock(dbPath);

    try {
      expect(() => acquireDbWriterLock(dbPath)).toThrow(/already held/);
    } finally {
      first.release();
    }
  });

  it('reclaims the lock when the holder pid was recycled by a newer process', () => {
    mkdirSync(`${dbPath}.lock`);
    writeFileSync(`${dbPath}.lock/pid`, '999999');
    // Pid is "alive" (recycled by an unrelated process)…
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    // …but that process started well after the lock was written.
    const lock = acquireDbWriterLock(dbPath, 'test:recycled', null, () => Date.now() + 60_000);

    expect(lock.acquired).toBe(true);
    expect(lock.reclaimedDeadOwner?.pid).toBe(999999);
    lock.release();
  });

  it('still refuses when the holder is alive and its start time is unknown', () => {
    mkdirSync(`${dbPath}.lock`);
    writeFileSync(`${dbPath}.lock/pid`, '999999');
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    expect(() => acquireDbWriterLock(dbPath, 'test:unknown-start', null, () => null))
      .toThrow(/already held by PID 999999/);

    rmSync(`${dbPath}.lock`, { recursive: true, force: true });
  });

  it('finds a crash diagnostic for a stale owner pid', () => {
    const reportDir = join(tmpDir, 'diagnostics');
    mkdirSync(reportDir);
    const reportPath = join(reportDir, 'Electron-2026-06-01-113203.ips');
    writeFileSync(reportPath, [
      '{"app_name":"Electron","timestamp":"2026-06-01 11:32:03.00 +0800"}',
      JSON.stringify({
        pid: 2147483647,
        captureTime: '2026-06-01 11:31:59.2836 +0800',
        procLaunch: '2026-06-01 09:21:05.8849 +0800',
        procName: 'Electron',
        exception: {
          type: 'EXC_BAD_ACCESS',
          signal: 'SIGBUS',
          subtype: 'FS pagein error: 22 Invalid argument',
        },
        termination: {
          namespace: 'SIGNAL',
          indicator: 'Bus error: 10',
          code: 10,
        },
        ktriageinfo: 'APFS cluster_pagein failed\nVM vnode_pagein failed',
      }),
    ].join('\n'));

    const diagnostic = findPreviousOwnerCrashDiagnostic(2147483647, {
      searchDirs: [reportDir],
      nowMs: Date.now(),
      maxAgeMs: 24 * 60 * 60 * 1000,
    });

    expect(diagnostic).toMatchObject({
      pid: 2147483647,
      reportPath,
      exceptionSignal: 'SIGBUS',
      terminationIndicator: 'Bus error: 10',
    });
  });

  it('logs crash details when reclaiming a stale writer lock', () => {
    const deadPid = 2147483647;
    const lockDir = `${dbPath}.lock`;
    const reportDir = join(tmpDir, 'diagnostics');
    mkdirSync(lockDir);
    mkdirSync(reportDir);
    writeFileSync(join(lockDir, 'pid'), String(deadPid));
    writeFileSync(join(reportDir, 'Electron-stale-owner.ips'), [
      '{"app_name":"Electron","timestamp":"2026-06-01 11:32:03.00 +0800"}',
      JSON.stringify({
        pid: deadPid,
        captureTime: '2026-06-01 11:31:59.2836 +0800',
        exception: { type: 'EXC_BAD_ACCESS', signal: 'SIGBUS' },
        termination: { namespace: 'SIGNAL', indicator: 'Bus error: 10', code: 10 },
      }),
    ].join('\n'));
    process.env.INVOKER_DIAGNOSTIC_REPORT_DIRS = reportDir;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = acquireDbWriterLock(dbPath);

    try {
      expect(result.acquired).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Stale lock from dead PID 2147483647'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('signal=SIGBUS'));
      expect(result.reclaimedDeadOwner).toMatchObject({
        pid: deadPid,
        diagnostic: expect.objectContaining({
          reportPath: join(reportDir, 'Electron-stale-owner.ips'),
          exceptionSignal: 'SIGBUS',
        }),
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Bus error: 10'));
    } finally {
      result.release();
      warn.mockRestore();
    }
  });
});
