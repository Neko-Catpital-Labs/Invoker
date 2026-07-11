import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OmpSessionDriver } from '../omp-session-driver.js';

const originalDbDir = process.env.INVOKER_DB_DIR;
const originalMaxStoredSessionBytes = process.env.INVOKER_MAX_STORED_OMP_SESSION_BYTES;

afterEach(() => {
  restoreEnv('INVOKER_DB_DIR', originalDbDir);
  restoreEnv('INVOKER_MAX_STORED_OMP_SESSION_BYTES', originalMaxStoredSessionBytes);
  vi.restoreAllMocks();
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('OmpSessionDriver', () => {
  it('stores raw stdout and returns it as readable text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omp-session-driver-'));
    process.env.INVOKER_DB_DIR = dir;
    try {
      const driver = new OmpSessionDriver();
      const raw = 'OMP answer text';

      expect(driver.processOutput('session-1', raw)).toBe(raw);
      expect(driver.loadSession('session-1')).toBe(raw);
      expect(driver.parseSession(raw)).toEqual([{ role: 'assistant', content: raw, timestamp: '' }]);
      expect(driver.inspectSession(raw)).toEqual({ state: 'finished' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports empty output as an error state', () => {
    const driver = new OmpSessionDriver();
    expect(driver.parseSession('')).toEqual([]);
    expect(driver.inspectSession('')).toEqual({ state: 'error', reason: 'Empty OMP session output' });
  });

  it('does not fail task output processing when session transcript storage fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omp-session-driver-unwritable-'));
    const dbRootFile = join(dir, 'db-root-file');
    process.env.INVOKER_DB_DIR = dbRootFile;
    writeFileSync(dbRootFile, 'not a directory');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const driver = new OmpSessionDriver();
      const raw = 'OMP answer text';

      expect(driver.processOutput('session-1', raw)).toBe(raw);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to store session transcript'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caps stored OMP transcripts while keeping process output unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omp-session-driver-truncate-'));
    process.env.INVOKER_DB_DIR = dir;
    process.env.INVOKER_MAX_STORED_OMP_SESSION_BYTES = '120';
    try {
      const driver = new OmpSessionDriver();
      const raw = `${'a'.repeat(100)}${'b'.repeat(100)}`;

      expect(driver.processOutput('session-1', raw)).toBe(raw);
      const stored = readFileSync(join(dir, 'agent-sessions', 'session-1.omp.txt'), 'utf-8');
      expect(Buffer.byteLength(stored, 'utf8')).toBeLessThanOrEqual(120);
      expect(stored).toContain('Invoker truncated stored OMP session output');
      expect(stored).toContain('aaa');
      expect(stored).toContain('bbb');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
