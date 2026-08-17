#!/usr/bin/env node
// Shared retry/backoff/staleness decision primitive.
//
// Extracted from scripts/e2e-regression-watch.mjs (the default-branch CI
// watcher) so scripts/mergify_admin_requeue_plan.py -- a separate,
// Python-based auto-repair system that watches individual PR checks -- can
// call the same, already-tested decision logic instead of re-deriving it.
// Both systems already spawn shell entrypoints from an in-process Invoker
// worker every tick; Python calling this module's CLI via subprocess is the
// same pattern, one level down.
import { readFileSync } from 'node:fs';

export function shouldRetry({
  attempts = 0,
  lastAttemptAt = null,
  nowMs = Date.now(),
  maxAttempts,
  backoffBaseMs,
} = {}) {
  const attemptCount = Number(attempts ?? 0);
  if (attemptCount >= maxAttempts) {
    return { action: 'needs-human', attempts: attemptCount };
  }
  if (lastAttemptAt) {
    const lastAttemptMs = Date.parse(lastAttemptAt);
    if (Number.isFinite(lastAttemptMs)) {
      const backoffUntilMs = lastAttemptMs + (backoffBaseMs * (2 ** attemptCount));
      if (nowMs < backoffUntilMs) {
        return { action: 'backoff', attempts: attemptCount, backoffUntilMs };
      }
    }
  }
  return { action: 'file', attempts: attemptCount };
}

export function isStale({ lastObservedAt, nowMs = Date.now(), staleMs } = {}) {
  const observedMs = lastObservedAt ? new Date(lastObservedAt).getTime() : NaN;
  return Number.isFinite(observedMs) && (nowMs - observedMs) > staleMs;
}

function readJsonArg(argv) {
  const flagIndex = argv.indexOf('--json');
  if (flagIndex !== -1 && argv[flagIndex + 1]) {
    return argv[flagIndex + 1];
  }
  return readFileSync(0, 'utf8');
}

function usage() {
  return [
    'Usage: node scripts/retry-ledger.mjs decide --json \'<input>\'',
    '  input: {"attempts":2,"lastAttemptAt":"2026-08-14T09:41:32Z","nowMs":1786732000000,"maxAttempts":3,"backoffBaseMs":1800000}',
    '  (or pipe the same JSON object on stdin instead of --json)',
    'Prints one JSON decision to stdout: {"action":"file"|"backoff"|"needs-human", ...}',
  ].join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (command !== 'decide') {
    console.error(`retry-ledger: unknown command "${command ?? ''}"\n\n${usage()}`);
    process.exitCode = 1;
    return;
  }
  let input;
  try {
    input = JSON.parse(readJsonArg(rest));
  } catch (err) {
    console.error(`retry-ledger: invalid JSON input: ${err.message}\n\n${usage()}`);
    process.exitCode = 1;
    return;
  }
  const result = shouldRetry({
    attempts: input.attempts,
    lastAttemptAt: input.lastAttemptAt,
    nowMs: input.nowMs,
    maxAttempts: input.maxAttempts,
    backoffBaseMs: input.backoffBaseMs,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error('retry-ledger: fatal error', err);
    process.exitCode = 1;
  });
}
