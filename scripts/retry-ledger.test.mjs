import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { shouldRetry, isStale } from './retry-ledger.mjs';

const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'retry-ledger.mjs');
const STALE_OBSERVATION_MS = 3 * 24 * 60 * 60 * 1000;

describe('shouldRetry', () => {
  it('files when there are no prior attempts', () => {
    const result = shouldRetry({ attempts: 0, lastAttemptAt: null, nowMs: 1000, maxAttempts: 3, backoffBaseMs: 1_800_000 });
    assert.deepEqual(result, { action: 'file', attempts: 0 });
  });

  it('backs off when still inside the exponential backoff window', () => {
    const lastAttemptAt = new Date(1_000_000).toISOString();
    const result = shouldRetry({
      attempts: 1,
      lastAttemptAt,
      nowMs: 1_000_000 + 1_800_000, // exactly at the 2^1 * base boundary, still short of it below
      maxAttempts: 3,
      backoffBaseMs: 1_800_000,
    });
    assert.equal(result.action, 'backoff');
    assert.equal(result.attempts, 1);
    assert.equal(result.backoffUntilMs, 1_000_000 + 1_800_000 * 2);
  });

  it('files again once the backoff window has passed', () => {
    const lastAttemptAt = new Date(1_000_000).toISOString();
    const result = shouldRetry({
      attempts: 1,
      lastAttemptAt,
      nowMs: 1_000_000 + 1_800_000 * 2 + 1,
      maxAttempts: 3,
      backoffBaseMs: 1_800_000,
    });
    assert.deepEqual(result, { action: 'file', attempts: 1 });
  });

  it('needs-human once attempts reach the cap, regardless of backoff timing', () => {
    const result = shouldRetry({ attempts: 3, lastAttemptAt: null, nowMs: 1000, maxAttempts: 3, backoffBaseMs: 1_800_000 });
    assert.deepEqual(result, { action: 'needs-human', attempts: 3 });
  });
});

describe('isStale', () => {
  it('is false just inside the window and true just past it', () => {
    const lastObservedAt = '2026-08-06T01:21:00.000Z';
    const lastObservedMs = new Date(lastObservedAt).getTime();
    assert.equal(
      isStale({ lastObservedAt, nowMs: lastObservedMs + STALE_OBSERVATION_MS - 1, staleMs: STALE_OBSERVATION_MS }),
      false,
    );
    assert.equal(
      isStale({ lastObservedAt, nowMs: lastObservedMs + STALE_OBSERVATION_MS + 1, staleMs: STALE_OBSERVATION_MS }),
      true,
    );
  });
});

describe('CLI (e2e, real subprocess)', () => {
  it('decide reads --json and prints the decision to stdout', () => {
    const input = JSON.stringify({
      attempts: 2,
      lastAttemptAt: '2026-08-14T09:41:32Z',
      nowMs: Date.parse('2026-08-14T09:41:32Z') + 1_800_000 * 4 + 1,
      maxAttempts: 3,
      backoffBaseMs: 1_800_000,
    });
    const result = spawnSync(process.execPath, [SCRIPT_PATH, 'decide', '--json', input], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { action: 'file', attempts: 2 });
  });

  it('decide reads JSON from stdin when --json is not given', () => {
    const input = JSON.stringify({ attempts: 0, lastAttemptAt: null, nowMs: 1000, maxAttempts: 3, backoffBaseMs: 1_800_000 });
    const result = spawnSync(process.execPath, [SCRIPT_PATH, 'decide'], { input, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { action: 'file', attempts: 0 });
  });

  it('exits non-zero with usage text on an unknown command', () => {
    const result = spawnSync(process.execPath, [SCRIPT_PATH, 'bogus'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown command/);
  });
});
