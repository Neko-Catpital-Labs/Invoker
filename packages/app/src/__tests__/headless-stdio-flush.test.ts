import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildLargePayload } from './fixtures/large-json-payload.mjs';

// Regression test for the bug that silently truncated `--headless query
// workflows --output json`: process.stdout.write() to a pipe is asynchronous
// in Node, and process.exit() does not wait for it to flush, so payloads over
// the ~64KB OS pipe buffer get cut off when a parent process captures this
// process's stdout (e.g. via execFileSync, exactly as both fixtures below are
// invoked). This must spawn a real child process and read its stdout through
// a real OS pipe — an in-process call or a mocked stream cannot reproduce the
// race, which is exactly why no earlier test caught the original bug.
const buggyFixturePath = fileURLToPath(new URL('./fixtures/write-then-exit-buggy.mjs', import.meta.url));
const fixedFixturePath = fileURLToPath(new URL('./fixtures/write-then-flush-then-exit-fixed.mts', import.meta.url));
const expectedPayload = buildLargePayload();

describe('flushOutputStream regression (main.ts / headless-client.ts write-then-exit)', () => {
  it('the historical write-then-exit pattern truncates a large piped payload', () => {
    const result = execFileSync(process.execPath, [buggyFixturePath], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    expect(result.length).toBeLessThan(expectedPayload.length);
    expect(() => JSON.parse(result)).toThrow(/Unterminated string|Unexpected end of JSON input/);
  });

  it('flushOutputStream (the real, shared helper) prevents truncation of the same payload', () => {
    const result = execFileSync(process.execPath, [fixedFixturePath], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    expect(result.length).toBe(expectedPayload.length);
    expect(JSON.parse(result)).toEqual(JSON.parse(expectedPayload));
  });
});
