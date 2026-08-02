import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const LOG_PATH = process.env.INVOKER_LOG
  ?? path.join(homedir(), '.invoker', 'invoker.log');

// The incident window under investigation (2026-08-02 01:00–01:45 UTC).
export const WINDOW_RE = /"time":"2026-08-02T01:[0-4]\d:/;

export function readLogLines() {
  if (!existsSync(LOG_PATH)) {
    console.error(`FATAL: log not found at ${LOG_PATH} (set INVOKER_LOG to override)`);
    process.exit(2);
  }
  return readFileSync(LOG_PATH, 'utf8').split('\n');
}

let failures = 0;
export function assert(label, cond, evidence) {
  const tag = cond ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${label}`);
  if (evidence) {
    for (const line of [].concat(evidence)) console.log(`         ↳ ${line}`);
  }
  if (!cond) failures++;
  return cond;
}

export function done(title) {
  console.log('');
  if (failures === 0) {
    console.log(`\x1b[32m✔ REPRO CONFIRMED: ${title}\x1b[0m`);
    process.exit(0);
  }
  console.log(`\x1b[31m✘ REPRO FAILED (${failures} assertion(s)): ${title}\x1b[0m`);
  process.exit(1);
}
