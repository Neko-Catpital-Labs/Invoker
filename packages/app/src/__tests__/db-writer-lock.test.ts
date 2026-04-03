import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireDbWriterLock, releaseDbWriterLock } from '../db-writer-lock.js';

describe('db writer lock', () => {
  it('prevents a second writer lock for the same DB root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'invoker-lock-'));
    try {
      const first = acquireDbWriterLock(dir);
      expect(first).not.toBeNull();

      expect(() => acquireDbWriterLock(dir)).toThrow(/Another Invoker writer process is active/);

      releaseDbWriterLock(first);

      const second = acquireDbWriterLock(dir);
      expect(second).not.toBeNull();
      releaseDbWriterLock(second);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
