import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

function makeLogPath(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'invoker-logger-error-'));
  return join(tempDir, 'nested', 'invoker.log');
}

function readRecord(filePath: string): Record<string, unknown> {
  const line = readFileSync(filePath, 'utf8').trimEnd();
  return JSON.parse(line) as Record<string, unknown>;
}

describe('FileAndDbLogger error serialization', () => {
  it('serializes Error instances in file-backed log fields', () => {
    const filePath = makeLogPath();
    const logger = new FileAndDbLogger({}, { filePath });

    logger.error('msg', { err: new Error('boom') });

    const record = readRecord(filePath) as {
      err: { message?: unknown; stack?: unknown };
    };
    expect(record.err.message).toBe('boom');
    expect(typeof record.err.stack).toBe('string');
    expect(record.err.stack).not.toBe('');
  });

  it('preserves plain object error shapes unchanged', () => {
    const filePath = makeLogPath();
    const logger = new FileAndDbLogger({}, { filePath });
    const err = { code: 'ERR_SQLITE_ERROR', errcode: 787 };

    logger.error('msg', { err });

    const record = readRecord(filePath);
    expect(record.err).toEqual(err);
  });
});
