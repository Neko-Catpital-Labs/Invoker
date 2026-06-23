import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OmpSessionDriver } from '../omp-session-driver.js';

const originalDbDir = process.env.INVOKER_DB_DIR;

afterEach(() => {
  process.env.INVOKER_DB_DIR = originalDbDir;
});

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
});
