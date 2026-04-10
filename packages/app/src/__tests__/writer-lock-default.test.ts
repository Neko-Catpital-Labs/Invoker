import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireDbWriterLock } from '../db-writer-lock.js';

/**
 * Regression test: the DB writer lock must be engaged by default
 * when INVOKER_UNSAFE_DISABLE_DB_WRITER_LOCK is not set.
 */
describe('writer lock default-on', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    // Ensure the bypass env var is unset so we test the true default.
    delete process.env.INVOKER_UNSAFE_DISABLE_DB_WRITER_LOCK;

    tmpDir = mkdtempSync(join(tmpdir(), 'writer-lock-default-test-'));
    dbPath = join(tmpDir, 'test.db');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('acquires the lock (not bypassed) when env var is unset', () => {
    const result = acquireDbWriterLock(dbPath);

    try {
      expect(result.acquired).toBe(true);
      expect(result.bypassed).toBe(false);
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
});
