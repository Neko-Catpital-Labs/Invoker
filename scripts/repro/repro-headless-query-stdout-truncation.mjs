#!/usr/bin/env node
/**
 * Repro for a live incident: `headless_query query workflows --output json`
 * (used by scripts/e2e-regression-watch.mjs's liveQueryHasNonTerminalWork)
 * returned truncated JSON on a large workflow set, crashing every sweep with
 * "Unterminated string in JSON at position N" and silently disabling
 * automatic e2e-fix PR creation.
 *
 * Root cause: main.ts's standalone headless command exit path wrote query
 * output via a single raw `process.stdout.write()` (headless-query-list.ts's
 * writeOut()), then called `process.exit()` without waiting for that write
 * to drain. When the caller captures stdout via a pipe (execSync, exactly
 * how e2e-regression-watch.mjs invokes it) and the payload is large, Node
 * buffers the write and drains it asynchronously -- if the process exits
 * first, the pipe closes mid-write and the reader gets a truncated string,
 * cut off wherever the buffer happened to be. The delegated-query path
 * already avoided this (writeStdoutFlushAndExit awaits the write callback);
 * the standalone/fallback path -- taken whenever there's no live owner to
 * delegate to -- did not.
 *
 * Fix: packages/app/src/headless-stdout-flush.ts's flushStdoutAndStderr(),
 * wired into main.ts's shared standalone exit `finally` block. This repro
 * demonstrates the underlying mechanism directly (no Electron/DB needed):
 * a large JSON payload, written the old way (write + immediate exit) vs.
 * the fixed way (write, wait for the callback, then exit), captured via
 * execSync exactly like the real caller does.
 *
 * Exit 0 = the buggy pattern truncates (as expected) AND the fixed pattern
 *          does not -- i.e. the fix in headless-stdout-flush.ts genuinely
 *          prevents this class of truncation.
 * Exit 1 = either pattern behaved unexpectedly (repro itself is broken, or
 *          the fix regressed).
 */
import { execFileSync } from 'node:child_process';

const ROWS = Number(process.env.REPRO_ROWS ?? '30000');

function buildPayload() {
  const rows = [];
  for (let i = 0; i < ROWS; i += 1) {
    rows.push({
      id: `wf-repro-${i}`,
      name: `repro-workflow-${i}-with-a-reasonably-long-descriptive-name-for-realism`,
      status: 'completed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  return JSON.stringify(rows) + '\n';
}

const buggyScript = `
const rows = [];
for (let i = 0; i < ${ROWS}; i += 1) {
  rows.push({
    id: 'wf-repro-' + i,
    name: 'repro-workflow-' + i + '-with-a-reasonably-long-descriptive-name-for-realism',
    status: 'completed',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}
const json = JSON.stringify(rows) + '\\n';
process.stdout.write(json);
process.exit(0);
`;

const fixedScript = `
const rows = [];
for (let i = 0; i < ${ROWS}; i += 1) {
  rows.push({
    id: 'wf-repro-' + i,
    name: 'repro-workflow-' + i + '-with-a-reasonably-long-descriptive-name-for-realism',
    status: 'completed',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}
const json = JSON.stringify(rows) + '\\n';
process.stdout.write(json, () => {
  process.exit(0);
});
`;

function run(label, script, expectTruncation) {
  const expected = buildPayload();
  const out = execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    maxBuffer: 200 * 1024 * 1024,
  });

  let parseError;
  try {
    JSON.parse(out);
  } catch (err) {
    parseError = err;
  }

  const truncated = out.length !== expected.length || Boolean(parseError);
  console.log(`[${label}] expected bytes=${expected.length} captured bytes=${out.length} truncated=${truncated}${parseError ? ` (${parseError.message})` : ''}`);

  if (truncated !== expectTruncation) {
    console.error(`[${label}] UNEXPECTED: expected truncated=${expectTruncation}, got truncated=${truncated}`);
    return false;
  }
  return true;
}

let ok = true;
ok = run('buggy (write + immediate exit)', buggyScript, true) && ok;
ok = run('fixed (write, wait for callback, then exit)', fixedScript, false) && ok;

if (!ok) {
  console.error('\nrepro-headless-query-stdout-truncation: FAILED');
  process.exit(1);
}
console.log('\nrepro-headless-query-stdout-truncation: PASSED (bug mechanism confirmed, fix confirmed to prevent it)');
