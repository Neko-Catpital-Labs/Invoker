import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FileAndDbLogger } from '../logger.js';

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe('FileAndDbLogger log rotation', () => {
  it('keeps the active log under the rotation size by moving full logs into shards', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'invoker-logger-rotation-'));
    const filePath = join(tempDir, 'invoker.log');
    const logger = new FileAndDbLogger({}, { filePath, rotateBytes: 2_000 });

    for (let i = 0; i < 200; i += 1) {
      logger.info('rotation line', { i, padding: 'p'.repeat(40) });
    }

    const names = readdirSync(tempDir);
    const shards = names.filter((name) => name !== 'invoker.log');
    expect(shards.length).toBeGreaterThan(0);
    expect(statSync(filePath).size).toBeLessThanOrEqual(2_000);
    for (const shard of shards) {
      expect(statSync(join(tempDir, shard)).size).toBeLessThanOrEqual(2_000);
    }
  });
});
